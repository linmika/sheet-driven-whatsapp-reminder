'use strict';
// Pickup-reminder WhatsApp relay.
// Links your own WhatsApp as a "linked device" and polls the Apps Script web app
// for due reminders. It only makes OUTBOUND requests - nothing on this computer is
// reachable from the internet. A status/QR page is served on 127.0.0.1 only.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const googleAuth = require('./google-auth');

const DIR = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const ALLOW = new Set((cfg.allowlist || []).map((n) => String(n).replace(/\D/g, '')));
const POLL_MS = Math.max(30, cfg.pollSeconds || 60) * 1000;
const SENT_FILE = path.join(DIR, 'sent-keys.json');
const IS_WIN = process.platform === 'win32';

const log = (...a) => console.log(new Date().toLocaleTimeString('en-GB', { hour12: false }), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stats = { lastPoll: null, lastError: null, sent: 0, mode: '?' };

// ---- Duplicate protection: never send the same job key twice ----
let sentKeys = [];
try { sentKeys = JSON.parse(fs.readFileSync(SENT_FILE, 'utf8')); } catch (_) {}
const sentSet = new Set(sentKeys);
function rememberKey(key) {
  if (!key || sentSet.has(key)) return;
  sentSet.add(key);
  sentKeys.push(key);
  if (sentKeys.length > 5000) sentSet.delete(sentKeys.shift());
  fs.writeFileSync(SENT_FILE, JSON.stringify(sentKeys));
}

// ---- WhatsApp client ----
let waReady = false;
let latestQrPng = null;
let qrPageOpened = false;
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(DIR, 'session') }),
  deviceName: 'Pickup Reminder Relay',
  puppeteer: {
    headless: true,
    executablePath: cfg.browserPath || undefined,
    args: process.platform === 'linux' ? ['--no-sandbox'] : [],
  },
});

function openInBrowser(target) {
  try {
    if (IS_WIN) spawn('cmd', ['/c', 'start', '""', target], { detached: true, stdio: 'ignore' });
    else if (process.platform === 'darwin') spawn('open', [target], { detached: true, stdio: 'ignore' });
  } catch (_) {}
}

client.on('qr', async (qr) => {
  latestQrPng = await QRCode.toBuffer(qr, { width: 420, margin: 2 });
  fs.writeFileSync(path.join(DIR, 'qr.png'), latestQrPng);
  log('>>> Scan the QR: phone WhatsApp > Settings > Linked devices > Link a device');
  log('    Live QR page: http://127.0.0.1:' + cfg.port + '/  (also saved as qr.png)');
  if (!qrPageOpened && !process.argv.includes('--no-open')) { qrPageOpened = true; openInBrowser('http://127.0.0.1:' + cfg.port + '/'); }
});
client.on('authenticated', () => log('WhatsApp authenticated'));
client.on('auth_failure', (m) => log('!!! WhatsApp auth failure:', m));
client.on('ready', () => {
  waReady = true;
  latestQrPng = null;
  try { fs.unlinkSync(path.join(DIR, 'qr.png')); } catch (_) {}
  log('WhatsApp READY - linked as +' + linkedNumber());
  if (!senderOk()) log('!!! WARNING: expected sender +' + cfg.sender + ' but linked +' + linkedNumber() + '. Sending is BLOCKED.');
  schedulePoll(0);
});
client.on('disconnected', async (reason) => {
  waReady = false;
  log('!!! WhatsApp disconnected:', reason, '- reconnecting in 10s');
  await sleep(10000);
  try { await client.destroy(); } catch (_) {}
  client.initialize().catch((e) => log('reinitialize failed:', e.message));
});

const linkedNumber = () => (client.info && client.info.wid ? client.info.wid.user : null);
const senderOk = () => !cfg.sender || linkedNumber() === cfg.sender;

// ---- Serialized sending with a minimum gap between messages ----
let chain = Promise.resolve();
let lastSend = 0;
function enqueue(fn) {
  const p = chain.then(async () => {
    const wait = lastSend + (cfg.sendGapMs || 3000) - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await fn(); } finally { lastSend = Date.now(); }
  });
  chain = p.catch(() => {});
  return p;
}

async function sendJob(job) {
  const base = { row: job.row, key: job.key };
  const digits = String(job.to || '').replace(/\D/g, '');
  if (!ALLOW.has(digits)) return { ...base, ok: false, permanent: true, error: '+' + digits + ' is not in the relay allowlist' };
  if (sentSet.has(job.key)) return { ...base, ok: true, duplicate: true };
  if (!waReady || !senderOk()) return { ...base, ok: false, error: 'whatsapp not ready' };
  try {
    return await enqueue(async () => {
      const id = await client.getNumberId(digits);
      if (!id) return { ...base, ok: false, permanent: true, error: '+' + digits + ' is not on WhatsApp' };
      await client.sendMessage(id._serialized, job.message);
      rememberKey(job.key);
      stats.sent++;
      log('SENT row ' + job.row + ' -> +' + digits);
      return { ...base, ok: true };
    });
  } catch (e) {
    log('!!! send failed for row ' + job.row + ':', e.message);
    return { ...base, ok: false, error: 'send failed: ' + e.message };
  }
}

// ---- Talking to the Apps Script web app (outbound HTTPS only) ----
async function callApps(body) {
  // The web app is restricted to your Workspace domain, so every call is signed in as you.
  const accessToken = await googleAuth.getAccessToken();
  const res = await fetch(cfg.appsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
    body: JSON.stringify({ token: cfg.token, ...body }),
    redirect: 'follow',
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch (_) {
    const hint = res.status === 404 ? ' (web app not found: check the /exec URL and that the deployment still exists)'
      : /accounts\.google\.com|ServiceLogin/i.test(text) ? ' (Google refused the sign-in: check you ran login with ' + (cfg.googleAccount || 'your Workspace account') + ')'
      : /<html/i.test(text) ? ' (got a web page, not JSON)' : '';
    throw new Error('HTTP ' + res.status + hint + ': ' + text.slice(0, 120).replace(/\s+/g, ' '));
  }
}

let pendingReports = [];
let polling = false;
let pollTimer = null;
let lastNote = null;

async function flushReports() {
  if (!pendingReports.length) return;
  const r = await callApps({ action: 'report', results: pendingReports });
  if (!r.ok) throw new Error('report refused: ' + r.error);
  log('reported ' + pendingReports.length + ' result(s): ' + r.written + ' written, ' + r.ignored + ' ignored');
  pendingReports = [];
}

async function pollOnce() {
  if (polling || !waReady || !senderOk()) return;
  polling = true;
  try {
    await flushReports(); // deliver anything a previous poll couldn't
    const claim = await callApps({ action: 'claim' });
    stats.lastPoll = new Date();
    if (!claim.ok) throw new Error('claim refused: ' + claim.error);
    const note = claim.note || null;
    if (note !== lastNote) { log(note ? 'Apps Script says: ' + note + ' (nothing will be sent)' : 'Apps Script: live, handing out work'); lastNote = note; }
    stats.mode = note || 'live';
    for (const job of claim.jobs || []) pendingReports.push(await sendJob(job));
    await flushReports();
    stats.lastError = null;
  } catch (e) {
    stats.lastError = e.message;
    log('!!! poll failed:', e.message, '- will retry');
  } finally {
    polling = false;
  }
}

function schedulePoll(delay) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => { await pollOnce(); schedulePoll(POLL_MS); }, delay);
}

// ---- Local-only status / QR page ----
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function statusPage() {
  const body = waReady
    ? `<p class="ok">WhatsApp linked as +${esc(linkedNumber())}</p>
       <table><tr><td>Apps Script</td><td>${esc(stats.mode)}</td></tr>
       <tr><td>Last poll</td><td>${stats.lastPoll ? esc(stats.lastPoll.toLocaleTimeString('en-GB', { hour12: false })) : '-'}</td></tr>
       <tr><td>Sent since start</td><td>${stats.sent}</td></tr>
       <tr><td>Last error</td><td>${stats.lastError ? esc(stats.lastError) : 'none'}</td></tr></table>
       <p class="s">Keep the relay window open. This page refreshes every 15s.</p>`
    : latestQrPng
      ? `<h2>Scan with your phone</h2><img id="q" src="/qr.png?t=0" alt="QR code">
         <p class="s">WhatsApp &gt; Settings &gt; Linked devices &gt; Link a device<br>The code refreshes automatically.</p>
         <script>setInterval(()=>{document.getElementById('q').src='/qr.png?t='+Date.now()},3000)</script>`
      : `<h2>Starting WhatsApp...</h2><p class="s">This takes about 30 seconds.</p>`;
  return `<!doctype html><meta charset="utf-8"><title>WhatsApp Relay</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f3ee;color:#222}
main{text-align:center;padding:24px;max-width:460px}img{width:320px;height:320px;background:#fff;border-radius:12px;padding:8px}
.ok{font-size:22px;color:#1f7a4d;font-weight:600}.s{color:#666;font-size:14px;margin-top:16px}
table{margin:12px auto;border-collapse:collapse;text-align:left;font-size:14px}td{padding:4px 10px;border-bottom:1px solid #e3dccf}</style>
<main>${body}</main><script>setTimeout(()=>location.reload(),15000)</script>`;
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && url === '/qr.png' && latestQrPng) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    return res.end(latestQrPng);
  }
  if (req.method === 'GET' && (url === '/' || url === '/qr')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(statusPage());
  }
  res.writeHead(404); res.end();
});

// ---- Keep the machine awake while the relay runs ----
let keepAwake = null;
function startKeepAwake() {
  try {
    if (IS_WIN) {
      const ps = "Add-Type -Namespace W -Name P -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);';" +
        ' while($true){ [W.P]::SetThreadExecutionState(0x80000001) | Out-Null; Start-Sleep 30 }';
      keepAwake = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      keepAwake = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    }
    if (keepAwake) keepAwake.on('error', () => log('(could not start keep-awake; set sleep to Never manually)'));
  } catch (_) {}
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down...');
  clearTimeout(pollTimer);
  try { keepAwake && keepAwake.kill(); } catch (_) {}
  client.destroy().catch(() => {}).finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

(async () => {
  if (!cfg.token || cfg.token.length < 32) throw new Error('config.json has no token - run setup first');
  if (!/^https:\/\/script\.google\.com\/(a\/macros\/[\w.-]+|macros)\/s\/[\w-]+\/exec$/.test(cfg.appsUrl || '')) {
    throw new Error('config.json "appsUrl" must be the Apps Script web app URL ending in /exec - run setup --url <URL>');
  }
  if (!ALLOW.size) log('!!! allowlist is EMPTY - every send will be refused (rerun setup with --allow)');
  const who = googleAuth.signedInAs();
  if (!who) throw new Error('not signed in to Google - run login first (login.bat on Windows)');
  log('Google account: ' + who);
  await new Promise((r) => server.listen(cfg.port, '127.0.0.1', r));
  log('status page: http://127.0.0.1:' + cfg.port + '/ | allowlist: ' + [...ALLOW].map((n) => '+' + n).join(', '));
  try {
    const p = await callApps({ action: 'ping' });
    if (!p.ok) log('!!! Apps Script rejected the token:', p.error, '- check that the token matches RELAY_TOKEN');
    else log('Apps Script reachable | relay mode: ' + (p.relayMode ? 'ON' : 'OFF') + ' | DRY_RUN: ' + (p.dryRun ? 'ON' : 'OFF'));
  } catch (e) {
    log('!!! cannot reach Apps Script yet:', e.message);
  }
  startKeepAwake();
  log('starting WhatsApp (first start takes ~30s)...');
  await client.initialize();
})().catch((e) => { log('FATAL:', e.message); process.exit(1); });
