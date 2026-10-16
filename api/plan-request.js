// POST /api/plan-request -> inserts one row into plan_requests (migration 008), then alerts every active
// notification_recipients row. Plans and add-ons are validated against config/plans.json.
const { pool, assertEnv, sameOrigin, str, configured, notifyRecipients } = require("../lib/forms");
const { plans } = require("../config/plans.json");

const PLANS = new Map(plans.map((p) => [p.key, p]));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: "forbidden" });

  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (str(body.company, 200)) return res.status(200).json({ ok: true }); // honeypot

  const plan = PLANS.get(str(body.plan, 40));
  const wanted = new Set((Array.isArray(body.addons) ? body.addons : []).map((x) => String(x)));
  const d = {
    plan: plan ? plan.key : "",
    addons: plan ? plan.addons.filter((a) => wanted.has(a.key)).map((a) => a.key) : [],
    first_name: str(body.first_name, 100),
    last_name: str(body.last_name, 100),
    email: str(body.email, 254),
    phone: str(body.phone, 40) || null,
    message: str(body.message, 2000) || null,
    consent: body.consent === true || body.consent === "yes",
    source_page: str(body.source_page, 200) || null,
  };
  const errors = [];
  if (!plan) errors.push("plan");
  if (!d.first_name) errors.push("first_name");
  if (!d.last_name) errors.push("last_name");
  if (!EMAIL.test(d.email)) errors.push("email");
  if (!d.consent) errors.push("consent");
  if (errors.length) return res.status(400).json({ ok: false, error: "invalid", fields: errors });

  if (!configured()) {
    console.error("plan-request: DATABASE_URL is not configured");
    return res.status(503).json({ ok: false, error: "unavailable" });
  }
  try {
    await assertEnv();
  } catch (e) {
    console.error("plan-request:", e && e.message);
    return res.status(503).json({ ok: false, error: "unavailable" });
  }

  let id;
  try {
    const r = await pool.query(
      `insert into plan_requests (plan, addons, first_name, last_name, email, phone, message, consent, source_page, user_agent)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [d.plan, d.addons, d.first_name, d.last_name, d.email, d.phone, d.message, d.consent, d.source_page,
       str(req.headers["user-agent"] || "", 400) || null]
    );
    id = r.rows[0].id;
  } catch (e) {
    console.error("plan-request: insert failed", e && e.code);
    return res.status(500).json({ ok: false, error: "server_error" });
  }

  try {
    const addonText = plan.addons.filter((a) => d.addons.includes(a.key)).map((a) => `${a.label} (${a.price})`).join("; ");
    const ok = await notifyRecipients({
      kicker: "New estate plan request",
      heading: `${d.first_name} ${d.last_name} · ${plan.name} (${plan.price})`,
      subject: `New plan request: ${plan.name} (${d.first_name} ${d.last_name})`,
      rows: [
        ["Plan", `${plan.name} · ${plan.price} flat`],
        ["Add-ons", addonText || "(none)"],
        ["Name", `${d.first_name} ${d.last_name}`],
        ["Email", d.email],
        ["Phone", d.phone || "(not given)"],
      ],
      body: d.message,
      bodyLabel: "Anything we should know",
      footer: `Plan request #${id} from asbury-law.com/estate-planning. Next step: conflict check, then the engagement agreement. Reply to this email to answer ${d.first_name} directly.`,
      replyTo: d.email,
    });
    if (ok) await pool.query("update plan_requests set notified_at = now() where id = $1", [id]);
  } catch (e) {
    console.error("plan-request: notify failed", id, e && e.message);
  }
  return res.status(200).json({ ok: true });
};
