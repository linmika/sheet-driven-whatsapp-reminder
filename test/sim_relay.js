const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'Code.gs'), 'utf8');

// ---- controllable clock ----
const RealDate = Date;
let NOW = new RealDate('2026-09-23T18:00:00+08:00').getTime();
class FakeDate extends RealDate {
  constructor(...a) { a.length ? super(...a) : super(NOW); }
  static now() { return NOW; }
}
const at = (iso) => new RealDate(iso);
const advance = (min) => { NOW += min * 60000; };

// ---- sheet: header row 5 (index 4), cols C..H (index 2..7) ----
const HEADER = ['','','Buyer Phone Number','Buyer Name','Seller Name','Scheduled Pick up time (D0)','One Day Before Scheduled Pick up Time','Out for Delivery Message Sent'];
const G = 6, H = 7;
const SHEET = [[],[],[],[], HEADER,
  ['','','+65 90000001','Old Test','Acme Store', at('2026-09-23T10:00:00+08:00'), at('2026-09-22T09:50:00+08:00'), 'DRY-RUN sent 2026-09-22 09:57'], // r6 done
  ['','','+65 90000001','Due A','Acme Store',   at('2026-09-24T17:55:00+08:00'), at('2026-09-23T17:55:00+08:00'), ''],   // r7 due
  ['','','80000002','Due B','Acme Store',       at('2026-09-24T17:58:00+08:00'), at('2026-09-23T17:58:00+08:00'), ''],   // r8 due (local fmt)
  ['','','+65 90000003','Not Listed','Acme Store', at('2026-09-24T17:50:00+08:00'), at('2026-09-23T17:50:00+08:00'), ''], // r9 not whitelisted
  ['','','+65 90000001','Future','Acme Store',  at('2026-09-24T19:00:00+08:00'), at('2026-09-23T19:00:00+08:00'), ''],   // r10 not due
  ['','','+65 90000001','Stale','Acme Store',   at('2026-09-19T10:00:00+08:00'), at('2026-09-18T10:00:00+08:00'), ''],   // r11 >72h
  ['','','abc','Bad Phone','Acme Store',        at('2026-09-24T17:40:00+08:00'), at('2026-09-23T17:40:00+08:00'), ''],   // r12 invalid
];
const clone = () => SHEET.map((row) => row.slice());

const PROPS = {};
global.PropertiesService = { getScriptProperties: () => ({
  getProperty: (k) => (k in PROPS ? PROPS[k] : null), setProperty: (k, v) => { PROPS[k] = v; } }) };
global.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
global.ContentService = { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ t, setMimeType() { return this; } }) };
global.Logger = { log: (m) => console.log('    [log]', m) };
global.SpreadsheetApp = { getActiveSpreadsheet: () => null, openById: () => ({ getSheets: () => [{
  getDataRange: () => ({ getValues: clone }),
  getRange: (r, c) => ({ setValue: (v) => { SHEET[r - 1][c - 1] = v; } }) }] }) };
const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
global.Utilities = { formatDate: (d, tz, fmt) => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year:'numeric', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false })
    .formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  const pad = (x) => String(x).padStart(2, '0');
  if (fmt === 'HH:mm:ss') return `${p.hour}:${p.minute}:${p.second}`;
  if (fmt === 'd MMM yyyy, h:mm a') { const h = +p.hour, h12 = h % 12 || 12; return `${+p.day} ${M[+p.month-1]} ${p.year}, ${h12}:${p.minute} ${h < 12 ? 'AM' : 'PM'}`; }
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${p.hour}:${p.minute}`; } };
global.UrlFetchApp = { fetch: () => { throw new Error('UrlFetchApp must not be called in relay mode'); } };

global.Date = FakeDate;
eval(src);
global.Date = RealDate;

const call = (body) => JSON.parse(doPost({ postData: { contents: JSON.stringify(body) } }).t);
const TOKEN = 'secret-token';
const status = (row) => SHEET[row - 1][H];
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const run = (fn) => { global.Date = FakeDate; try { return fn(); } finally { global.Date = RealDate; } };

// 1. no token configured / wrong token
check('rejects when RELAY_TOKEN unset', run(() => call({ token: 'x', action: 'ping' })).error === 'unauthorized');
PROPS.RELAY_TOKEN = TOKEN;
check('rejects wrong token', run(() => call({ token: 'nope', action: 'claim' })).error === 'unauthorized');
check('rejects garbage body', JSON.parse(doPost({}).t).error === 'bad json');

// 2. mode gates
let res = run(() => call({ token: TOKEN, action: 'claim' }));
check('claim is inert while relay mode off', res.jobs.length === 0 && res.note === 'relay mode is off');
PROPS.WA_PROVIDER = 'relay';
res = run(() => call({ token: TOKEN, action: 'claim' }));
check('claim is inert while DRY_RUN on (unset = on)', res.jobs.length === 0 && res.note === 'DRY_RUN is on');
PROPS.DRY_RUN = 'false';
PROPS.TEST_WHITELIST = '+6590000001,+6580000002';
check('ping reports relay mode, live', (() => { const p = run(() => call({ token: TOKEN, action: 'ping' })); return p.relayMode && !p.dryRun; })());

// 3. trigger path stays out of the way in relay mode
const before = JSON.stringify(SHEET.map((r) => r[H]));
run(() => checkAndSendReminders());
check('timed trigger does nothing in relay mode', JSON.stringify(SHEET.map((r) => r[H])) === before);

// 4. first claim
res = run(() => call({ token: TOKEN, action: 'claim' }));
const rows = res.jobs.map((j) => j.row);
check('claims exactly the due + whitelisted rows (7, 8)', JSON.stringify(rows) === '[7,8]', 'got ' + JSON.stringify(rows));
check('local 8-digit number normalised to +65', res.jobs[1] && res.jobs[1].to === '+6580000002');
check('message personalised', res.jobs[0] && res.jobs[0].message.startsWith('Hi Due A, our courier will be picking up your Acme Store parcel on 24 Sep 2026, 5:55 PM.'));
check('row 7 marked Claimed', String(status(7)).startsWith('Claimed 18:00:00 [t='), status(7));
check('row 9 blocked by whitelist', status(9) === 'Error: Number not in TEST_WHITELIST, skipped for safety.');
check('row 10 (future) untouched', status(10) === '');
check('row 11 (100h+ late) skipped', String(status(11)).startsWith('Skipped: send time was'));
check('row 12 (bad phone) errored', status(12) === 'Error: invalid phone "abc"');
check('row 6 (already done) untouched', status(6) === 'DRY-RUN sent 2026-09-22 09:57');
const [jobA, jobB] = res.jobs;

// 5. immediate re-claim returns nothing (lease)
res = run(() => call({ token: TOKEN, action: 'claim' }));
check('second claim within lease gets nothing', res.jobs.length === 0);

// 6. report: A ok, B temporary failure
advance(1);
res = run(() => call({ token: TOKEN, action: 'report', results: [
  { row: jobA.row, key: jobA.key, ok: true },
  { row: jobB.row, key: jobB.key, ok: false, error: 'whatsapp not ready' },
] }));
check('report writes both rows', res.written === 2 && res.ignored === 0);
check('row 7 -> Sent via relay', status(7) === 'Sent 2026-09-23 18:01 via relay', status(7));
check('row 8 -> Retry with stamp', String(status(8)).startsWith('Retry: whatsapp not ready (2026-09-23 18:01) [t='), status(8));

// 7. retry backoff
advance(2);
check('retry row not re-offered before 5 min', run(() => call({ token: TOKEN, action: 'claim' })).jobs.length === 0);
advance(4);
res = run(() => call({ token: TOKEN, action: 'claim' }));
check('retry row re-offered after 5 min, same key', res.jobs.length === 1 && res.jobs[0].row === 8 && res.jobs[0].key === jobB.key);

// 8. lease expiry: claim but never report
advance(11);
res = run(() => call({ token: TOKEN, action: 'claim' }));
check('unreported claim re-offered after 10 min lease, same key', res.jobs.length === 1 && res.jobs[0].key === jobB.key);

// 9. stale / mismatched report is ignored
SHEET[7][G] = at('2026-09-23T18:30:00+08:00'); // user edits row 8's send time
res = run(() => call({ token: TOKEN, action: 'report', results: [{ row: 8, key: jobB.key, ok: true }] }));
check('report ignored after send time was edited (key mismatch)', res.ignored === 1 && String(status(8)).startsWith('Claimed'));
res = run(() => call({ token: TOKEN, action: 'report', results: [{ row: 7, key: jobA.key, ok: true }] }));
check('late duplicate report for an already-Sent row ignored', res.ignored === 1 && status(7) === 'Sent 2026-09-23 18:01 via relay');
res = run(() => call({ token: TOKEN, action: 'report', results: [{ row: 999, key: 'x', ok: true }, { row: 3, key: 'x', ok: true }] }));
check('out-of-range rows ignored', res.ignored === 2);

// 10. permanent error
advance(15);
SHEET[7][H] = ''; SHEET[7][G] = at('2026-09-23T18:00:00+08:00');
res = run(() => call({ token: TOKEN, action: 'claim' }));
const j = res.jobs[0];
run(() => call({ token: TOKEN, action: 'report', results: [{ row: j.row, key: j.key, ok: false, permanent: true, error: '+6580000002 is not on WhatsApp' }] }));
check('permanent failure -> Error (not retried)', status(8) === 'Error: +6580000002 is not on WhatsApp');
advance(30);
res = run(() => call({ token: TOKEN, action: 'claim' }));
check('errored row 8 never re-offered', !res.jobs.some((x) => x.row === 8), 'claimed rows ' + JSON.stringify(res.jobs.map((x) => x.row)));
check('row 10 claimed once its 19:00 send time arrives', res.jobs.length === 1 && res.jobs[0].row === 10);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
