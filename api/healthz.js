// GET /api/healthz -> load-balancer health check for a slot.
// 200 only if the database answers AND declares the environment this deployment belongs to.
const { Pool } = require("pg");
const { attachDatabasePool } = require("@vercel/functions");

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL || process.env.DATABASE_URL, max: 2 });
attachDatabasePool(pool);

const EXPECTED_ENV = process.env.VERCEL_ENV === "production" ? "env:production" : "env:staging";
const REF = process.env.VERCEL_GIT_COMMIT_REF || "";
const SLOT = REF.startsWith("release-") ? REF.slice("release-".length) : REF || "unknown";

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const body = { slot: SLOT, build: (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 12) };
  try {
    if (!(process.env.APP_DATABASE_URL || process.env.DATABASE_URL)) throw new Error("DATABASE_URL not configured");
    const { rows } = await pool.query("select obj_description('public'::regnamespace) as env");
    const env = rows[0] && rows[0].env;
    if (env !== EXPECTED_ENV) throw new Error(`wrong database: ${env}`);
    return res.status(200).json({ ok: true, ...body });
  } catch (e) {
    console.error("healthz:", e && e.message);
    return res.status(503).json({ ok: false, ...body });
  }
};
