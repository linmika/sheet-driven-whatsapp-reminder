# Sheet-driven WhatsApp Reminder

A small automation that turns a Google Sheet into a scheduled WhatsApp notifier:
ops fills rows, and buyers automatically get a message reminder at the right time 
— with the send result written back into the sheet.

Built as a working internal prototype (Apps Script + a relay PC sending from a
personal WhatsApp via `whatsapp-web.js`), designed so the send channel can be
swapped for the official WhatsApp Business API later without touching the sheet,
the scheduler, or the state machine.


## The problem

Product iteration cannot catch up with actual operational use case. Operations are manaully
sending out whatsapp messages 1 by 1.

Goals:

1. Ops keeps working in the spreadsheet they already use — no new tool.
2. Each row sends **exactly once**, at the time in the "send at" column.
3. The sheet itself shows the outcome (`Sent` / `Error` / `Skipped`), so the sheet
   stays the single source of truth.
4. Safe by construction while testing: nothing can be sent to a number outside an
   explicit allowlist, enforced in **two independent places**.

## Architecture

```
 ┌──────────────────────┐        ┌───────────────────────────┐
 │  Google Sheet        │◀──────▶│  Google Apps Script       │
 │  ops fills rows      │  r/w   │  • time trigger (15 min)  │
 │  col H = send result │        │  • decides what is "due"  │
 └──────────────────────┘        │  • web app: claim/report  │
                                 └────────────▲──────────────┘
                                              │ ② poll every 60 s: "anything due?"
                                              │ ④ report sent / failed
                                              │   (outbound-only HTTPS)
                                 ┌────────────┴──────────────┐
                                 │  Relay PC (Windows/Mac)   │
                                 │  • Google OAuth (PKCE)    │
                                 │  • whatsapp-web.js        │
                                 │    as a linked device     │
                                 └────────────┬──────────────┘
                                              │ ③ send WhatsApp message
                                              ▼
                                         📱 buyer's phone
```

**Why pull, not push?** The relay runs on an office PC. A push model (Apps Script
calling into the PC) needs an inbound tunnel — an open door on a corporate machine.
In the pull model the relay only ever makes outbound HTTPS calls; its status/QR page
binds to `127.0.0.1` only. Nothing on the machine is reachable from the internet.

**Why is the relay signed in to Google?** Corporate Google Workspace often has no
"Anyone" access level for Apps Script web apps — only "Anyone within <domain>". So
anonymous calls get a 401 login page. The relay therefore authenticates with its own
OAuth Desktop client (loopback + PKCE, refresh token stored locally with mode 600)
and sends a Bearer token on every call.

**The non-obvious part — `drive.file` + the Picker grant.** The minimal scope that
lets a token call a domain-restricted web app is `drive.file`. But `drive.file` only
grants access to files *the user has explicitly opened with that app* — so the web
app returns 404 ("file does not exist") until the Apps Script project file is
granted once via the **Google Picker** (`gateway/grant-file.js` serves a local page
that opens the Picker with the OAuth token + a Picker-restricted API key). The grant
is tied to the user + client, so it survives moving the relay to another machine.
This avoids the far broader `drive.readonly`/`drive` scopes.

## The row state machine (column H)

The sheet column doubles as a tiny job queue with leases:

```
(empty) ──due──▶ Claimed HH:mm:ss [t=ms] ──ok──────▶ Sent <timestamp> via relay
                   │                      ├─temp err─▶ Retry: <reason> [t=ms]  (re-offered after 5 min)
                   │                      └─perm err─▶ Error: <reason>         (never retried)
                   └─ lease expires (10 min, relay died) ─▶ back to claimable
(empty, >72 h late) ───────────────────────────────▶ Skipped: too late
```

- **Claim**: the web app hands out at most 20 due, allowlisted jobs per poll and
  stamps the rows `Claimed`, so two relays can't double-send.
- **Dedupe key**: every job carries `r<row>-<sendTime ms>`. The relay persists sent
  keys to disk, so a crash between "sent" and "reported" cannot resend; editing the
  send time deliberately changes the key.
- **Report**: results only settle rows still in `Claimed`/`Retry` with a matching
  key — a stale or duplicate report is ignored.

## Safety rails

| Rail | Where |
|---|---|
| Allowlist | enforced **both** in Apps Script (`TEST_WHITELIST`) and in the relay (`config.json`) — a bug in either side alone cannot message a stranger |
| Shared secret | 64-char token required on every web-app call, on top of Google auth |
| Sender pinning | the relay refuses to send if the linked WhatsApp number ≠ `sender` |
| Rate limiting | 3 s gap between messages, ≤ 20 jobs per claim |
| Kill switch | `pauseRelay()` flips `DRY_RUN` back on; all relays stop getting work |
| Phone hygiene | E.164 normalisation with length bounds; bad numbers become `Error`, not silent sends |

## Testing

```
npm install --prefix gateway   # once
npm test
```

Two suites, both run against the **real** production code:

1. `test/sim_relay.js` — 29 assertions against `Code.gs` in a VM sandbox with a
   controllable clock: due/not-due/too-late selection, claim leases expiring,
   retries, key mismatches, whitelist, phone normalisation, idempotent reports.
2. `test/run-e2e.js` — boots the **real relay process** against the **real
   `Code.gs`** with only the two network edges faked (WhatsApp client, Google
   token): full ping→claim→send→report loop, dedupe across restarts, allowlist
   block, permanent-error path, and that every HTTP call carries the Bearer token.

Faking only the edges keeps the real integration surface under test: the
claim/report protocol, the Bearer header on every call, and dedupe persistence
across relay restarts.

## Running it for real

1. Create a Sheet with the columns in `Code.gs` (`HEADER_NAMES`), paste `Code.gs` +
   `appsscript.json` into an Apps Script project, set the script properties
   (`RELAY_TOKEN`, then run `setup()` once and `enableRelayMode()` when ready).
2. Deploy as a web app (*Execute as me*; access: your domain), note the `/exec` URL.
3. Create a GCP OAuth **Desktop** client, save it as `gateway/oauth-client.json`
   (see `oauth-client.example.json`), and copy `config.example.json` →
   `config.json` with your values.
4. On the relay machine: `node setup.js`, `node login.js`, `node grant-file.js`
   (one-time Picker grant), then `node gateway.js` and scan the QR.
   Windows `.bat` wrappers are included for non-technical operators.

## Limitations & lessons

- **Unofficial channel.** `whatsapp-web.js` automates WhatsApp Web, which is
  against WhatsApp's ToS; numbers doing bulk sends get banned. This is a prototype
  pattern for low-volume internal testing — production should swap
  `sendWhatsAppMessage_()` for the WhatsApp Business API (the seam is one function
  plus one script property).
- **The relay must stay up.** Rows that come due while the relay PC sleeps are sent
  late (up to the 72 h cutoff). A missed evening of sends in testing traced back to
  exactly this — the process wasn't running.
- **Late sends need two cutoffs.** "Send if less than 72 h late" alone still
  fires after the pickup has already happened; `evaluateRow_` therefore also
  skips once `now > pickup time`. Found by sending a real (expired) reminder.
- **Apps Script deployments are versioned.** Pushing new code does nothing to the
  live web app until you create a new deployment version — and an open editor tab
  can silently overwrite an API push with stale code.
- **Sheets will eat your phone numbers.** A leading `+` parses as a formula; write
  phone cells as plain text (RAW input mode via the API).

## License

MIT
