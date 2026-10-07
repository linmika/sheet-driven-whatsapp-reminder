// End-to-end test: the REAL gateway.js talks to the REAL Code.gs (in a VM sandbox),
// with only WhatsApp and Google sign-in faked. Run: npm test (after npm install in gateway/).
//
// gateway.js resolves config/session/sent-keys from its own directory, so we copy it
// into a scratch dir UNDER gateway/ (so its node_modules still resolve), drop a test
// config beside it, and preload harness.js to fake the network edges.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const tmp = path.join(root, 'gateway', '.e2e-tmp');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
fs.copyFileSync(path.join(root, 'gateway', 'gateway.js'), path.join(tmp, 'gateway.js'));
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  port: 39777, pollSeconds: 60, sendGapMs: 10,
  token: 'T'.repeat(64),
  appsUrl: 'https://script.google.com/macros/s/TEST_DEPLOYMENT_ID/exec',
  allowlist: ['6590000001', '6590000009'],
  sender: '6580000002',
  googleAccount: 'relay-user@example.com',
  browserPath: null,
}, null, 2));

const r = spawnSync(process.execPath,
  ['--require', path.join(__dirname, 'harness.js'), 'gateway.js', '--no-open'],
  { cwd: tmp, stdio: 'inherit', env: { ...process.env, E2E_GATEWAY_DIR: tmp } });
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(r.status === null ? 1 : r.status);
