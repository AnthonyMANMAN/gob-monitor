// ============================================================
//  GoB Monitor — Railway-compatible Puppeteer headless script
//
//  Required env vars (set in Railway dashboard):
//    BOT_TOKEN        Telegram bot token
//    CHAT_ID          Telegram chat/group ID
//    LOGIN_USERNAME   GoB username
//    LOGIN_PASSWORD   GoB password
//
//  Optional env vars:
//    TARGET_SERVERS   Comma-separated list, default: US,EU,RU,BR,AU,JP
//    CYCLE_INTERVAL   Poll interval ms, default: 3000
//    MSG_MAX_AGE_MS   Dedup window ms,  default: 120000
// ============================================================
const puppeteer = require('puppeteer');
const https     = require('https');

// ── CONFIG (from environment) ────────────────────────────────
const BOT_TOKEN      = process.env.BOT_TOKEN;
const CHAT_ID        = process.env.CHAT_ID;
const LOGIN_USERNAME = process.env.LOGIN_USERNAME;
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD;
const TARGET_SERVERS = (process.env.TARGET_SERVERS || 'US,EU,RU,BR,AU,JP').split(',').map(s => s.trim());
const MSG_MAX_AGE_MS = Number(process.env.MSG_MAX_AGE_MS) || 2 * 60 * 1000;
const CYCLE_INTERVAL = Number(process.env.CYCLE_INTERVAL) || 3_000;

// ── Validate required env vars ───────────────────────────────
for (const [key, val] of Object.entries({ BOT_TOKEN, CHAT_ID, LOGIN_USERNAME, LOGIN_PASSWORD })) {
    if (!val) {
        console.error(`[FATAL] Missing required environment variable: ${key}`);
        process.exit(1);
    }
}

// ────────────────────────────────────────────────────────────
const sentMessages = {};
let totalSent = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function sendToTelegram(text) {
    return new Promise(resolve => {
        const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
        const options = {
            hostname: 'api.telegram.org',
            path    : `/bot${BOT_TOKEN}/sendMessage`,
            method  : 'POST',
            headers : {
                'Content-Type'  : 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        };
        const req = https.request(options, res => {
            res.on('data', () => {});
            res.on('end', () => resolve(res.statusCode === 200));
        });
        req.on('error', () => resolve(false));
        req.write(body);
        req.end();
    });
}

function formatMessage(text) {
    if (/плутоний|plutonium/i.test(text)) return '🟢 ' + text;
    if (/паук|spider/i.test(text))        return '🔴 ' + text;
    if (/хомяк|hamster/i.test(text))      return '🔵 ' + text;
    return text;
}

async function getMessages(page) {
    return page.evaluate(() => {
        const now    = new Date();
        const maxAge = 2 * 60 * 1000;
        const chat =
            document.getElementById('listChat') ||
            document.querySelector('.chat-list') ||
            document.querySelector('ul.chat');
        if (!chat) return [];
        const passed = [];
        chat.querySelectorAll('li').forEach(li => {
            const raw = (li.textContent || '').trim().replace(/\s+/g, ' ');
            if (!/SERVER:/i.test(raw) && !/-tg|-тг/i.test(raw)) return;
            if (/ignored|сообщ\. проигнор/i.test(raw)) return;
            const timeEl = li.querySelector('.time');
            if (timeEl) {
                const [hh, mm] = timeEl.textContent.trim().split(':').map(Number);
                if (!isNaN(hh) && !isNaN(mm)) {
                    const t = new Date(now);
                    t.setHours(hh, mm, 0, 0);
                    const age = now - t;
                    if (age < 0 || age > maxAge) return;
                }
            }
            passed.push(raw);
        });
        return passed;
    });
}

async function getCurrentServer(page) {
    return page.evaluate(() => {
        const s1 = document.querySelector('#server-select .server-list li.selected h2');
        if (s1) return s1.textContent.trim().toUpperCase();
        const s2 = document.querySelector('.server-list .selected h2');
        if (s2) return s2.textContent.trim().toUpperCase();
        const s3 = document.querySelector('.butt_left_menu.ng-binding .colorRed');
        if (s3) return s3.textContent.trim().toUpperCase();
        return 'UNKNOWN';
    });
}

async function getAvailableServers(page) {
    return page.evaluate(() => {
        const seen = new Set();
        return [
            ...document.querySelectorAll('#server-select .server-list li:not(.down) h2'),
            ...document.querySelectorAll('.server-list li:not(.down) h2'),
        ].map(el => el.textContent.trim()).filter(n => {
            if (!n || n === 'DEV' || seen.has(n)) return false;
            seen.add(n); return true;
        });
    });
}

async function switchServer(page, name) {
    return page.evaluate(serverName => {
        for (const sel of ['#server-select .server-list li:not(.down)', '.server-list li:not(.down)']) {
            for (const li of document.querySelectorAll(sel)) {
                const h2 = li.querySelector('h2');
                if (h2 && h2.textContent.trim() === serverName) {
                    if (li.classList.contains('selected')) return 'already';
                    li.click(); return 'clicked';
                }
            }
        }
        return 'not-found';
    }, name);
}

async function checkServer(page, serverName) {
    const msgs = await getMessages(page);
    if (!sentMessages[serverName]) sentMessages[serverName] = new Map();
    const store = sentMessages[serverName];
    const now   = Date.now();
    const fresh = [];
    for (const raw of msgs) {
        const text = formatMessage(raw);
        const last = store.get(text);
        if (last && now - last < MSG_MAX_AGE_MS) continue;
        store.set(text, now);
        fresh.push(text);
    }
    if (fresh.length === 0) return;
    const ok = await sendToTelegram(`🎮 ${serverName}\n${fresh.join('\n')}`);
    if (ok) {
        totalSent += fresh.length;
        console.log(`[${serverName}] Sent ${fresh.length} message(s). Total: ${totalSent}`);
    } else {
        console.warn(`[${serverName}] Telegram send failed.`);
    }
}

// ── MAIN ─────────────────────────────────────────────────────
(async () => {
    console.log('[GoB Monitor] Starting up…');
    console.log(`[GoB Monitor] Watching servers: ${TARGET_SERVERS.join(', ')}`);

    // Railway provides Chromium at this path when using the Puppeteer buildpack.
    // Falls back to letting Puppeteer find its own bundled binary.
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

    const browser = await puppeteer.launch({
        headless : true,
        executablePath,
        args     : [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',   // avoids /dev/shm issues in containers
            '--disable-gpu',
        ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // Surface browser console errors to Railway logs
    page.on('pageerror', err => console.error('[PAGE ERROR]', err.message));

    console.log('[GoB Monitor] Navigating to gameofbombs.com…');
    await page.goto('https://gameofbombs.com/', { waitUntil: 'networkidle2', timeout: 30_000 });
    await sleep(2000);

    // ── Login ────────────────────────────────────────────────
    const formVisible = await page.$('form[name="lform"]');
    if (formVisible) {
        console.log('[GoB Monitor] Login form detected — filling credentials…');
        await page.evaluate((u, p) => {
            const setNative = (el, val) => {
                const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
                desc.set.call(el, val);
                el.dispatchEvent(new Event('input',  { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur',   { bubbles: true }));
            };
            const email = document.querySelector('form[name="lform"] input[name="email"]');
            const pwd   = document.querySelector('form[name="lform"] input[name="pwd"]');
            if (email) setNative(email, u);
            if (pwd)   setNative(pwd,   p);
        }, LOGIN_USERNAME, LOGIN_PASSWORD);

        const loginBtn = await page.$('form[name="lform"] button.reg');
        if (loginBtn) await loginBtn.click();
        else await page.keyboard.press('Enter');

        console.log('[GoB Monitor] Submitted login — waiting for lobby…');
        await page.waitForSelector('.butt_left_menu.to-play', { timeout: 15_000 });
        console.log('[GoB Monitor] Logged in.');
    } else {
        console.log('[GoB Monitor] Already logged in (no login form found).');
    }

    await sleep(1000);

    // ── Play → Mixed room ────────────────────────────────────
    console.log('[GoB Monitor] Entering Mixed room…');
    await page.click('.butt_left_menu.to-play');
    await page.waitForSelector('.server-wrap', { timeout: 10_000 });
    await sleep(600);

    await page.evaluate(() => {
        for (const wrap of document.querySelectorAll('.server-wrap')) {
            const h2 = wrap.querySelector('h2');
            if (h2 && h2.textContent.trim().toLowerCase() === 'mixed') { wrap.click(); return; }
        }
        const first = document.querySelector('.server-wrap');
        if (first) first.click();
    });

    await page.waitForSelector('#listChat', { timeout: 15_000 });
    await sleep(1500);

    // ── Uncensored channel ───────────────────────────────────
    await page.evaluate(() => {
        for (const btn of document.querySelectorAll('button[ng-click]')) {
            if (btn.getAttribute('ng-click') === 'selectChannel(2)' ||
                btn.textContent.trim().startsWith('Uncensored')) {
                btn.click(); return;
            }
        }
    });
    await sleep(1500);

    // ── Initial check ────────────────────────────────────────
    const initServer = await getCurrentServer(page);
    console.log(`[GoB Monitor] Initial server: ${initServer}`);
    await checkServer(page, initServer);

    // ── Server cycle ─────────────────────────────────────────
    console.log(`[GoB Monitor] Starting poll loop every ${CYCLE_INTERVAL}ms…`);
    let idx = 0;
    setInterval(async () => {
        try {
            const available = await getAvailableServers(page);
            const targets   = TARGET_SERVERS.filter(s => available.includes(s));
            if (targets.length === 0) return;
            const target = targets[idx % targets.length];
            idx++;
            const sw = await switchServer(page, target);
            if (sw === 'not-found') return;
            await sleep(1500);
            const current = await getCurrentServer(page);
            await checkServer(page, current);
        } catch (err) {
            console.error('[CYCLE ERROR]', err.message);
        }
    }, CYCLE_INTERVAL);

    // ── Graceful shutdown ─────────────────────────────────────
    const shutdown = async () => {
        console.log('[GoB Monitor] Shutting down…');
        await browser.close();
        process.exit(0);
    };
    process.on('SIGINT',  shutdown);
    process.on('SIGTERM', shutdown);  // Railway sends SIGTERM on deploy/stop
})();
