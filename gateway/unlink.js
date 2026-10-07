'use strict';
// Logs this computer out of WhatsApp (removes it from "Linked devices" on the phone)
// and deletes the local session. Run this before retiring a machine.
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const sessionDir = path.join(__dirname, 'session');

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: sessionDir }),
  puppeteer: { headless: true, executablePath: cfg.browserPath || undefined },
});
client.on('qr', async () => {
  console.log('Not linked - nothing to log out. Removing local session folder.');
  await client.destroy().catch(() => {});
  fs.rmSync(sessionDir, { recursive: true, force: true });
  process.exit(0);
});
client.on('ready', async () => {
  console.log('Linked as +' + client.info.wid.user + ' - logging out...');
  await client.logout().catch((e) => console.log('logout error:', e.message));
  await client.destroy().catch(() => {});
  fs.rmSync(sessionDir, { recursive: true, force: true });
  console.log('Done. This computer is no longer a linked device.');
  process.exit(0);
});
client.initialize();
