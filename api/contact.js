// POST /api/contact -> inserts one row into contact_submissions (Neon Postgres).
// APP_DATABASE_URL (pooled), set per Vercel environment by ops/precutover.sh; falls back to the Neon integration DATABASE_URL. Never in the repo.
const { Pool } = require("pg");
const { attachDatabasePool } = require("@vercel/functions");

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL || process.env.DATABASE_URL, max: 5 });
attachDatabasePool(pool);

// Fail closed: the database must declare the environment this deployment belongs to
// (migration 005). Production deployments write only to env:production, everything else only to env:testing.
const EXPECTED_ENV = process.env.VERCEL_ENV === "production" ? "env:production" : "env:testing";
let envVerified = false;
async function assertEnv() {
  if (envVerified) return;
  const { rows } = await pool.query("select obj_description('public'::regnamespace) as env");
  const got = rows[0] && rows[0].env;
  if (got !== EXPECTED_ENV) throw new Error(`wrong database for this deployment: ${got}, expected ${EXPECTED_ENV}`);
  envVerified = true;
}

const TOPICS = new Set([
  "Estate planning",
  "Attorney on Retainer membership",
  "On-demand legal documents",
  "Estate planning for veterans",
  "Legacy Vault",
  "Something else",
]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(v, max) {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

// Behind the load balancer the Host header is the slot (blue./green.) while Origin is asbury-law.com,
// so accept any origin on the committed allowlist, plus same-host (Vercel preview URLs).
const ALLOWED_HOSTS = new Set(require("../config/hosts.json").allowed);
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients; still validated below
  try {
    const host = new URL(origin).host;
    return host === req.headers.host || ALLOWED_HOSTS.has(host);
  } catch {
    return false;
  }
}

function validate(body) {
  const d = {
    first_name: str(body.first_name, 100),
    last_name: str(body.last_name, 100),
    email: str(body.email, 254),
    phone: str(body.phone, 40) || null,
    topic: str(body.topic, 80),
    message: str(body.message, 5000),
    preferred_contact: body.preferred_contact === "phone" ? "phone" : "email",
    consent: body.consent === true || body.consent === "yes",
    source_page: str(body.source_page, 200) || null,
  };
  const errors = [];
  if (!d.first_name) errors.push("first_name");
  if (!d.last_name) errors.push("last_name");
  if (!EMAIL.test(d.email)) errors.push("email");
  if (!TOPICS.has(d.topic)) errors.push("topic");
  if (!d.message) errors.push("message");
  if (!d.consent) errors.push("consent");
  return { d, errors };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: "forbidden" });

  const body = req.body && typeof req.body === "object" ? req.body : {};
  // Honeypot: bots fill the hidden "company" field. Pretend success, store nothing.
  if (str(body.company, 200)) return res.status(200).json({ ok: true });

  const { d, errors } = validate(body);
  if (errors.length) return res.status(400).json({ ok: false, error: "invalid", fields: errors });

  if (!(process.env.APP_DATABASE_URL || process.env.DATABASE_URL)) {
    console.error("contact: DATABASE_URL is not configured");
    return res.status(503).json({ ok: false, error: "unavailable" });
  }

  try {
    await assertEnv();
  } catch (e) {
    console.error("contact:", e && e.message);
    return res.status(503).json({ ok: false, error: "unavailable" });
  }

  let id;
  try {
    const r = await pool.query(
      `insert into contact_submissions
         (first_name, last_name, email, phone, topic, message, preferred_contact, consent, source_page, user_agent)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning id`,
      [d.first_name, d.last_name, d.email, d.phone, d.topic, d.message, d.preferred_contact, d.consent,
       d.source_page, str(req.headers["user-agent"] || "", 400) || null]
    );
    id = r.rows[0].id;
  } catch (e) {
    console.error("contact: insert failed", e && e.code);
    return res.status(500).json({ ok: false, error: "server_error" });
  }

  // The message is saved; an alert failure must never turn that into an error for the visitor.
  try {
    await notify(id, d);
  } catch (e) {
    console.error("contact: notify failed", id, e && e.message);
  }
  return res.status(200).json({ ok: true });
};

// ---- notifications (Resend, key injected by the Vercel integration) ----
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function emailBody(id, d, includeMessage) {
  const rows = [
    ["Name", `${d.first_name} ${d.last_name}`],
    ["Email", d.email],
    ["Phone", d.phone || "(not given)"],
    ["Topic", d.topic],
    ["Prefers", d.preferred_contact],
  ];
  const text =
    rows.map(([k, v]) => `${k}: ${v}`).join("\n") +
    (includeMessage ? `\n\nMessage:\n${d.message}` : "\n\n(Message text is in the database: contact_submissions #" + id + ")") +
    `\n\nSubmission #${id} from asbury-law.com/contact. Reply to this email to answer ${d.first_name} directly.`;
  const html =
    `<div style="font-family:Georgia,serif;color:#2A2520;max-width:560px">` +
    `<p style="font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:#9B7F2E;margin:0 0 6px">New website message</p>` +
    `<h2 style="font-weight:500;margin:0 0 16px">${esc(d.first_name)} ${esc(d.last_name)} &middot; ${esc(d.topic)}</h2>` +
    `<table style="font-family:Arial,sans-serif;font-size:14px;border-collapse:collapse">` +
    rows.map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#8A8278">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`).join("") +
    `</table>` +
    (includeMessage
      ? `<p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap;background:#F2EDE4;padding:14px 16px;border-left:3px solid #C9A84C;margin:18px 0">${esc(d.message)}</p>`
      : `<p style="font-family:Arial,sans-serif;font-size:14px;color:#8A8278">Message text is in the database (contact_submissions #${id}).</p>`) +
    `<p style="font-family:Arial,sans-serif;font-size:12px;color:#8A8278">Submission #${id}. Reply to this email to answer ${esc(d.first_name)} directly.</p></div>`;
  return { text, html };
}

async function notify(id, d) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error("contact: RESEND_API_KEY is not configured; alert skipped", id);
    return;
  }
  const { rows } = await pool.query(
    "select email, include_message from notification_recipients where active order by id"
  );
  if (!rows.length) {
    console.error("contact: no active notification recipients", id);
    return;
  }
  const domain = process.env.RESEND_EMAIL_DOMAIN || "asbury-law.com";
  const from = process.env.NOTIFY_FROM || `Asbury Law Website <notifications@${domain}>`;
  let allOk = true;
  for (const r of rows) {
    const { text, html } = emailBody(id, d, r.include_message);
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [r.email],
        reply_to: d.email,
        subject: `New website message: ${d.topic} (${d.first_name} ${d.last_name})`,
        text,
        html,
      }),
    });
    if (!resp.ok) {
      allOk = false;
      console.error("contact: resend rejected", id, resp.status, (await resp.text()).slice(0, 300));
    }
  }
  if (allOk) await pool.query("update contact_submissions set notified_at = now() where id = $1", [id]);
}
