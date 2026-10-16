/**
 * Booking pipeline: Google appointment bookings -> buffers/holds on the booking calendar,
 * mirror into Neon booking_requests, one email per new booking to notification_recipients.
 *
 * ONE source for every slot (testing, prod-blue, prod-green). Never edit a deployed copy:
 * per-slot identity lives in pipeline/env/<slot>.json and is compiled into Config.gs (const ENV).
 *
 * Fail-closed guards, checked on every run before anything is written:
 *   1. env marker:  obj_description('public'::regnamespace) must equal 'env:' + ENV.env
 *   2. active slot: obj_description('booking_requests'::regclass) must equal 'active_slot=' + ENV.slot
 *      (prod-blue and prod-green both run; only the active one acts. Flip = one SQL comment.)
 * Setup: run setup() once per slot and approve the permission screen. Remove: run teardown().
 */
const CFG = {
  bufferTitle: '· buffer',
  holdTitle: '· hold (unanswered invite)',
  timeZone: 'America/New_York',
  bufferMinutes: 15,
  bookingDays: [1, 3, 5],      // ISO weekday: 1 = Monday ... 7 = Sunday
  windowStart: '13:00',        // booking hours, in timeZone
  windowEnd: '16:30',
  horizonDays: 62,             // booking page offers 60 days ahead
  tagKey: 'bookingBufferKey',
  bookingTitlePrefix: 'Free 30-minute call with Tom Asbury',  // title Google gives booked appointments
  topicQuestion: 'What would you like to talk about?',
  scheduleBlurbPrefix: 'A free, no-obligation 30-minute video call',  // booking page description Google appends after the answer
  gcpProject: 'site-form-db-automations',   // Tom's GCP project (asbury-law.com org); holds every slot's secret
};

function setup() {
  teardown();
  const me = Session.getEffectiveUser().getEmail();
  ScriptApp.newTrigger('sync').forUserCalendar(me).onEventUpdated().create();
  if (ENV.calendarId) {
    try { ScriptApp.newTrigger('sync').forUserCalendar(ENV.calendarId).onEventUpdated().create(); }
    catch (err) { console.warn(ENV.slot + ': no change trigger (' + err + '); the 10-minute trigger covers it'); }
  }
  ScriptApp.newTrigger('sync').timeBased().everyMinutes(10).create();   // backstop + retries
  sync();
}

function teardown() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

function sync() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    const now = new Date();
    const horizon = new Date(now.getTime() + CFG.horizonDays * 864e5);
    const conn = readSecret_(CFG.gcpProject, ENV.secret);
    if (!conn) { console.error(ENV.slot + ': secret ' + ENV.secret + ' missing'); return; }
    if (!isActive_(conn)) return;                      // standby slot or wrong branch: do nothing
    let cal = null;
    try {
      cal = ENV.calendarId ? CalendarApp.getCalendarById(ENV.calendarId) : CalendarApp.getDefaultCalendar();
      // A calendar shared to this account is invisible to Apps Script until it is on the account's list: subscribe once.
      if (!cal && ENV.calendarId) cal = CalendarApp.subscribeToCalendar(ENV.calendarId);
    } catch (err) { console.error(ENV.slot + ': ' + err); }
    if (!cal) { console.error(ENV.slot + ': calendar not accessible (shared with "Make changes to events"?)'); return; }
    try { syncBuffers_(cal, now, horizon); } catch (err) { console.error(ENV.slot + ' buffers failed: ' + err); }
    try { mirrorBookings_(conn, cal, now, horizon); } catch (err) { console.error(ENV.slot + ' mirrorBookings failed: ' + err); }
  } finally {
    lock.releaseLock();
  }
}

// Both guards in one round trip. Throws on a wrong branch (loud), returns false on standby (quiet).
function isActive_(conn) {
  const r = (neonSql_(conn, "select obj_description('public'::regnamespace) as env, " +
    "obj_description('booking_requests'::regclass) as slot").rows || [])[0] || {};
  if (r.env !== 'env:' + ENV.env) {
    throw new Error('refusing to run: ' + ENV.secret + ' points at ' + r.env + ', expected env:' + ENV.env);
  }
  return r.slot === 'active_slot=' + ENV.slot;
}

// Buffers and holds are written onto the same calendar the booking page checks.
function syncBuffers_(primary, now, horizon) {
    const buffers = primary;
    const ms = CFG.bufferMinutes * 6e4;

    // 1. What should exist
    const want = {};
    primary.getEvents(now, horizon).forEach(function (e) {
      if (!isRealMeeting_(e)) return;
      const s = e.getStartTime(), f = e.getEndTime();
      const base = e.getId() + '@' + s.getTime();
      addIfInWindow_(want, base + ':before', new Date(s.getTime() - ms), s);
      addIfInWindow_(want, base + ':after', f, new Date(f.getTime() + ms));
      // Google's booking page ignores invitations Tom has not accepted; hold their time too.
      if (isUnanswered_(e)) addIfInWindow_(want, base + ':hold', s, f);
    });

    // 2. What exists now
    const have = {};
    buffers.getEvents(new Date(now.getTime() - 864e5), horizon).forEach(function (b) {
      const key = b.getTag(CFG.tagKey);
      if (!key) return;                       // never touch anything we did not create
      const w = want[key];
      if (have[key] || !w || w.start.getTime() !== b.getStartTime().getTime() ||
          w.end.getTime() !== b.getEndTime().getTime()) {
        b.deleteEvent();                      // stale, moved or duplicate
      } else {
        have[key] = true;
      }
    });

    // 3. Create what is missing
    Object.keys(want).forEach(function (key) {
      if (have[key]) return;
      const title = /:hold$/.test(key) ? CFG.holdTitle : CFG.bufferTitle;
      const ev = buffers.createEvent(title, want[key].start, want[key].end, {
        description: 'Automatic busy block so the booking page does not offer a call next to (or, for unanswered invitations, during) a meeting. Managed by the "Booking buffers" Apps Script; edits are overwritten.',
      });
      ev.setTag(CFG.tagKey, key);
      try { ev.removeAllReminders(); } catch (err) {}
      try { ev.setColor(CalendarApp.EventColor.GRAY); } catch (err) {}
    });
}

// ---- Booking mirror: Google appointment bookings -> Neon booking_requests ----
function mirrorBookings_(conn, primary, now, horizon) {
  const seen = {};
  primary.getEvents(new Date(now.getTime() - 864e5), horizon).forEach(function (e) {
    if (!isBooking_(e)) return;
    const b = parseBooking_(e);
    seen[b.id] = true;
    neonSql_(conn,
      'insert into booking_requests (google_event_id, start_at, end_at, status, name, email, phone, topic, meet_url, raw_description, cancelled_at) ' +
      'values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, case when $4 = \'cancelled\' then now() end) ' +
      'on conflict (google_event_id) do update set start_at = excluded.start_at, end_at = excluded.end_at, status = excluded.status, ' +
      'name = excluded.name, email = excluded.email, phone = excluded.phone, topic = excluded.topic, meet_url = excluded.meet_url, ' +
      'raw_description = excluded.raw_description, updated_at = now(), ' +
      'cancelled_at = case when excluded.status = \'cancelled\' then coalesce(booking_requests.cancelled_at, now()) end ' +
      'where (booking_requests.start_at, booking_requests.end_at, booking_requests.status, booking_requests.name, booking_requests.email, ' +
      'booking_requests.phone, booking_requests.topic, booking_requests.meet_url, booking_requests.raw_description) is distinct from ' +
      '(excluded.start_at, excluded.end_at, excluded.status, excluded.name, excluded.email, excluded.phone, excluded.topic, excluded.meet_url, excluded.raw_description)',
      [b.id, b.start.toISOString(), b.end.toISOString(), b.status, b.name, b.email, b.phone, b.topic, b.meetUrl, b.raw]);
  });
  // Bookings that disappeared from the calendar (cancelled by the visitor or deleted) -> cancelled
  const res = neonSql_(conn, "select google_event_id from booking_requests where status = 'booked' and start_at >= $1 and start_at < $2",
    [now.toISOString(), horizon.toISOString()]);
  (res.rows || []).forEach(function (r) {
    if (!seen[r.google_event_id]) {
      neonSql_(conn, "update booking_requests set status = 'cancelled', cancelled_at = now(), updated_at = now() where google_event_id = $1 and status = 'booked'",
        [r.google_event_id]);
    }
  });
  // New bookings -> email each active notification recipient (never blocks the mirror above)
  try { notifyBookings_(conn); } catch (err) { console.error('notifyBookings failed: ' + err); }
}

// ---- Booking notices: one email per new booking to each active row in notification_recipients ----
// Claim-then-send: notified_at is set before sending, and cleared again only if every send failed,
// so a booking is announced at most once (a crash mid-send never causes a repeat).
function notifyBookings_(conn) {
  const pending = neonSql_(conn,
    "select id, name, email, phone, topic, meet_url, " +
    "to_char(start_at at time zone 'America/New_York', 'Dy Mon FMDD, FMHH12:MI AM') as when_et, " +
    "(extract(epoch from end_at - start_at) / 60)::int::text as minutes " +
    "from booking_requests where status = 'booked' and notified_at is null and start_at >= now() order by id limit 20").rows || [];
  if (!pending.length) return;
  const recips = neonSql_(conn,
    "select email, name, include_message::text as include_message from notification_recipients where active order by id").rows || [];
  if (!recips.length) return;
  pending.forEach(function (b) {
    const claimed = neonSql_(conn, 'update booking_requests set notified_at = now() where id = $1 and notified_at is null returning id', [b.id]).rows || [];
    if (!claimed.length) return;
    let sent = 0;
    recips.forEach(function (r) {
      try {
        const msg = buildBookingEmail_(b, r.include_message === 'true');
        msg.to = r.email;
        MailApp.sendEmail(msg);
        sent++;
      } catch (err) { console.error('booking notice to ' + r.email + ' failed: ' + err); }
    });
    if (!sent) neonSql_(conn, 'update booking_requests set notified_at = null where id = $1', [b.id]);
  });
}

function buildBookingEmail_(b, includeTopic) {
  const who = b.name || b.email || 'Someone';
  const when = b.when_et + ' ET (' + (b.minutes || '30') + ' min)';
  const rows = [['When', when], ['Name', b.name], ['Email', b.email], ['Phone', b.phone], ['Google Meet', b.meet_url]]
    .filter(function (x) { return x[1]; });
  const text = ['New free call booked on asbury-law.com.', '']
    .concat(rows.map(function (x) { return x[0] + ': ' + x[1]; }))
    .concat(includeTopic && b.topic ? ['', 'What they would like to talk about:', b.topic] : [])
    .concat(['', 'Reply to this email to reach ' + who + ' directly. The call is on Tom\'s Google Calendar.'])
    .join('\n');
  const cell = 'padding:4px 12px 4px 0;vertical-align:top;';
  const html =
    '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.5">' +
    '<p style="margin:0 0 12px"><strong>New free call booked on asbury-law.com</strong></p>' +
    '<table style="border-collapse:collapse">' + rows.map(function (x) {
      const v = x[0] === 'Email' ? '<a href="mailto:' + esc_(x[1]) + '">' + esc_(x[1]) + '</a>'
              : x[0] === 'Google Meet' ? '<a href="' + esc_(x[1]) + '">' + esc_(x[1]) + '</a>'
              : esc_(x[1]);
      return '<tr><td style="' + cell + 'color:#666">' + x[0] + '</td><td style="' + cell + '">' + v + '</td></tr>';
    }).join('') + '</table>' +
    (includeTopic && b.topic ? '<p style="margin:16px 0 4px;color:#666">What they would like to talk about</p>' +
      '<p style="margin:0;white-space:pre-wrap">' + esc_(b.topic) + '</p>' : '') +
    '<p style="margin:16px 0 0;color:#666;font-size:12px">Reply to this email to reach ' + esc_(who) +
    ' directly. The call is on Tom\'s Google Calendar.</p></div>';
  return {
    subject: 'New call booked: ' + who + ' — ' + b.when_et + ' ET',
    body: text, htmlBody: html, name: 'asbury-law.com bookings',
    replyTo: b.email || undefined,
  };
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isBooking_(e) {
  if (e.isAllDayEvent()) return false;
  if (String(e.getTitle()).indexOf(CFG.bookingTitlePrefix) !== 0) return false;
  return /Booked by/i.test(plainText_(e.getDescription()));
}

function parseBooking_(e) {
  const raw = plainText_(e.getDescription());
  const lines = raw.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l; });
  const out = { id: e.getId(), start: e.getStartTime(), end: e.getEndTime(), status: 'booked',
                name: null, email: null, phone: null, topic: null, meetUrl: null, raw: raw.slice(0, 10000) };
  const i = lines.findIndex(function (l) { return /^Booked by$/i.test(l); });
  if (i >= 0) {
    for (let k = i + 1; k < Math.min(lines.length, i + 5); k++) {
      const l = lines[k];
      if (l.indexOf(CFG.topicQuestion) === 0) break;
      if (!out.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l)) out.email = l;
      else if (!out.phone && out.email && /^[+(\d][\d\s().-]{5,}$/.test(l)) out.phone = l;
      else if (!out.name && !out.email) out.name = l;
    }
  }
  const q = lines.findIndex(function (l) { return l.indexOf(CFG.topicQuestion) === 0; });
  if (q >= 0) {
    const rest = lines.slice(q + 1).filter(function (l) { return !/^(Booked by|Reschedule or cancel|Invitation from Google Calendar)/i.test(l); });
    let topic = rest.join('\n');
    const cut = topic.indexOf(CFG.scheduleBlurbPrefix);   // drop the booking page's own description
    if (cut >= 0) topic = topic.slice(0, cut);
    out.topic = topic.trim().slice(0, 5000) || null;
  }
  const m = raw.match(/https:\/\/meet\.google\.com\/[a-z0-9-]+/i) || String(e.getLocation() || '').match(/https:\/\/meet\.google\.com\/[a-z0-9-]+/i);
  if (m) out.meetUrl = m[0];
  // Visitor declined/cancelled while the event remains on the calendar
  try {
    const me = Session.getEffectiveUser().getEmail().toLowerCase();
    e.getGuestList().forEach(function (g) {
      const em = String(g.getEmail()).toLowerCase();
      if (em === me) return;
      if (!out.email) out.email = g.getEmail();
      if (out.email && em === out.email.toLowerCase() && g.getGuestStatus() === CalendarApp.GuestStatus.NO) out.status = 'cancelled';
    });
  } catch (err) {}
  if (out.name) out.name = out.name.slice(0, 200);
  if (out.phone) out.phone = out.phone.slice(0, 40);
  return out;
}

function plainText_(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Reads the latest version of a secret from Secret Manager as the running account (no copy kept in the script).
function readSecret_(project, name) {
  const url = 'https://secretmanager.googleapis.com/v1/projects/' + project + '/secrets/' + name + '/versions/latest:access';
  const resp = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Goog-User-Project': project }, muteHttpExceptions: true });
  const code = resp.getResponseCode();
  if (code === 404) return null;
  if (code !== 200) throw new Error('Secret Manager ' + code + ': ' + resp.getContentText().slice(0, 200));
  return Utilities.newBlob(Utilities.base64Decode(JSON.parse(resp.getContentText()).payload.data)).getDataAsString().trim();
}

// Neon serverless HTTP SQL endpoint (same protocol as @neondatabase/serverless)
function neonSql_(conn, query, params) {
  const hm = conn.match(/@([^/:?]+)/);
  if (!hm) throw new Error('Neon secret is not a postgres:// connection string');
  const host = hm[1];
  const url = 'https://' + host.replace(/^[^.]+\./, 'api.') + '/sql';
  const resp = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'Neon-Connection-String': conn },
    payload: JSON.stringify({ query: query, params: params || [] }),
  });
  const code = resp.getResponseCode();
  if (code !== 200) throw new Error('Neon ' + code + ': ' + resp.getContentText().slice(0, 300));
  return JSON.parse(resp.getContentText());
}

function isRealMeeting_(e) {
  if (e.isAllDayEvent()) return false;
  if (e.getTag(CFG.tagKey)) return false;                         // our own buffers
  try { if (e.getMyStatus() === CalendarApp.GuestStatus.NO) return false; } catch (err) {}
  try { if (e.getTransparency() === CalendarApp.EventTransparency.TRANSPARENT) return false; } catch (err) {}
  try {
    const t = e.getEventType();
    if (t === CalendarApp.EventType.WORKING_LOCATION || t === CalendarApp.EventType.FOCUS_TIME) return false;
  } catch (err) {}
  return true;
}

function isUnanswered_(e) {
  try {
    const st = e.getMyStatus();
    return st === CalendarApp.GuestStatus.INVITED || st === CalendarApp.GuestStatus.MAYBE;
  } catch (err) { return false; }
}

function addIfInWindow_(want, key, start, end) {
  const day = Number(Utilities.formatDate(start, CFG.timeZone, 'u'));
  if (CFG.bookingDays.indexOf(day) < 0) return;
  const date = Utilities.formatDate(start, CFG.timeZone, 'yyyy-MM-dd');
  const ws = Utilities.parseDate(date + ' ' + CFG.windowStart, CFG.timeZone, 'yyyy-MM-dd HH:mm');
  const we = Utilities.parseDate(date + ' ' + CFG.windowEnd, CFG.timeZone, 'yyyy-MM-dd HH:mm');
  if (start < we && end > ws) want[key] = { start: start, end: end };
}
