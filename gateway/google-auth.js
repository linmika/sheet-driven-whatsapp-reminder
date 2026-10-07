'use strict';
// Google sign-in for the relay, so it can call the company-restricted Apps Script web app.
// Scope is drive.file ("only files this app created") + basic identity: the stored
// credential cannot read your Google Drive. Tokens stay in google-token.json.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DIR = __dirname;
const CLIENT_FILE = path.join(DIR, 'oauth-client.json');
const TOKEN_FILE = path.join(DIR, 'google-token.json');
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'];
const IS_WIN = process.platform === 'win32';

function loadClient() {
  if (!fs.existsSync(CLIENT_FILE)) {
    throw new Error('oauth-client.json not found - download the Desktop OAuth client JSON into this folder');
  }
  const j = JSON.parse(fs.readFileSync(CLIENT_FILE, 'utf8'));
  const c = j.installed || j.web || j;
  if (!c.client_id || !c.client_secret) throw new Error('oauth-client.json is not a Desktop OAuth client file');
  return c;
}

function writePrivate(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

function emailFromIdToken(idToken) {
  try { return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8')).email || null; } catch (_) { return null; }
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = new Error('Google token endpoint: ' + (data.error || res.status) + (data.error_description ? ' - ' + data.error_description : ''));
    e.code = data.error;
    throw e;
  }
  return data;
}

function openBrowser(url) {
  try {
    if (IS_WIN) spawn('cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')], { detached: true, stdio: 'ignore' });
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' });
  } catch (_) {}
}

// Interactive one-time login: loopback redirect + PKCE (Google's desktop-app flow).
async function login({ expectEmail } = {}) {
  const client = loadClient();
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');

  const { code, redirectUri } = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/') { res.writeHead(404); return res.end(); }
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ok ? '<h2>Signed in. You can close this tab and go back to the relay window.</h2>'
        : '<h2>Sign-in failed: ' + String(u.searchParams.get('error') || 'state mismatch').replace(/[<>&]/g, '') + '</h2>');
      server.close();
      ok ? resolve({ code: u.searchParams.get('code'), redirectUri }) : reject(new Error('sign-in failed: ' + (u.searchParams.get('error') || 'state mismatch')));
    });
    let redirectUri;
    server.listen(0, '127.0.0.1', () => {
      redirectUri = 'http://127.0.0.1:' + server.address().port + '/';
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search = new URLSearchParams({
        client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code',
        scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state,
        code_challenge: challenge, code_challenge_method: 'S256',
        ...(expectEmail ? { login_hint: expectEmail } : {}),
      }).toString();
      console.log('Opening Google sign-in in your browser. If nothing opens, paste this URL into a browser:\n\n' + auth + '\n');
      openBrowser(auth.toString());
    });
    setTimeout(() => { server.close(); reject(new Error('timed out waiting for sign-in (5 min)')); }, 300000).unref();
  });

  const tok = await tokenRequest({
    client_id: client.client_id, client_secret: client.client_secret, code,
    code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri,
  });
  if (!tok.refresh_token) throw new Error('Google did not return a refresh token - remove the app at myaccount.google.com/permissions and sign in again');
  const email = emailFromIdToken(tok.id_token);
  if (expectEmail && email && email.toLowerCase() !== expectEmail.toLowerCase()) {
    throw new Error('signed in as ' + email + ' but this relay expects ' + expectEmail + ' - nothing was saved');
  }
  writePrivate(TOKEN_FILE, { refresh_token: tok.refresh_token, scope: tok.scope, email, obtained_at: new Date().toISOString() });
  return { email, scope: tok.scope };
}

let cached = null;
async function getAccessToken() {
  if (cached && Date.now() < cached.expiresAt - 60000) return cached.token;
  if (!fs.existsSync(TOKEN_FILE)) throw new Error('not signed in to Google - run login first (login.bat on Windows)');
  const stored = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  const client = loadClient();
  try {
    const tok = await tokenRequest({
      client_id: client.client_id, client_secret: client.client_secret,
      refresh_token: stored.refresh_token, grant_type: 'refresh_token',
    });
    cached = { token: tok.access_token, expiresAt: Date.now() + (tok.expires_in || 3600) * 1000 };
    return cached.token;
  } catch (e) {
    if (e.code === 'invalid_grant') throw new Error('Google sign-in expired or was revoked - run login again (login.bat on Windows)');
    throw e;
  }
}

function signedInAs() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).email || null; } catch (_) { return null; }
}

module.exports = { login, getAccessToken, signedInAs, TOKEN_FILE };
