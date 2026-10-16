// POST /api/veterans -> inserts one row into veteran_requests (migration 007), then alerts every active
// notification_recipients row, exactly like /api/contact.
const { pool, assertEnv, sameOrigin, str, configured, notifyRecipients } = require("../lib/forms");

const BRANCHES = new Set(["Army", "Navy", "Marine Corps", "Air Force", "Space Force", "Coast Guard", "National Guard / Reserve"]);
const WANTS = new Set(["Free advance directives", "Estate plan", "Membership", "Newsletter"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Checkbox groups arrive as an array or a "a; b" string; keep only known values, in a stable order.
function pick(v, allowed) {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(";") : [];
  const seen = new Set(list.map((x) => String(x).trim()).filter((x) => allowed.has(x)));
  return [...allowed].filter((x) => seen.has(x));
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

  const d = {
    email: str(body.email, 254),
    name: str(body.name, 200) || null,
    branches: pick(body.branch, BRANCHES),
    wants: pick(body.wants, WANTS),
    source_page: str(body.source_page, 200) || null,
  };
  if (!EMAIL.test(d.email)) return res.status(400).json({ ok: false, error: "invalid", fields: ["email"] });

  if (!configured()) {
    console.error("veterans: DATABASE_URL is not configured");
    return res.status(503).json({ ok: false, error: "unavailable" });
  }
  try {
    await assertEnv();
  } catch (e) {
    console.error("veterans:", e && e.message);
    return res.status(503).json({ ok: false, error: "unavailable" });
  }

  let id;
  try {
    const r = await pool.query(
      `insert into veteran_requests (email, name, branches, wants, source_page, user_agent)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [d.email, d.name, d.branches, d.wants, d.source_page, str(req.headers["user-agent"] || "", 400) || null]
    );
    id = r.rows[0].id;
  } catch (e) {
    console.error("veterans: insert failed", e && e.code);
    return res.status(500).json({ ok: false, error: "server_error" });
  }

  // Saved; an alert failure must never become an error for the visitor.
  try {
    const ok = await notifyRecipients({
      kicker: "New veteran request",
      heading: `${d.name || d.email} · Veterans page`,
      subject: `New veteran request: ${d.name || d.email}`,
      rows: [
        ["Name", d.name || "(not given)"],
        ["Email", d.email],
        ["Branch", d.branches.join(", ") || "(not given)"],
        ["Would like", d.wants.join(", ") || "(nothing selected)"],
      ],
      footer: `Request #${id} from asbury-law.com/veterans. Reply to this email to answer directly. Proof of service is not collected by this form.`,
      replyTo: d.email,
    });
    if (ok) await pool.query("update veteran_requests set notified_at = now() where id = $1", [id]);
  } catch (e) {
    console.error("veterans: notify failed", id, e && e.message);
  }
  return res.status(200).json({ ok: true });
};
