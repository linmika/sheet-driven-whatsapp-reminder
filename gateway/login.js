'use strict';
// One-time Google sign-in for the relay. Re-run it if the relay says the sign-in expired.
const fs = require('fs');
const path = require('path');
const { login } = require('./google-auth');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

login({ expectEmail: cfg.googleAccount })
  .then(({ email, scope }) => {
    console.log('\nSigned in as ' + email);
    console.log('Granted: ' + scope);
    console.log('Saved to google-token.json. Next: run start (start.bat on Windows).');
    process.exit(0);
  })
  .catch((e) => { console.error('\nLogin failed: ' + e.message); process.exit(1); });
