'use strict';
// One-time setup: writes config.json (keeps an existing token), finds an installed
// Chrome/Edge so no browser download is needed, then installs dependencies.
//   node setup.js --url https://script.google.com/macros/s/.../exec \
//                 --allow +6590000001,+6580000002 --sender 6580000002
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const CONFIG = path.join(DIR, 'config.json');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function findBrowser() {
  const env = process.env;
  const candidates = {
    win32: [
      path.join(env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
      path.join(env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
      path.join(env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
      path.join(env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
      path.join(env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  }[process.platform] || [];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

const cfg = fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : {};
cfg.port = cfg.port || 3977;
cfg.pollSeconds = cfg.pollSeconds || 60;
cfg.appsUrl = cfg.appsUrl || '';
cfg.googleAccount = cfg.googleAccount || '';
cfg.token = cfg.token || crypto.randomBytes(32).toString('hex');
cfg.sendGapMs = cfg.sendGapMs || 3000;
cfg.allowlist = cfg.allowlist || [];
cfg.sender = cfg.sender || '';

const allow = arg('--allow');
if (allow) cfg.allowlist = allow.split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean);
const google = arg('--google');
if (google) cfg.googleAccount = google.trim();
const url = arg('--url');
if (url) cfg.appsUrl = url.trim();
const sender = arg('--sender');
if (sender) cfg.sender = sender.replace(/\D/g, '');

cfg.browserPath = findBrowser();
fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });

console.log('config.json written');
console.log('  browser   :', cfg.browserPath || '(none found - will download Chromium, ~170MB)');
console.log('  allowlist :', cfg.allowlist.length ? cfg.allowlist.join(', ') : '(EMPTY - nothing can be sent)');
console.log('  sender    :', cfg.sender || '(not pinned)');
console.log('  appsUrl   :', cfg.appsUrl || '(NOT SET - rerun with --url <web app URL>)');
console.log('\nInstalling dependencies...');

const env = { ...process.env };
if (cfg.browserPath) env.PUPPETEER_SKIP_DOWNLOAD = 'true';
const r = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
  cwd: DIR, env, stdio: 'inherit', shell: process.platform === 'win32',
});
if (r.status !== 0) {
  console.error('\nnpm install failed. If you are behind a company proxy, see README.');
  process.exit(1);
}
console.log('\nSetup complete. Next: sign in to Google (login.bat), then start the relay (start.bat).');
