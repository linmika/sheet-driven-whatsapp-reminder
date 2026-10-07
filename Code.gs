/**
 * Pickup Reminder — WhatsApp Sender
 *
 * WHAT THIS DOES
 * Every 15 minutes, scans the active sheet for buyers whose
 * "One Day Before Scheduled Pick up Time" timestamp has arrived (i.e. it's
 * the actual send time for the reminder), sends each of them a WhatsApp
 * message, and writes the result back into the "Out for Delivery Message
 * Sent" column so nobody gets messaged twice and you have a record of
 * whether the send succeeded.
 *
 * PHASE 1 (now): DRY_RUN = true. No real WhatsApp message is sent — every
 * "send" is only written to the Apps Script log (View > Logs / Executions)
 * and the sheet, so you can validate the row-picking logic and message text
 * safely before any real API access exists.
 *
 * PHASE 2 (later): once your team gets WhatsApp Business (Cloud API) access,
 * fill in WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN in Script Properties and set
 * DRY_RUN to "false". No other code needs to change.
 *
 * ONE-TIME SETUP — just two things:
 * 1. Paste this whole file over Code.gs in the Apps Script editor, Save (Cmd+S).
 * 2. Pick `setup` in the function dropdown and hit Run. Approve the Google
 *    authorization prompts (the "app isn't verified" warning is expected for
 *    your own private script: Advanced > Go to ... > Allow).
 *
 * `setup` does the rest: writes the script properties (DRY_RUN=true,
 * TEST_WHITELIST), installs the every-15-minutes trigger, and runs one check
 * immediately so you can see the outcome in the log right away.
 *
 * WHERE TO LOOK AFTER RUNNING
 * - Execution log (the panel under the editor) shows lines like
 *   "[DRY RUN] Would send to +65…: Hi Alex, our courier will be picking up…"
 * - The sheet's "Out for Delivery Message Sent" column gets the result of
 *   each row it processed.
 * - If this project is bound to the sheet (created via Extensions > Apps
 *   Script), reloading the sheet shows a "Pickup Reminders > Run Now (Test)"
 *   menu. A standalone project works too (it opens the sheet by ID) but has
 *   no menu — use runNow from the editor instead.
 *
 * RELAY MODE (sends from your own WhatsApp via a relay computer)
 * The relay (gateway/ folder) polls doPost below every 60s; the timed trigger
 * stands down while WA_PROVIDER=relay. To enable: deploy this project as a Web
 * app (Execute as: Me, Who has access: Anyone) and set Script Properties
 * WA_PROVIDER=relay, DRY_RUN=false, RELAY_TOKEN=<token from the relay's
 * config.json>, TEST_WHITELIST=<recipients>. Running `setup` again turns
 * DRY_RUN back on, which pauses the relay (fail-safe).
 * After changing this code, a Web app deployment keeps serving the OLD version
 * until you edit the deployment and pick a new version (URL stays the same).
 *
 * GOING LIVE LATER (Phase 2)
 * Add WA_PHONE_NUMBER_ID and WA_ACCESS_TOKEN to Script Properties, set
 * WA_PROVIDER back to anything other than "relay", switch DRY_RUN to "false",
 * and swap the payload in sendWhatsAppMessage_ to your approved message
 * template. TEST_WHITELIST keeps real sends limited to the numbers listed
 * there until you clear it.
 */

// ---- Config ---------------------------------------------------------------

var HEADER_NAMES = {
  phone: 'Buyer Phone Number',
  buyerName: 'Buyer Name',
  sellerName: 'Seller Name',
  pickupTime: 'Scheduled Pick up time (D0)',
  reminderDate: 'One Day Before Scheduled Pick up Time',
  sentStatus: 'Out for Delivery Message Sent'
};

var MESSAGE_TEMPLATE =
  'Hi {{BuyerName}}, our courier will be picking up your {{SellerName}} parcel on ' +
  '{{PickupTime}}. To secure a smooth pick up process, make sure you either ' +
  'print out the return AWB or handwrite the return tracking number on the ' +
  'properly wrapped parcel and handover to our drivers.';

var SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID';
var TIMEZONE = 'Asia/Singapore';
var DEFAULT_COUNTRY_CODE = '65'; // Singapore

// Safety cap: a row whose send time is already this many hours in the past is
// flagged instead of sent. Stops a paused/reopened sheet from blasting out a
// batch of stale reminders, and catches text-typed dates (V8 parses a year-less
// "22 Sep 10:00" as year 2001, which would otherwise look permanently due).
var MAX_LATE_HOURS = 72;

// Relay mode (a computer running the gateway polls doPost for work):
var LEASE_MINUTES = 10;     // a claimed row never reported back becomes claimable again
var RETRY_MINUTES = 5;      // wait before re-offering a row that hit a temporary error
var MAX_JOBS_PER_CLAIM = 20;

// ---- Manual run (from the editor's function dropdown) ---------------------
// NOTE: this is a standalone project, so it has no spreadsheet menu. If you
// ever want a "Pickup Reminders" menu inside the sheet, the project has to be
// container-bound (created via Extensions > Apps Script on the sheet itself).

function runNow() {
  checkAndSendReminders();
}

// ---- Main entry point -------------------------------------------------------

function checkAndSendReminders() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('WA_PROVIDER') === 'relay') {
    Logger.log('Relay mode: the relay computer pulls due messages itself; nothing to do here.');
    return;
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) { Logger.log('Another run is in progress; skipping this one.'); return; }
  try {
    var ctx = openSheet_();
    var now = new Date();
    var sent = 0, skipped = 0, errored = 0;

    for (var r = ctx.header.rowIndex + 1; r < ctx.values.length; r++) {
      var ev = evaluateRow_(ctx.values[r], r, ctx.colMap, now);
      if (ev.kind === 'skip') { continue; }
      if (ev.kind === 'final') {
        writeStatus_(ctx.sheet, r, ctx.colMap.sentStatus, ev.status);
        if (ev.status.indexOf('Skipped') === 0) { skipped++; } else { errored++; }
        continue;
      }
      var result = sendWhatsAppMessage_(ev.phone, ev.message);
      if (result.success) {
        var label = result.dryRun ? 'DRY-RUN sent ' : 'Sent ';
        writeStatus_(ctx.sheet, r, ctx.colMap.sentStatus,
          label + Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm'));
        sent++;
      } else {
        writeStatus_(ctx.sheet, r, ctx.colMap.sentStatus, 'Error: ' + result.error);
        errored++;
      }
    }
    Logger.log('Done. Sent/dry-run: ' + sent + ', skipped (stale): ' + skipped + ', errors: ' + errored);
  } finally {
    lock.releaseLock();
  }
}

// ---- Row rules shared by the timed trigger and the relay endpoint -----------

function openSheet_() {
  // Bound script -> active spreadsheet; standalone script -> open by ID.
  var ss = SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheets()[0];
  var values = sheet.getDataRange().getValues();
  var header = locateHeader_(values);
  return { sheet: sheet, values: values, header: header, colMap: mapColumns_(values[header.rowIndex]) };
}

function stamp_(date) { return '[t=' + date.getTime() + ']'; }

function stampTime_(status) {
  var m = /\[t=(\d+)\]/.exec(String(status));
  return m ? Number(m[1]) : null;
}

// Empty = never handled. "Claimed" = handed to the relay (re-offered after the lease).
// "Retry:" = temporary failure (re-offered after RETRY_MINUTES). Anything else is final.
function isEligible_(status, now) {
  var s = String(status || '');
  if (!s) { return true; }
  var t = stampTime_(s);
  if (s.indexOf('Claimed ') === 0) { return t !== null && now.getTime() - t > LEASE_MINUTES * 60000; }
  if (s.indexOf('Retry: ') === 0) { return t === null || now.getTime() - t > RETRY_MINUTES * 60000; }
  return false;
}

function toDate_(value) {
  var d = (Object.prototype.toString.call(value) === '[object Date]') ? value : new Date(value);
  return (value === '' || value === null || isNaN(d.getTime())) ? null : d;
}

// Stable per row + send time, so the relay can recognise a message it already sent.
function rowKey_(rowIndex, reminderDate) { return 'r' + (rowIndex + 1) + '-' + reminderDate.getTime(); }

function evaluateRow_(row, rowIndex, colMap, now) {
  if (!isEligible_(row[colMap.sentStatus], now)) { return { kind: 'skip' }; }
  var reminderDate = toDate_(row[colMap.reminderDate]);
  if (!reminderDate || reminderDate.getTime() > now.getTime()) { return { kind: 'skip' }; }

  var hoursLate = (now.getTime() - reminderDate.getTime()) / 3600000;
  if (hoursLate > MAX_LATE_HOURS) {
    return { kind: 'final', status: 'Skipped: send time was ' + Math.round(hoursLate) + 'h ago, too stale to send' };
  }
  var phoneE164 = normalizePhone_(row[colMap.phone]);
  if (!phoneE164) {
    return { kind: 'final', status: 'Error: invalid phone "' + row[colMap.phone] + '"' };
  }

  var buyerName = row[colMap.buyerName];
  var sellerName = row[colMap.sellerName];
  var pickupTimeStr = formatPickupTime_(row[colMap.pickupTime]);
  var message = MESSAGE_TEMPLATE
    .replace('{{BuyerName}}', function () { return buyerName || 'there'; })
    .replace('{{SellerName}}', function () { return sellerName || 'the seller'; })
    .replace('{{PickupTime}}', function () { return pickupTimeStr; });

  return { kind: 'due', phone: phoneE164, message: message, key: rowKey_(rowIndex, reminderDate) };
}

function parseWhitelist_(props) {
  return (props.getProperty('TEST_WHITELIST') || '')
    .split(',').map(function (s) { return s.trim(); }).filter(String);
}

// ---- Sending (swap this for the real API call in Phase 2) ------------------

function sendWhatsAppMessage_(phoneE164, messageBody) {
  var props = PropertiesService.getScriptProperties();
  var dryRun = props.getProperty('DRY_RUN') !== 'false'; // default true

  if (dryRun) {
    Logger.log('[DRY RUN] Would send to ' + phoneE164 + ': ' + messageBody);
    return { success: true, dryRun: true };
  }

  var whitelist = parseWhitelist_(props);
  if (whitelist.length > 0 && whitelist.indexOf(phoneE164) === -1) {
    return { success: false, error: 'Number not in TEST_WHITELIST, skipped for safety.' };
  }

  var phoneNumberId = props.getProperty('WA_PHONE_NUMBER_ID');
  var accessToken = props.getProperty('WA_ACCESS_TOKEN');
  if (!phoneNumberId || !accessToken) {
    return { success: false, error: 'Missing WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN script property.' };
  }

  // NOTE: business-initiated WhatsApp messages outside a customer's 24h
  // service window must use a pre-approved template, not free-form "text".
  // Swap `type`/payload below to the approved template name once you have one.
  var url = 'https://graph.facebook.com/v20.0/' + phoneNumberId + '/messages';
  var payload = {
    messaging_product: 'whatsapp',
    to: phoneE164.replace('+', ''),
    type: 'text',
    text: { body: messageBody }
  };
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + accessToken },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();
  if (code >= 200 && code < 300) { return { success: true }; }
  return { success: false, error: 'HTTP ' + code + ': ' + response.getContentText() };
}

// ---- Helpers ----------------------------------------------------------------

function locateHeader_(values) {
  for (var r = 0; r < values.length; r++) {
    for (var c = 0; c < values[r].length; c++) {
      if (String(values[r][c]).trim() === HEADER_NAMES.phone) {
        return { rowIndex: r };
      }
    }
  }
  throw new Error('Could not find header "' + HEADER_NAMES.phone + '" in the active sheet.');
}

function mapColumns_(headerRow) {
  var map = {};
  var wanted = {
    phone: HEADER_NAMES.phone,
    buyerName: HEADER_NAMES.buyerName,
    sellerName: HEADER_NAMES.sellerName,
    pickupTime: HEADER_NAMES.pickupTime,
    reminderDate: HEADER_NAMES.reminderDate,
    sentStatus: HEADER_NAMES.sentStatus
  };
  Object.keys(wanted).forEach(function (key) {
    var idx = headerRow.findIndex(function (cell) {
      return String(cell).trim() === wanted[key];
    });
    if (idx === -1) {
      throw new Error('Could not find column "' + wanted[key] + '" in the header row.');
    }
    map[key] = idx;
  });
  return map;
}

function formatPickupTime_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, TIMEZONE, 'd MMM yyyy, h:mm a');
  }
  return String(value);
}

function normalizePhone_(raw) {
  if (!raw) { return null; }
  var hadPlus = String(raw).trim().charAt(0) === '+';
  var digits = String(raw).replace(/[^\d]/g, '');
  if (!hadPlus) {
    digits = digits.replace(/^0+/, ''); // drop leading 0 (local format)
    if (digits.length === 8) { digits = DEFAULT_COUNTRY_CODE + digits; }
  }
  if (digits.length < 8 || digits.length > 15) { return null; } // E.164 bounds
  return '+' + digits;
}

function writeStatus_(sheet, rowIndex, colIndex, text) {
  sheet.getRange(rowIndex + 1, colIndex + 1).setValue(text);
}

// ---- Relay endpoint (deploy as Web app: Execute as Me, access Anyone) ------
// The relay computer POSTs JSON {token, action}. Everything is gated on RELAY_TOKEN.
//   ping   -> current mode
//   claim  -> due rows, each marked "Claimed" so a second poll can't take it too
//   report -> [{row, key, ok, error, permanent}] written back to the sheet

function doGet() {
  return ContentService.createTextOutput('Pickup reminder relay endpoint. POST only.');
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad json' }); }
  var props = PropertiesService.getScriptProperties();
  var expected = props.getProperty('RELAY_TOKEN');
  if (!expected || !req || req.token !== expected) { return json_({ ok: false, error: 'unauthorized' }); }

  if (req.action === 'ping') {
    return json_({ ok: true, relayMode: props.getProperty('WA_PROVIDER') === 'relay',
      dryRun: props.getProperty('DRY_RUN') !== 'false' });
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) { return json_({ ok: false, error: 'busy, try again' }); }
  try {
    if (req.action === 'claim') { return json_(claimJobs_(props)); }
    if (req.action === 'report') { return json_(reportResults_(req.results || [])); }
    return json_({ ok: false, error: 'unknown action' });
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function claimJobs_(props) {
  if (props.getProperty('WA_PROVIDER') !== 'relay') { return { ok: true, jobs: [], note: 'relay mode is off' }; }
  if (props.getProperty('DRY_RUN') !== 'false') { return { ok: true, jobs: [], note: 'DRY_RUN is on' }; }
  var whitelist = parseWhitelist_(props);
  var ctx = openSheet_();
  var now = new Date();
  var jobs = [];

  for (var r = ctx.header.rowIndex + 1; r < ctx.values.length && jobs.length < MAX_JOBS_PER_CLAIM; r++) {
    var ev = evaluateRow_(ctx.values[r], r, ctx.colMap, now);
    if (ev.kind === 'skip') { continue; }
    if (ev.kind === 'final') { writeStatus_(ctx.sheet, r, ctx.colMap.sentStatus, ev.status); continue; }
    if (whitelist.length > 0 && whitelist.indexOf(ev.phone) === -1) {
      writeStatus_(ctx.sheet, r, ctx.colMap.sentStatus, 'Error: Number not in TEST_WHITELIST, skipped for safety.');
      continue;
    }
    writeStatus_(ctx.sheet, r, ctx.colMap.sentStatus,
      'Claimed ' + Utilities.formatDate(now, TIMEZONE, 'HH:mm:ss') + ' ' + stamp_(now));
    jobs.push({ row: r + 1, key: ev.key, to: ev.phone, message: ev.message });
  }
  return { ok: true, jobs: jobs };
}

function reportResults_(results) {
  var ctx = openSheet_();
  var now = new Date();
  var ts = Utilities.formatDate(now, TIMEZONE, 'yyyy-MM-dd HH:mm');
  var written = 0, ignored = 0;

  results.forEach(function (res) {
    var r = Number(res.row) - 1;
    if (!(r > ctx.header.rowIndex && r < ctx.values.length)) { ignored++; return; }
    var row = ctx.values[r];
    var status = String(row[ctx.colMap.sentStatus] || '');
    var reminderDate = toDate_(row[ctx.colMap.reminderDate]);
    // Only settle a row still waiting on this exact job (send time unchanged since the claim).
    var waiting = status.indexOf('Claimed ') === 0 || status.indexOf('Retry: ') === 0;
    if (!waiting || !reminderDate || rowKey_(r, reminderDate) !== res.key) { ignored++; return; }

    var err = String(res.error || 'unknown error').slice(0, 200);
    var text = res.ok ? 'Sent ' + ts + ' via relay'
      : res.permanent ? 'Error: ' + err
      : 'Retry: ' + err + ' (' + ts + ') ' + stamp_(now);
    writeStatus_(ctx.sheet, r, ctx.colMap.sentStatus, text);
    written++;
  });
  return { ok: true, written: written, ignored: ignored };
}

// ---- Relay mode switches (run from the editor's function dropdown) ---------

// Run once after deploying the Web app and adding RELAY_TOKEN in Script properties.
function enableRelayMode() {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('WA_PROVIDER', 'relay');
  props.setProperty('DRY_RUN', 'false');
  props.setProperty('TEST_WHITELIST', '+6590000001,+6580000002');
  var token = props.getProperty('RELAY_TOKEN');
  Logger.log('WA_PROVIDER = relay | DRY_RUN = false | TEST_WHITELIST = ' + props.getProperty('TEST_WHITELIST'));
  Logger.log(token && token.length >= 32
    ? 'RELAY_TOKEN is set (' + token.length + ' chars). The relay can now pull messages.'
    : '!!! RELAY_TOKEN is missing - add it under Project Settings > Script properties, then run this again.');
}

// Kill switch: the relay keeps polling but gets no work; unsent rows stay untouched.
function pauseRelay() {
  PropertiesService.getScriptProperties().setProperty('DRY_RUN', 'true');
  Logger.log('Relay PAUSED (DRY_RUN = true). Nothing will be sent. Run enableRelayMode to resume.');
}

// ---- One-time trigger setup --------------------------------------------------

function createReminderTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkAndSendReminders') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('checkAndSendReminders')
    .timeBased()
    .everyMinutes(15)
    .create();
  Logger.log('Trigger installed: checkAndSendReminders runs every 15 minutes.');
}

// ---- One-click setup: run this ONCE, then you're done ----------------------
// Sets the script properties, installs the 15-minute trigger, and immediately
// runs one check so you can see the result in the log straight away.

function setup() {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('DRY_RUN', 'true');
  props.setProperty('TEST_WHITELIST', '+6590000001');

  createReminderTrigger();

  Logger.log('=== Setup complete ===');
  Logger.log('DRY_RUN = ' + props.getProperty('DRY_RUN') + '  (true = log only, nothing is really sent)');
  Logger.log('TEST_WHITELIST = ' + props.getProperty('TEST_WHITELIST'));
  Logger.log('Trigger: checkAndSendReminders every 15 minutes');
  Logger.log('=== Running one check now ===');

  checkAndSendReminders();
}
