// POST /api/document-request -> inserts one row into document_requests (migration 009), then alerts every
// active notification_recipients row via lib/forms.js.
const { pool, assertEnv, sameOrigin, str, configured, notifyRecipients } = require("../lib/forms");

const INTERESTS = ["New documents launch", "Newsletter", "Veterans", "Attorney on Retainer"];
const DOC = /^(?:[a-z0-9-]{1,40}|bundle:[A-Za-z0-9 &'-]{1,60})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function list(v) {
  return Array.isArray(v) ? v.map((x) => String(x).trim()) : typeof v === "string" ? v.split(";").map((x) => x.trim()) : [];
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: "forbidden" });

  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (str(body.company, 200)) return res.status(200).json({ ok: true }); // honeypot

  const wantedInterests = new Set(list(body.interests));
  const d = {
    email: str(body.email, 254),
    name: str(body.name, 200) || null,
    interests: INTERESTS.filter((x) => wantedInterests.has(x)),
    documents: [...new Set(list(body.docs).filter((x) => DOC.test(x)))].slice(0, 40),
    message: str(body.message, 2000) || null,
    source_page: str(body.source_page, 200) || null,
  };
  if (!EMAIL.test(d.email)) return res.status(400).json({ ok: false, error: "invalid", fields: ["email"] });

  if (!configured()) {
    console.error("document-request: DATABASE_URL is not configured");
    return res.status(503).json({ ok: false, error: "unavailable" });
  }
  try {
    await assertEnv();
  } catch (e) {
    console.error("document-request:", e && e.message);
    return res.status(503).json({ ok: false, error: "unavailable" });
  }

  let id;
  try {
    const r = await pool.query(
      `insert into document_requests (email, name, interests, documents, message, source_page, user_agent)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [d.email, d.name, d.interests, d.documents, d.message, d.source_page, str(req.headers["user-agent"] || "", 400) || null]
    );
    id = r.rows[0].id;
  } catch (e) {
    console.error("document-request: insert failed", e && e.code);
    return res.status(500).json({ ok: false, error: "server_error" });
  }

  try {
    const label = (x) => x.replace(/^bundle:/, "") + (x.startsWith("bundle:") ? " (bundle)" : "");
    const ok = await notifyRecipients({
      kicker: "New document request",
      heading: `${d.name || d.email} · ${d.documents.length} document${d.documents.length === 1 ? "" : "s"}`,
      subject: `New document request: ${d.name || d.email}`,
      rows: [
        ["Name", d.name || "(not given)"],
        ["Email", d.email],
        ["Documents", d.documents.map(label).join(", ") || "(none selected)"],
        ["Also wants", d.interests.join(", ") || "(nothing selected)"],
      ],
      body: d.message,
      bodyLabel: "Anything specific to build",
      footer: `Document request #${id} from asbury-law.com/documents. Reply to this email to answer directly.`,
      replyTo: d.email,
    });
    if (ok) await pool.query("update document_requests set notified_at = now() where id = $1", [id]);
  } catch (e) {
    console.error("document-request: notify failed", id, e && e.message);
  }
  return res.status(200).json({ ok: true });
};
