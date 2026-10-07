'use strict';
// One-time: lets you pick the Apps Script project in Google's file picker, which gives
// the relay's drive.file sign-in access to THAT ONE FILE (needed to call the web app).
// The rest of your Drive stays invisible to the relay. Needs picker-key.txt (an API key
// restricted to the Google Picker API).
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { getAccessToken } = require('./google-auth');

const DIR = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const SCRIPT_FILE_ID = cfg.scriptFileId; // the Apps Script project's Drive file id
if (!SCRIPT_FILE_ID) { console.error('Set scriptFileId in config.json first.'); process.exit(1); }
const client = JSON.parse(fs.readFileSync(path.join(DIR, 'oauth-client.json'), 'utf8')).installed;
const APP_ID = client.client_id.split('-')[0]; // Cloud project number: required for drive.file grants
const KEY_FILE = path.join(DIR, 'picker-key.txt');

async function driveCanSee(token) {
  const r = await fetch('https://www.googleapis.com/drive/v3/files/' + SCRIPT_FILE_ID + '?fields=id,name',
    { headers: { Authorization: 'Bearer ' + token } });
  return r.ok ? (await r.json()).name : null;
}

async function pingWebApp(token) {
  const r = await fetch(cfg.appsUrl, { method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ token: cfg.token, action: 'ping' }) });
  const t = await r.text();
  try { return JSON.parse(t); } catch (_) { return { ok: false, error: 'HTTP ' + r.status + ' (not JSON)' }; }
}

const page = (token, key) => `<!doctype html><meta charset="utf-8"><title>WhatsApp Relay - pick the script</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f3ee;color:#222}
main{text-align:center;max-width:520px;padding:24px}button{font-size:16px;padding:10px 18px;border-radius:8px;border:1px solid #bbb;background:#fff;cursor:pointer}
#s{margin-top:16px;color:#555}</style>
<main><h2>Give the relay access to one file</h2>
<p>In the Google window, select the Apps Script project <b>(Untitled project)</b> and press <b>Select</b>.<br>This only grants access to that single file.</p>
<button id="b">Open Google file picker</button><p id="s"></p></main>
<script>
const TOKEN=${JSON.stringify(token)}, KEY=${JSON.stringify(key)}, APP_ID=${JSON.stringify(APP_ID)}, FILE_ID=${JSON.stringify(SCRIPT_FILE_ID)};
const s=document.getElementById('s');
function openPicker(){
  const view=new google.picker.DocsView(google.picker.ViewId.DOCS).setMimeTypes('application/vnd.google-apps.script').setMode(google.picker.DocsViewMode.LIST);
  if (view.setFileIds) view.setFileIds(FILE_ID);
  new google.picker.PickerBuilder().setAppId(APP_ID).setOAuthToken(TOKEN).setDeveloperKey(KEY)
    .addView(view).setTitle('Select the pickup reminder Apps Script project')
    .setCallback(async (d)=>{
      if (d.action!==google.picker.Action.PICKED) return;
      s.textContent='Checking...';
      const r=await fetch('/picked',{method:'POST',body:JSON.stringify(d.docs.map(x=>x.id))});
      s.textContent=await r.text();
    }).build().setVisible(true);
}
document.getElementById('b').onclick=openPicker;
</script>
<script src="https://apis.google.com/js/api.js" onload="gapi.load('picker',()=>{s.textContent='Ready.';openPicker()})"></script>`;

(async () => {
  if (!fs.existsSync(KEY_FILE)) throw new Error('picker-key.txt not found - create the Picker API key first');
  const key = fs.readFileSync(KEY_FILE, 'utf8').trim();
  const token = await getAccessToken();

  const already = await driveCanSee(token);
  if (already) console.log('Relay can already see "' + already + '" - no picking needed.');

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(page(token, key));
    }
    if (req.method === 'POST' && req.url === '/picked') {
      let body = ''; req.on('data', (c) => (body += c));
      req.on('end', async () => {
        const ids = JSON.parse(body || '[]');
        const name = await driveCanSee(token);
        const ping = await pingWebApp(token); // ping is the real test; Drive API may be disabled
        const ok = ping && ping.ok;
        const msg = !ids.includes(SCRIPT_FILE_ID) ? 'You picked a different file. Please pick the Apps Script project (Untitled project).'
          : !ok && !name ? 'Picked, but the relay still cannot reach the web app. Tell Claude.'
          : ok ? 'Done! The relay can reach the web app. You can close this tab.'
          : 'Access granted, but the web app said: ' + JSON.stringify(ping);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(msg);
        console.log('picked:', ids.includes(SCRIPT_FILE_ID) ? 'the script project' : JSON.stringify(ids));
        console.log('drive.file can see script file:', Boolean(name), name ? '(' + name + ')' : '');
        console.log('web app ping:', JSON.stringify(ping));
        if (ids.includes(SCRIPT_FILE_ID)) { server.close(); setTimeout(() => process.exit(ok ? 0 : 2), 300); }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(0, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + server.address().port + '/';
    console.log('Opening the file picker page: ' + url);
    if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' });
    else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' });
  });
  setTimeout(() => { console.log('timed out after 10 minutes'); process.exit(3); }, 600000).unref();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
