// Unit tests for the pure parts of Code.gs, run in a sandbox with Apps Script globals stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function load(env, rows) {
  const ctx = {
    console,
    ENV: Object.freeze(env),
    Session: { getEffectiveUser: () => ({ getEmail: () => "owner@example.com" }) },
    CalendarApp: { GuestStatus: { NO: "NO", INVITED: "INVITED", MAYBE: "MAYBE" } },
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL("../src/Code.gs", import.meta.url), "utf8"), ctx);
  if (rows) ctx.neonSql_ = () => ({ rows });
  return ctx;
}
const PROD = { slot: "prod-blue", env: "production", calendarId: null, secret: "neon-booking-sync" };

function event(desc) {
  return {
    getDescription: () => desc, getId: () => "evt1", getLocation: () => "",
    getStartTime: () => new Date("2026-10-19T19:15:00Z"), getEndTime: () => new Date("2026-10-19T19:45:00Z"),
    getGuestList: () => [],
  };
}
const DESC = "Booked by<br>Ryan Smithright<br>ryan@smithright.com<br>2125187631<br>" +
  "What would you like to talk about? (No confidential details, please.)<br>test topic<br>" +
  "A free, no-obligation 30-minute video call with attorney Thomas Asbury about estate planning.<br>" +
  "Join with Google Meet https://meet.google.com/abc-defg-hij";

test("parseBooking_ extracts contact fields and strips the booking page blurb", () => {
  const b = load(PROD).parseBooking_(event(DESC));
  assert.equal(b.name, "Ryan Smithright");
  assert.equal(b.email, "ryan@smithright.com");
  assert.equal(b.phone, "2125187631");
  assert.equal(b.topic, "test topic");
  assert.equal(b.meetUrl, "https://meet.google.com/abc-defg-hij");
});

test("buildBookingEmail_ escapes HTML and hides the topic when not allowed", () => {
  const c = load(PROD);
  const b = { name: "A <b>B</b>", email: "a@b.co", when_et: "Mon Oct 19, 3:15 PM", minutes: "30", topic: "secret" };
  assert.ok(!/<b>B<\/b>/.test(c.buildBookingEmail_(b, true).htmlBody));
  assert.ok(!c.buildBookingEmail_(b, false).body.includes("secret"));
  assert.equal(c.buildBookingEmail_(b, true).replyTo, "a@b.co");
});

test("isActive_: active slot acts, standby slot does nothing", () => {
  assert.equal(load(PROD, [{ env: "env:production", slot: "active_slot=prod-blue" }]).isActive_("c"), true);
  assert.equal(load(PROD, [{ env: "env:production", slot: "active_slot=prod-green" }]).isActive_("c"), false);
});

test("isActive_: a secret pointing at the wrong branch fails closed", () => {
  assert.throws(() => load(PROD, [{ env: "env:testing", slot: "active_slot=prod-blue" }]).isActive_("c"), /refusing to run/);
  assert.throws(() => load(PROD, [{ env: null, slot: null }]).isActive_("c"), /refusing to run/);
});
