// POST /api/membership-request -> inserts one row into membership_requests (migration 011), then alerts
// every active notification_recipients row via lib/forms.js.
const { pool, assertEnv, sameOrigin, str, configured, notifyRecipients } = require("../lib/forms");

const TIERS = ["Legacy Circle $29", "Counsel Circle $149", "Fortress Circle $349"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[0-9+().\-\s]{7,40}$/;

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

  const wanted = new Set(list(body.tier));
  const d = {
    email: str(body.email, 254),
    phone: str(body.phone, 40) || null,
    tiers: TIERS.filter((x) => wanted.has(x)),
    veteran: body.veteran === true || body.veteran === "yes",
    source_page: str(body.source_page, 200) || null,
  };
  const bad = [];
  if (!EMAIL.test(d.email)) bad.push("email");
  if (d.phone && (!PHONE.test(d.phone) || d.phone.replace(/\D/g, "").length < 7)) bad.push("phone");
  if (bad.length) return res.status(400).json({ ok: false, error: "invalid", fields: bad });

  if (!configured()) {
    console.error("membership-request: DATABASE_URL is not configured");
    return res.status(503).json({ ok: false, error: "unavailable" });
  }
  try {
    await assertEnv();
  } catch (e) {
    console.error("membership-request:", e && e.message);
    return res.status(503).json({ ok: false, error: "unavailable" });
  }

  let id;
  try {
    const r = await pool.query(
      `insert into membership_requests (email, phone, tiers, veteran, source_page, user_agent)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [d.email, d.phone, d.tiers, d.veteran, d.source_page, str(req.headers["user-agent"] || "", 400) || null]
    );
    id = r.rows[0].id;
  } catch (e) {
    console.error("membership-request: insert failed", e && e.code);
    return res.status(500).json({ ok: false, error: "server_error" });
  }

  try {
    const tiers = d.tiers.join(", ") || "(none selected)";
    const ok = await notifyRecipients({
      kicker: "New membership request",
      heading: `${d.email} · ${tiers}`,
      subject: `New membership request: ${d.email}`,
      rows: [
        ["Email", d.email],
        ["Phone", d.phone || "(not given)"],
        ["Interested in", tiers],
        ["Veteran", d.veteran ? "Yes (10% off)" : "No"],
      ],
      footer: `Request #${id} from asbury-law.com/attorney-on-retainer. Reply to this email to answer directly.`,
      replyTo: d.email,
    });
    if (ok) await pool.query("update membership_requests set notified_at = now() where id = $1", [id]);
  } catch (e) {
    console.error("membership-request: notify failed", id, e && e.message);
  }
  return res.status(200).json({ ok: true });
};
