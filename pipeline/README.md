# Booking pipeline

Google booking page → buffers/holds on the owner's calendar → mirror into Neon `booking_requests` → one email per new booking to `notification_recipients`.

## One artifact, three slots
| Slot | Runs as (owns the booking page) | Neon branch | Secret (Tom's GCP `site-form-db-automations`) | Role |
|---|---|---|---|---|
| `staging` | smithright@asbury-law.com | `staging` (`env:staging`) | `neon-booking-sync-staging` | every merge |
| `prod-blue` | tom@asbury-law.com | `production` (`env:production`) | `neon-booking-sync` | live or standby |
| `prod-green` | tom@asbury-law.com | `production` (`env:production`) | `neon-booking-sync` | live or standby |

- Source: `src/Code.gs` + `src/appsscript.json`. Identity only: `env/<slot>.json`. `node pipeline/build.mjs` compiles `dist/<slot>/` (adds a generated `Config.gs` with `const ENV`). **Never edit a deployed script by hand.**
- Every slot runs as the booking page's owner on that owner's primary calendar, so staging and prod differ only in identity.
- Site side: `config/booking.json` decides which booking page each Vercel environment embeds (`scripts/build-site-env.mjs`, run by `vercel.json`).

## Guards (fail closed, every run)
1. `obj_description('public'::regnamespace)` must be `env:<ENV.env>`, else the run throws. A secret pointing at the wrong branch writes nothing. `api/contact.js` applies the same check (production deployments ↔ `env:production`, all others ↔ `env:staging`).
2. `obj_description('booking_requests'::regclass)` must be `active_slot=<ENV.slot>`, else the run does nothing (standby).

## Release flow
1. Change `pipeline/**`, push to `mvp-preview` → CI runs unit tests, builds and `clasp push`es **staging**, then tags `staged-<sha>`.
2. Book a test call on the staging page (config/booking.json `.preview`); confirm the row in staging `booking_requests` and the email.
3. Actions → booking-pipeline → Run workflow: `sha` = that full SHA, `slot` = the **standby** prod slot. CI refuses any SHA without a `staged-<sha>` tag and records `promoted-<slot>-<sha>`.
4. Go live (Neon SQL editor, production branch): `comment on table booking_requests is 'active_slot=prod-green';` Takes effect within 10 minutes.
5. **Rollback** = the same line back to the previous slot. The previous slot is still deployed and running; nothing is redeployed.

Writes are upserts and notices are claimed before sending, so a flip mid-run cannot double-write or double-email.

## Booking pages (no Google API: declared here, checked by hand at promote time)
Title `Free 30-minute call with Tom Asbury` (the script keys on it) · 30 min · Mon/Wed/Fri 1:00–4:30 pm America/New_York · 15-min buffer · max 4/day · 24 h notice · 60 days ahead · Google Meet · conflict-check primary calendar only · guests can't invite others · form: first/last name, email, phone (optional), "What would you like to talk about? (No confidential details, please.)" (required) · same description text.

## One-time setup per slot
- Apps Script project owned by the slot's account, manifest visible; `scriptId` in `env/<slot>.json`.
- First `setup()` run in the editor + Allow (installs the calendar-change trigger and a 10-minute trigger).
- GitHub `staging` environment secret `CLASPRC_STAGING` = `~/.clasprc.json` after `clasp login` as smithright@; `production` environment secret `CLASPRC_PROD` = same as tom@, with required reviewers on `production`.
- Apps Script API enabled for both accounts (script.google.com/home/usersettings).
