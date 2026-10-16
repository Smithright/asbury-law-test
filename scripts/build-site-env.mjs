// Vercel build step: writes assets/site-env.js for the environment being deployed.
// VERCEL_ENV "production" -> config/booking.json .production; anything else -> .preview.
// Fails the build (Vercel keeps serving the previous deployment) if the URL is missing or malformed,
// or if production would ever embed the preview page.
import { readFileSync, writeFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync(new URL("../config/booking.json", import.meta.url), "utf8"));
const env = process.env.VERCEL_ENV === "production" ? "production" : "preview";
const url = cfg[env];
const ok = /^https:\/\/calendar\.google\.com\/calendar\/appointments\/schedules\/[A-Za-z0-9_-]+$/.test(url || "");
if (!ok) { console.error(`build-site-env: invalid booking URL for ${env}: ${url}`); process.exit(1); }
if (env === "production" && url === cfg.preview) { console.error("build-site-env: production would embed the preview booking page"); process.exit(1); }

writeFileSync(new URL("../assets/site-env.js", import.meta.url),
  `// GENERATED at deploy time by scripts/build-site-env.mjs. Do not edit.\nwindow.ASBURY_ENV = Object.freeze(${JSON.stringify({ env, bookingUrl: url })});\n`);
console.log(`build-site-env: ${env} -> ${url}`);
