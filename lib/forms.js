// Shared by every form endpoint in api/: one pooled connection, the fail-closed environment check,
// the origin allowlist, and alerts to every active row in notification_recipients (Resend).
const { Pool } = require("pg");
const { attachDatabasePool } = require("@vercel/functions");

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL || process.env.DATABASE_URL, max: 5 });
attachDatabasePool(pool);

// The database must declare the environment this deployment belongs to (migrations 005/006):
// production deployments write only to env:production, everything else only to env:testing.
const EXPECTED_ENV = process.env.VERCEL_ENV === "production" ? "env:production" : "env:testing";
let envVerified = false;
async function assertEnv() {
  if (envVerified) return;
  const { rows } = await pool.query("select obj_description('public'::regnamespace) as env");
  const got = rows[0] && rows[0].env;
  if (got !== EXPECTED_ENV) throw new Error(`wrong database for this deployment: ${got}, expected ${EXPECTED_ENV}`);
  envVerified = true;
}

// Behind a router the Host header can differ from Origin, so accept the committed allowlist plus same-host.
const ALLOWED_HOSTS = new Set(require("../config/hosts.json").allowed);
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients; still validated by each endpoint
  try {
    const host = new URL(origin).host;
    return host === req.headers.host || ALLOWED_HOSTS.has(host);
  } catch {
    return false;
  }
}

function str(v, max) {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const configured = () => !!(process.env.APP_DATABASE_URL || process.env.DATABASE_URL);

// Emails every active recipient. `rows` = [[label, value], ...]; `body` = optional free text (shown only to
// recipients with include_message). Returns true when every send was accepted.
async function notifyRecipients({ kicker, heading, subject, rows, body, bodyLabel, footer, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error("notify: RESEND_API_KEY is not configured; alert skipped");
    return false;
  }
  const { rows: recips } = await pool.query(
    "select email, include_message from notification_recipients where active order by id"
  );
  if (!recips.length) {
    console.error("notify: no active notification recipients");
    return false;
  }
  const domain = process.env.RESEND_EMAIL_DOMAIN || "asbury-law.com";
  const from = process.env.NOTIFY_FROM || `Asbury Law Website <notifications@${domain}>`;
  let allOk = true;
  for (const r of recips) {
    const withBody = r.include_message && body;
    const text =
      rows.map(([k, v]) => `${k}: ${v}`).join("\n") +
      (withBody ? `\n\n${bodyLabel || "Message"}:\n${body}` : "") +
      (footer ? `\n\n${footer}` : "");
    const html =
      `<div style="font-family:Georgia,serif;color:#2A2520;max-width:560px">` +
      `<p style="font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:#9B7F2E;margin:0 0 6px">${esc(kicker)}</p>` +
      `<h2 style="font-weight:500;margin:0 0 16px">${esc(heading)}</h2>` +
      `<table style="font-family:Arial,sans-serif;font-size:14px;border-collapse:collapse">` +
      rows.map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#8A8278">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`).join("") +
      `</table>` +
      (withBody
        ? `<p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap;background:#F2EDE4;padding:14px 16px;border-left:3px solid #C9A84C;margin:18px 0">${esc(body)}</p>`
        : "") +
      (footer ? `<p style="font-family:Arial,sans-serif;font-size:12px;color:#8A8278">${esc(footer)}</p>` : "") +
      `</div>`;
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [r.email], reply_to: replyTo || undefined, subject, text, html }),
    });
    if (!resp.ok) {
      allOk = false;
      console.error("notify: resend rejected", resp.status, (await resp.text()).slice(0, 300));
    }
  }
  return allOk;
}

module.exports = { pool, assertEnv, sameOrigin, str, esc, configured, notifyRecipients, EXPECTED_ENV };
