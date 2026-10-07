// Preloaded before gateway.js: fakes WhatsApp, routes fetch() into the real Code.gs doPost.
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const Module = require('module'); const EventEmitter = require('events');

// ---- sheet + Apps Script (real Code.gs in a sandbox) ----
const now = Date.now(), MIN = 60000;
const d = (offsetMin) => new Date(now + offsetMin * MIN);
const HEADER = ['','','Buyer Phone Number','Buyer Name','Seller Name','Scheduled Pick up time (D0)','One Day Before Scheduled Pick up Time','Out for Delivery Message Sent'];
const SHEET = [[],[],[],[], HEADER,
  ['','','+65 90000001','Send Me','Acme Store',       d(1440-5), d(-5), ''],  // r6 -> real send
  ['','','+65 90000009','Ghost','Acme Store',         d(1440-4), d(-4), ''],  // r7 -> not on WhatsApp
  ['','','+65 80000004','Not Allowed','Acme Store',   d(1440-3), d(-3), ''],  // r8 -> relay allowlist blocks
  ['','','+65 90000001','Already Sent','Acme Store',  d(1440-2), d(-2), ''],  // r9 -> key pre-seeded -> dedupe
  ['','','+65 90000001','Later','Acme Store',         d(1440+60), d(60), ''], // r10 -> not due
];
global.__SHEET = SHEET;
const GW = process.env.E2E_GATEWAY_DIR || __dirname;
fs.writeFileSync(path.join(GW, 'sent-keys.json'), JSON.stringify(['r9-' + SHEET[8][6].getTime()]));

const PROPS = { RELAY_TOKEN: 'T'.repeat(64), WA_PROVIDER: 'relay', DRY_RUN: 'false',
  TEST_WHITELIST: '+6590000001,+6590000009,+6580000004' };
const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const ctx = vm.createContext({
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => PROPS[k] ?? null, setProperty: (k, v) => { PROPS[k] = v; } }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ t, setMimeType() { return this; } }) },
  Logger: { log: () => {} },
  SpreadsheetApp: { getActiveSpreadsheet: () => null, openById: () => ({ getSheets: () => [{
    getDataRange: () => ({ getValues: () => SHEET.map((r) => r.slice()) }),
    getRange: (r, c) => ({ setValue: (v) => { SHEET[r - 1][c - 1] = v; } }) }] }) },
  Utilities: { formatDate: (dt, tz, fmt) => {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year:'numeric', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }).formatToParts(dt).reduce((a, x) => (a[x.type] = x.value, a), {});
    const pad = (x) => String(x).padStart(2, '0');
    if (fmt === 'HH:mm:ss') return `${p.hour}:${p.minute}:${p.second}`;
    if (fmt === 'd MMM yyyy, h:mm a') { const h = +p.hour; return `${+p.day} ${M[+p.month-1]} ${p.year}, ${h % 12 || 12}:${p.minute} ${h < 12 ? 'AM' : 'PM'}`; }
    return `${p.year}-${pad(p.month)}-${pad(p.day)} ${p.hour}:${p.minute}`; } },
  UrlFetchApp: { fetch() { throw new Error('no UrlFetchApp in relay mode'); } },
});
vm.runInContext(fs.readFileSync(require('path').join(__dirname, '..', 'Code.gs'), 'utf8'), ctx);

global.__calls = [];
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  global.__calls.push(body.action);
  global.__auth = (global.__auth || []).concat(opts.headers.Authorization);
  const out = ctx.doPost({ postData: { contents: opts.body } }).t;
  return { status: 200, text: async () => out };
};

// ---- fake whatsapp-web.js ----
global.__sent = [];
class Client extends EventEmitter {
  initialize() { setTimeout(() => { this.info = { wid: { user: '6580000002' } }; this.emit('ready'); }, 50); return Promise.resolve(); }
  async getNumberId(digits) { return digits === '6590000009' ? null : { _serialized: digits + '@c.us' }; }
  async sendMessage(id, msg) { global.__sent.push({ id, msg }); return { id: { _serialized: 'fake' } }; }
  async destroy() {}
}
class LocalAuth { constructor(o) { this.o = o; } }
const realLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'whatsapp-web.js') return { Client, LocalAuth };
  if (req === './google-auth') return { getAccessToken: async () => 'FAKE-ACCESS-TOKEN', signedInAs: () => 'relay-user@example.com' };
  return realLoad.call(this, req, ...rest);
};

// ---- assertions once the first poll has settled ----
const status = (r) => String(SHEET[r - 1][7]);
const t0 = Date.now();
const iv = setInterval(() => {
  const settled = [6, 7, 8, 9].every((r) => status(r) && !status(r).startsWith('Claimed'));
  if (!settled && Date.now() - t0 < 15000) return;
  clearInterval(iv);
  let pass = 0, fail = 0;
  const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };
  console.log('\n--- after first poll ---');
  for (const r of [6, 7, 8, 9, 10]) console.log(`  row ${r}: ${JSON.stringify(status(r))}`);
  console.log('  actions called:', JSON.stringify(global.__calls));
  check('row 6 sent via relay', /^Sent \d{4}-\d\d-\d\d \d\d:\d\d via relay$/.test(status(6)));
  check('exactly one real WhatsApp send', global.__sent.length === 1, JSON.stringify(global.__sent.map((s) => s.id)));
  check('it went to +6590000001 with personalised text', global.__sent[0] && global.__sent[0].id === '6590000001@c.us' && global.__sent[0].msg.startsWith('Hi Send Me, our courier will be picking up your Acme Store parcel on'));
  check('row 7 not on WhatsApp -> permanent Error', status(7) === 'Error: +6590000009 is not on WhatsApp');
  check('row 8 blocked by relay allowlist -> Error', status(8) === 'Error: +6580000004 is not in the relay allowlist');
  check('row 9 duplicate key -> marked Sent, NOT re-sent', /via relay$/.test(status(9)) && !global.__sent.some((s) => s.msg.startsWith('Hi Already Sent')));
  check('row 10 (not due) untouched', status(10) === '');
  check('protocol: ping, claim, report', JSON.stringify(global.__calls) === '["ping","claim","report"]');
  check('every call carried the Google bearer token', global.__auth.length === 3 && global.__auth.every((a) => a === 'Bearer FAKE-ACCESS-TOKEN'));
  const keys = JSON.parse(fs.readFileSync(path.join(GW, 'sent-keys.json'), 'utf8'));
  check('row 6 key persisted for future dedupe', keys.includes('r6-' + SHEET[5][6].getTime()));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 100);
