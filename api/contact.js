// POST /api/contact -> inserts one row into contact_submissions (Neon Postgres), then alerts every active
// notification_recipients row. Database, environment check, origin allowlist and alerts: lib/forms.js.
const { pool, assertEnv, sameOrigin, str, configured, notifyRecipients } = require("../lib/forms");

const TOPICS = new Set([
  "Estate planning",
  "Attorney on Retainer membership",
  "On-demand legal documents",
  "Estate planning for veterans",
  "Legacy Vault",
  "Something else",
]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;



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

  if (!configured()) {
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

async function notify(id, d) {
  const ok = await notifyRecipients({
    kicker: "New website message",
    heading: `${d.first_name} ${d.last_name} · ${d.topic}`,
    subject: `New website message: ${d.topic} (${d.first_name} ${d.last_name})`,
    rows: [
      ["Name", `${d.first_name} ${d.last_name}`],
      ["Email", d.email],
      ["Phone", d.phone || "(not given)"],
      ["Topic", d.topic],
      ["Prefers", d.preferred_contact],
    ],
    body: d.message,
    footer: `Submission #${id} from asbury-law.com/contact. Reply to this email to answer ${d.first_name} directly.`,
    replyTo: d.email,
  });
  if (ok) await pool.query("update contact_submissions set notified_at = now() where id = $1", [id]);
}
