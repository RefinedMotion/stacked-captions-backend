/**
 * Stacked Captions — Backend (Phase 4a)
 *
 * Cloudflare Worker + D1.
 *
 *   POST /v1/activate              { licenseKey, fingerprint, os?, appVersion? }
 *   POST /v1/heartbeat             { licenseKey, fingerprint }
 *   POST /v1/ai-apply              { token, system, messages, model?, max_tokens? }
 *   POST /v1/transcribe            multipart: token, audio, language_code?, diarize?
 *   POST /v1/check-update          { token, currentVersion, platform }
 *   GET  /v1/download-installer    ?token=…&platform=…&assetId=…  (302 to GitHub CDN)
 *   POST /v1/webhooks/lemon-squeezy  (HMAC-signed by LS)
 *   POST /v1/admin/create-license  (admin — Bearer ADMIN_TOKEN required)
 *   GET  /v1/admin/find-license    (admin — exact email match)
 *   GET  /v1/admin/list-licenses   (admin — filters + free-text search)
 *   GET  /v1/admin/customer-detail (admin — deep dive: events + machines + AI rollup)
 *   POST /v1/machines         (list the machines of a license; key = credential)
 *   POST /v1/deactivate       (release a machine slot: the caller's own, or one by row id)
 *   POST /v1/admin/remove-machine      (admin — free a slot for a customer)
 *   POST /v1/admin/set-license-status  (admin — correct a license status, e.g. LS "unpaid" leftovers)
 *
 * Auth flow:
 *   1. Plugin calls /v1/activate with the user's license key + a machine
 *      fingerprint. Server checks license + machine cap, then issues a
 *      signed HMAC token (24h expiry).
 *   2. Plugin caches the token locally. For each AI call, plugin sends
 *      the token to /v1/ai-apply; server verifies signature + expiry,
 *      re-checks license status in DB, then proxies to Anthropic.
 *   3. Every 4h (or whenever the user opens the panel after a long
 *      break), plugin calls /v1/heartbeat to refresh the token.
 *   4. If token expires AND no heartbeat succeeds for >7 days, the
 *      plugin locks itself (handled in Phase 4b on the plugin side).
 */

import { Hono } from "hono";
import { cors } from "hono/cors";

const app = new Hono();

// CEP panels run on an internal origin; permissive CORS is fine here
// (nothing we return is sensitive to other origins).
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"]
}));

// ============================================================================
// Time + helpers
// ============================================================================
const TOKEN_TTL_SECONDS = 24 * 60 * 60; // 24h
const nowMs  = () => Date.now();
const nowSec = () => Math.floor(Date.now() / 1000);

// Base64url (no padding) — used to encode token payloads + signatures.
function b64uEncode(input) {
  const bytes = input instanceof Uint8Array ? input : new TextEncoder().encode(input);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uDecodeToString(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return atob(str);
}

// HMAC-SHA256 via Web Crypto (built into Workers).
async function hmacSign(payload, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return b64uEncode(new Uint8Array(sig));
}

async function issueToken(payload, secret) {
  const full = { ...payload, iat: nowSec(), exp: nowSec() + TOKEN_TTL_SECONDS };
  const payloadB64 = b64uEncode(JSON.stringify(full));
  const sig = await hmacSign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

async function verifyToken(token, secret) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payloadB64, sig] = token.split(".");
  const expectedSig = await hmacSign(payloadB64, secret);
  if (sig !== expectedSig) return null;
  let payload;
  try { payload = JSON.parse(b64uDecodeToString(payloadB64)); }
  catch { return null; }
  if (payload.exp && nowSec() > payload.exp) return null;
  return payload;
}

// License keys: SC-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX (24 chars in 6 dashed groups,
// no easily-confused letters like 0/O, 1/I/L).
function randomLicenseKey() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let out = "";
  for (let i = 0; i < 24; i++) out += alphabet[bytes[i] % alphabet.length];
  return "SC-" + out.match(/.{1,4}/g).join("-");
}

// License sanity check (used by /activate, /heartbeat, /ai-apply).
async function findLicense(db, key) {
  return await db.prepare("SELECT * FROM licenses WHERE key = ?").bind(key).first();
}

// ---- Machine slots -------------------------------------------------------
// A slot whose machine has not been seen for this long yields to a new
// machine on /activate (a replaced or reinstalled computer) — the customer
// never has to free it by hand.
const MACHINE_IDLE_EVICT_MS = 30 * 24 * 60 * 60 * 1000;

// One-way display id of a machine: the first 8 hex digits of SHA-256 of the
// fingerprint. The panel shows it and support asks customers to read it out.
// The raw fingerprint is never returned to the panel: together with the key
// it would let a third computer impersonate a registered one on /v1/heartbeat
// and use the AI proxy without taking a slot.
async function machineDisplayId(fingerprint) {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(fingerprint || "")));
    const bytes = new Uint8Array(buf);
    let hex = "";
    for (let i = 0; i < 4; i++) hex += bytes[i].toString(16).padStart(2, "0");
    return hex;
  } catch (e) { return ""; }
}
// Machine rows as the panel shows them; the row id is what the panel releases
// a slot by, `current` marks the calling machine.
async function machineView(m, currentFp) {
  return {
    id:          m.id,
    displayId:   await machineDisplayId(m.fingerprint),
    os:          m.os || "",
    appVersion:  m.app_version || "",
    firstSeenAt: m.first_seen_at || null,
    lastSeenAt:  m.last_seen_at || null,
    current:     !!currentFp && m.fingerprint === currentFp
  };
}
async function machineViews(rows, currentFp) {
  const out = [];
  for (const m of rows) out.push(await machineView(m, currentFp));
  return out;
}
async function listMachines(db, licenseKey, currentFp) {
  const rs = await db.prepare(
    "SELECT * FROM machines WHERE license_key = ? ORDER BY last_seen_at DESC, id ASC"
  ).bind(licenseKey).all();
  return await machineViews(rs.results || [], currentFp);
}
// Resolves the machine a deactivation targets. Self-service: the row id or
// the caller's EXACT fingerprint. Admin (allowPrefix): additionally a display
// id or a unique fingerprint prefix (LIKE with escaped wildcards). null = none.
async function findMachine(db, licenseKey, opts) {
  opts = opts || {};
  const id = parseInt(opts.machineId, 10);
  if (id > 0) {
    return await db.prepare("SELECT * FROM machines WHERE id = ? AND license_key = ?").bind(id, licenseKey).first();
  }
  const fp = String(opts.fingerprint || "").trim();
  if (fp) {
    const exact = await db.prepare("SELECT * FROM machines WHERE license_key = ? AND fingerprint = ?").bind(licenseKey, fp).first();
    if (exact || !opts.allowPrefix || fp.length < 8) return exact;
    const like = fp.replace(/[\\%_]/g, "\\$&") + "%";
    const rs = await db.prepare("SELECT * FROM machines WHERE license_key = ? AND fingerprint LIKE ? ESCAPE '\\'").bind(licenseKey, like).all();
    const hits = rs.results || [];
    return hits.length === 1 ? hits[0] : null;
  }
  const disp = String(opts.displayId || "").trim().toLowerCase();
  if (disp && opts.allowPrefix) {
    const all = await db.prepare("SELECT * FROM machines WHERE license_key = ?").bind(licenseKey).all();
    for (const m of (all.results || [])) {
      if ((await machineDisplayId(m.fingerprint)) === disp) return m;
    }
  }
  return null;
}
async function releaseMachine(db, licenseKey, machine, detail) {
  await db.prepare("DELETE FROM machines WHERE id = ?").bind(machine.id).run();
  await logEvent(db, {
    licenseKey, email: null,
    eventType:  "machine_deactivated",
    detail:     Object.assign({ fingerprint: String(machine.fingerprint || "").slice(0, 14), machineId: machine.id, os: machine.os || "", lastSeenAt: machine.last_seen_at || null }, detail || {})
  });
}

async function logEvent(db, { licenseKey, email, eventType, detail, costMicroUsd }) {
  try {
    await db.prepare(`
      INSERT INTO events (created_at, license_key, email, event_type, detail, cost_micro_usd)
      VALUES             (?,          ?,           ?,     ?,          ?,      ?              )
    `).bind(
      nowMs(),
      licenseKey || null,
      email || null,
      String(eventType || "unknown"),
      detail ? JSON.stringify(detail) : null,
      costMicroUsd || 0
    ).run();
  } catch (e) {
    // Most common reason: events table doesn't exist yet (migration not run).
    // Don't surface to the user — telemetry should fail silently.
    console.warn("logEvent failed:", e && e.message);
  }
}

// Claude Haiku 4.5 cost per 1M tokens (in USD), as of late 2025/2026:
//   Input  : $1.00 / 1M  ->  1.00  µUSD per token
//   Output : $5.00 / 1M  ->  5.00  µUSD per token
//   Cache create (read-once setup) : $1.25 / 1M -> 1.25 µUSD per token
//   Cache read   (cached, replayed): $0.10 / 1M -> 0.10 µUSD per token
// If we move to a different Anthropic model, update these rates.
function calcCostMicroUsd(usage) {
  if (!usage || typeof usage !== "object") return 0;
  const cost =
    (usage.input_tokens                || 0) * 1.0  +
    (usage.output_tokens               || 0) * 5.0  +
    (usage.cache_creation_input_tokens || 0) * 1.25 +
    (usage.cache_read_input_tokens     || 0) * 0.10;
  return Math.ceil(cost); // round up to whole µUSD (favors us by a fraction of a cent)
}

// Returns the next monthly anniversary of `anchorMs` after `fromMs`, at
// 00:00 UTC. The anchor is typically the license's created_at — so a license
// minted on Jun 15 resets on Jul 15, Aug 15, etc. If the anchor's day-of-
// month doesn't exist in the target month (e.g. anchor day 31 in February),
// we clamp to the last day of that month (so a Jan-31 license resets on
// Feb 28/29, Mar 31, Apr 30, ...).
function nextAnniversaryResetUtcMs(anchorMs, fromMs) {
  const anchorDay = new Date(anchorMs).getUTCDate();   // 1..31
  const from      = new Date(fromMs);
  let year        = from.getUTCFullYear();
  let month       = from.getUTCMonth();                // 0..11

  // Walk forward month-by-month until we find one whose anniversary instant
  // is strictly in the future. Safety bound of 13 iterations covers the
  // worst case (anchor day in past month → up to a year of skips).
  for (let i = 0; i < 13; i++) {
    const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const day            = Math.min(anchorDay, lastDayOfMonth);
    const candidate      = Date.UTC(year, month, day, 0, 0, 0, 0);
    if (candidate > fromMs) return candidate;
    // Advance one month
    month += 1;
    if (month > 11) { month = 0; year += 1; }
  }
  // Should be unreachable; fallback ~30d in case of pathological input
  return fromMs + 30 * 24 * 60 * 60 * 1000;
}

// Reads the STANDING monthly budget in µUSD from env (MONTHLY_AI_BUDGET_USD).
// As of v1.0.7 this is the NEW/low budget (env = "1.00" → 1,000,000). The 4.05
// fallback only applies if the env var is missing/invalid (fail-safe: never
// under-provision). Existing customers get the legacy budget via
// licenseBudgetMicroUsd() below, not this raw value.
function monthlyBudgetMicroUsd(env) {
  const raw = parseFloat(env && env.MONTHLY_AI_BUDGET_USD);
  const usd = (isFinite(raw) && raw > 0) ? raw : 4.05;
  return Math.round(usd * 1_000_000);
}

// Annual-plan monthly budget (ANNUAL_AI_BUDGET_USD, default $2.00 →
// 2,000,000 tokens). Purchase incentive for the annual subscription —
// applies to every license whose plan is "annual", INCLUDING trials on the
// annual plan (deliberate: the trial should show the full annual experience).
function annualBudgetMicroUsd(env) {
  const raw = parseFloat(env && env.ANNUAL_AI_BUDGET_USD);
  const usd = (isFinite(raw) && raw > 0) ? raw : 2.00;
  return Math.round(usd * 1_000_000);
}

// v1.0.7 (2026-07-13): the standing AI quota was cut from 4,050,000 to
// 1,000,000 tokens/month. Existing customers are GRANDFATHERED — they keep the
// legacy 4,050,000 budget until the end of their CURRENT monthly cycle, then
// drop to the new budget on their next cycle; anyone who buys at/after the
// patch gets the new budget from day one. This is derived purely from the
// license's created_at + the fixed patch epoch below (NO DB column/migration
// needed) → deterministic, backward-compatible, tamper-proof. Knobs: set
// QUOTA_PATCH_EPOCH_MS = 0 to flip EVERYONE to the new budget immediately, or
// bump MONTHLY_AI_BUDGET_USD to change the new budget.
const QUOTA_PATCH_EPOCH_MS    = 1783945116581; // 2026-07-13T12:18:36.581Z
const LEGACY_BUDGET_MICRO_USD = 4_050_000;     // grandfathered monthly budget

function licenseBudgetMicroUsd(env, lic) {
  // Standing budget by plan: annual subscriptions (incl. trial-on-annual)
  // get the higher annual budget — everyone else the standard monthly one.
  const standing = (lic && lic.plan === "annual")
    ? annualBudgetMicroUsd(env)
    : monthlyBudgetMicroUsd(env);
  if (!lic || !lic.created_at) return standing;
  // Bought at/after the patch → standing budget from the start.
  if (lic.created_at >= QUOTA_PATCH_EPOCH_MS) return standing;
  // Existing customer → keep the legacy budget until the first monthly
  // anniversary reset at/after the patch (= end of their current cycle).
  // Math.max so a plan whose standing budget exceeds the legacy value could
  // never be DOWNgraded by the grandfather window.
  const boundary = nextAnniversaryResetUtcMs(lic.created_at, QUOTA_PATCH_EPOCH_MS);
  return nowMs() < boundary ? Math.max(LEGACY_BUDGET_MICRO_USD, standing) : standing;
}

// v1.0.7: past_due customers get a bounded SOFT GRACE — the license stays
// fully usable for PAST_DUE_GRACE_MS after the first failed charge, then the
// plugin is PAUSED until the payment recovers (the LS webhook flips status back
// to 'active', which un-pauses automatically). The grace is anchored to
// `past_due_since` (stamped when the license first entered past_due).
const PAST_DUE_GRACE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

function isLicenseUsable(lic) {
  if (!lic) return false;
  if (lic.status === "past_due") {
    // Fail OPEN if we somehow have no timestamp — never hard-lock a customer
    // over a missing field. Normally past_due_since is always set (webhooks).
    if (!lic.past_due_since) return true;
    return (nowMs() - lic.past_due_since) < PAST_DUE_GRACE_MS;
  }
  // "cancelled" customers keep access until their current paid period ends —
  // the expires_at check below catches that.
  if (!["active", "trial", "cancelled"].includes(lic.status)) return false;
  if (lic.expires_at && lic.expires_at < nowMs()) return false;
  return true;
}

// True when the license is in its past_due grace window (usable-but-warned).
function pastDueGraceEndsAt(lic) {
  if (!lic || lic.status !== "past_due" || !lic.past_due_since) return null;
  return lic.past_due_since + PAST_DUE_GRACE_MS;
}

// ============================================================================
// Routes
// ============================================================================

// ---------------------------------------------------------------------------
// Upstream retry for TRANSIENT errors. Anthropic occasionally returns HTTP 529
// "overloaded_error" (servers at capacity); providers can also emit 429 / 5xx.
// These are transient and safe to retry — a failed call produced no completion
// and no charge. Exponential backoff + jitter, honouring a numeric Retry-After
// (seconds). 4xx request errors are NOT retried (retrying won't help).
// ---------------------------------------------------------------------------
const RETRYABLE_UPSTREAM = new Set([429, 500, 502, 503, 504, 529]);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
function backoffMs(baseMs, attempt) {
  const exp = baseMs * Math.pow(2, attempt - 1);                 // 500,1000,2000,...
  return Math.min(exp, 8000) + Math.floor(Math.random() * 250); // + jitter, cap 8s
}
async function fetchWithRetry(url, init, opts) {
  const maxAttempts = (opts && opts.maxAttempts) || 4;
  const baseMs      = (opts && opts.baseMs)      || 500;
  let attempt = 0;
  while (true) {
    attempt++;
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (attempt >= maxAttempts) throw e;                       // network-level error
      await sleep(backoffMs(baseMs, attempt));
      continue;
    }
    if (!RETRYABLE_UPSTREAM.has(res.status) || attempt >= maxAttempts) {
      return { res, attempts: attempt };
    }
    // Free the errored connection before retrying.
    try { if (res.body) await res.body.cancel(); } catch (e) {}
    const ra     = parseInt(res.headers.get("retry-after") || "", 10);
    const waitMs = (isFinite(ra) && ra > 0) ? Math.min(ra * 1000, 8000) : backoffMs(baseMs, attempt);
    await sleep(waitMs);
  }
}

app.get("/", (c) => c.json({
  ok: true,
  name: "stacked-captions-api",
  version: "0.1.0",
  env: c.env.APP_ENV || "unknown"
}));

// ---------------------------------------------------------------------------
// Admin: create a license for testing (will be replaced by Lemon Squeezy
// webhooks in Phase 4c — for now we manually create licenses via curl).
// ---------------------------------------------------------------------------
app.post("/v1/admin/create-license", async (c) => {
  const auth = c.req.header("Authorization") || "";
  const expected = `Bearer ${c.env.ADMIN_TOKEN}`;
  if (!c.env.ADMIN_TOKEN || auth !== expected) {
    return c.json({ error: "unauthorized" }, 401);
  }
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "invalid JSON" }, 400); }

  const email = String(body.email || "").toLowerCase().trim();
  if (!email) return c.json({ error: "email required" }, 400);

  const plan             = String(body.plan || "trial");
  const status           = String(body.status || "active");
  const machinesAllowed  = parseInt(body.machinesAllowed, 10) || 2;
  const days             = parseInt(body.days, 10) || 30;
  const expiresAt        = body.expiresAt != null
                              ? parseInt(body.expiresAt, 10)
                              : nowMs() + days * 24 * 60 * 60 * 1000;

  const db = c.env.DB;

  // Upsert user
  let user = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
  if (!user) {
    await db.prepare("INSERT INTO users (email, created_at) VALUES (?, ?)")
            .bind(email, nowMs()).run();
    user = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
  }

  const key = randomLicenseKey();
  const ts = nowMs();
  await db.prepare(`
    INSERT INTO licenses (key, user_id, status, plan, expires_at, machines_allowed, created_at, updated_at)
    VALUES               (?,    ?,       ?,      ?,    ?,          ?,                ?,          ?         )
  `).bind(key, user.id, status, plan, expiresAt, machinesAllowed, ts, ts).run();

  await logEvent(db, {
    licenseKey: key, email,
    eventType:  "license_minted",
    detail:     { source: "admin", plan, status, machinesAllowed, expiresAt }
  });

  return c.json({ ok: true, licenseKey: key, plan, status, expiresAt, machinesAllowed });
});

// ---------------------------------------------------------------------------
// Activate (first-time) or re-bind a machine to an existing license.
// Returns a 24h signed token the plugin uses for subsequent /ai-apply calls.
// ---------------------------------------------------------------------------
app.post("/v1/activate", async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "invalid JSON" }, 400); }

  const licenseKey  = String(body.licenseKey  || "").trim().toUpperCase();
  const fingerprint = String(body.fingerprint || "").trim();
  const os          = String(body.os          || "").slice(0, 80);
  const appVersion  = String(body.appVersion  || "").slice(0, 40);
  if (!licenseKey || !fingerprint) {
    return c.json({ error: "licenseKey and fingerprint required" }, 400);
  }

  const db = c.env.DB;
  const lic = await findLicense(db, licenseKey);
  if (!lic)                  return c.json({ error: "license not found" }, 404);
  if (!isLicenseUsable(lic)) return c.json({ error: "license " + lic.status, status: lic.status }, 403);

  // Existing machines for this license
  const rs = await db.prepare("SELECT * FROM machines WHERE license_key = ?")
                     .bind(licenseKey).all();
  const machines = rs.results || [];
  const existing = machines.find(m => m.fingerprint === fingerprint);
  const allowed  = lic.machines_allowed || 2;

  if (!existing && machines.length >= allowed) {
    // The longest-idle machine yields its slot when it has not been seen for
    // 30 days (replaced / reinstalled computer); otherwise the panel gets the
    // list and lets the customer sign one of them out.
    const idle = machines.slice().sort((a, b) => (a.last_seen_at || 0) - (b.last_seen_at || 0))[0];
    if (idle && (nowMs() - (idle.last_seen_at || 0)) > MACHINE_IDLE_EVICT_MS) {
      await releaseMachine(db, licenseKey, idle, { reason: "idle_evicted", replacedBy: fingerprint.slice(0, 14), os: idle.os || "" });
      machines.splice(machines.indexOf(idle), 1);
    } else {
      return c.json({
        error:           "machine limit reached",
        machinesUsed:    machines.length,
        machinesAllowed: allowed,
        machines:        await machineViews(machines, fingerprint),
        hint:            "Sign out one of the listed machines (License & Account > Manage machines) to free a slot."
      }, 403);
    }
  }

  const ts = nowMs();
  if (existing) {
    await db.prepare(
      "UPDATE machines SET last_seen_at = ?, os = ?, app_version = ? WHERE id = ?"
    ).bind(ts, os, appVersion, existing.id).run();
  } else {
    await db.prepare(`
      INSERT INTO machines (license_key, fingerprint, os, app_version, first_seen_at, last_seen_at)
      VALUES                (?,           ?,           ?,  ?,           ?,             ?           )
    `).bind(licenseKey, fingerprint, os, appVersion, ts, ts).run();
    // Log only NEW machines — re-activations from same fingerprint are noise.
    await logEvent(db, {
      licenseKey, email: null,
      eventType:  "machine_activated",
      detail:     { fingerprint, os, appVersion }
    });
  }

  // Rate-limit snapshot for activate response (same logic as heartbeat)
  const budgetMicroUsd2 = licenseBudgetMicroUsd(c.env, lic);
  let aiCostMonth2  = lic.ai_cost_today_micro_usd || 0;
  let aiCallsMonth2 = lic.ai_calls_today || 0;
  let aiResetAt2    = lic.ai_calls_reset_at || 0;
  if (aiResetAt2 <= nowMs()) {
    aiCostMonth2  = 0;
    aiCallsMonth2 = 0;
    aiResetAt2    = nextAnniversaryResetUtcMs(lic.created_at || nowMs(), nowMs());
    // Persist (mirrors heartbeat behavior for consistency)
    await db.prepare(
      "UPDATE licenses SET ai_cost_today_micro_usd = 0, ai_calls_today = 0, ai_calls_reset_at = ?, updated_at = ? WHERE key = ?"
    ).bind(aiResetAt2, nowMs(), licenseKey).run();
  }

  const token = await issueToken({ key: licenseKey, fp: fingerprint }, c.env.TOKEN_SECRET);
  return c.json({
    ok:                       true,
    token,
    tokenExpiresAt:           nowMs() + TOKEN_TTL_SECONDS * 1000,
    licenseExpiresAt:         lic.expires_at,
    plan:                     lic.plan,
    status:                   lic.status,
    machinesUsed:             existing ? machines.length : machines.length + 1,
    machinesAllowed:          allowed,
    aiCostThisMonthMicroUsd:  aiCostMonth2,
    aiCostLimitMicroUsd:      budgetMicroUsd2,
    aiCallsThisMonth:         aiCallsMonth2,    // informational only
    aiCostResetAt:            aiResetAt2,
    paymentPastDue:           lic.status === "past_due",
    pastDueGraceEndsAt:       pastDueGraceEndsAt(lic)
  });
});

// ---------------------------------------------------------------------------
// Heartbeat — refresh the token, re-verify license + machine. Plugin calls
// this every few hours and on panel-open after a long break.
// ---------------------------------------------------------------------------
app.post("/v1/heartbeat", async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "invalid JSON" }, 400); }

  const licenseKey  = String(body.licenseKey  || "").trim().toUpperCase();
  const fingerprint = String(body.fingerprint || "").trim();
  if (!licenseKey || !fingerprint) {
    return c.json({ error: "licenseKey and fingerprint required" }, 400);
  }

  const db = c.env.DB;
  const lic = await findLicense(db, licenseKey);
  if (!lic)                  return c.json({ error: "license not found" }, 404);
  if (!isLicenseUsable(lic)) return c.json({ error: "license " + lic.status, status: lic.status }, 403);

  const machine = await db.prepare(
    "SELECT * FROM machines WHERE license_key = ? AND fingerprint = ?"
  ).bind(licenseKey, fingerprint).first();
  if (!machine) return c.json({ error: "machine not activated; call /activate first" }, 403);

  await db.prepare("UPDATE machines SET last_seen_at = ? WHERE id = ?")
          .bind(nowMs(), machine.id).run();

  // Count current machines on this license so the plugin can refresh its UI.
  const allMachines = await db.prepare(
    "SELECT COUNT(*) AS n FROM machines WHERE license_key = ?"
  ).bind(licenseKey).first();
  const machinesUsed    = (allMachines && allMachines.n) || 1;
  const machinesAllowed = lic.machines_allowed || 2;

  // Compute the effective rate-limit view. If the stored reset_at is in the
  // past, treat counters as 0 (next AI call performs the actual DB reset).
  // We project the upcoming 1st-of-next-month UTC reset for display.
  const budgetMicroUsd = licenseBudgetMicroUsd(c.env, lic);
  const tsNow          = nowMs();
  let aiCostMonth      = lic.ai_cost_today_micro_usd || 0;
  let aiCallsMonth     = lic.ai_calls_today || 0;
  let aiResetAt        = lic.ai_calls_reset_at || 0;
  if (aiResetAt <= tsNow) {
    aiCostMonth  = 0;
    aiCallsMonth = 0;
    aiResetAt    = nextAnniversaryResetUtcMs(lic.created_at || tsNow, tsNow);
    // Persist the reset so subsequent queries / direct DB reads see the
    // canonical state — not just the computed view in this response.
    await db.prepare(
      "UPDATE licenses SET ai_cost_today_micro_usd = 0, ai_calls_today = 0, ai_calls_reset_at = ?, updated_at = ? WHERE key = ?"
    ).bind(aiResetAt, tsNow, licenseKey).run();
  }

  const token = await issueToken({ key: licenseKey, fp: fingerprint }, c.env.TOKEN_SECRET);
  return c.json({
    ok:                       true,
    token,
    tokenExpiresAt:           nowMs() + TOKEN_TTL_SECONDS * 1000,
    licenseExpiresAt:         lic.expires_at,
    plan:                     lic.plan,
    status:                   lic.status,
    machinesUsed,
    machinesAllowed,
    aiCostThisMonthMicroUsd:  aiCostMonth,
    aiCostLimitMicroUsd:      budgetMicroUsd,
    aiCallsThisMonth:         aiCallsMonth,    // informational only
    aiCostResetAt:            aiResetAt,
    paymentPastDue:           lic.status === "past_due",
    pastDueGraceEndsAt:       pastDueGraceEndsAt(lic)
  });
});

// ---------------------------------------------------------------------------
// Machines of a license (self-service: the key is the credential). The
// panel's "Manage machines" dialog lists them; works for any existing
// license, so an expired one can still tidy up its slots.
// Input:  { licenseKey, fingerprint? }   (fingerprint = the caller, for `current`)
// Output: { ok, machines: [{ id, displayId, os, appVersion, firstSeenAt, lastSeenAt, current }], machinesUsed, machinesAllowed }
// ---------------------------------------------------------------------------
app.post("/v1/machines", async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "invalid JSON" }, 400); }
  const licenseKey  = String(body.licenseKey  || "").trim().toUpperCase();
  const fingerprint = String(body.fingerprint || "").trim();
  if (!licenseKey) return c.json({ error: "licenseKey required" }, 400);
  const db  = c.env.DB;
  const lic = await findLicense(db, licenseKey);
  if (!lic) return c.json({ error: "license not found" }, 404);
  const machines = await listMachines(db, licenseKey, fingerprint);
  return c.json({ ok: true, machines, machinesUsed: machines.length, machinesAllowed: lic.machines_allowed || 2 });
});

// ---------------------------------------------------------------------------
// Release a machine slot. "Sign out" in the panel releases the calling
// machine (fingerprint); the machine-limit dialog and "Manage machines"
// release another one by its row id. Idempotent: an unknown machine is
// reported as removed: 0.
// Input:  { licenseKey, fingerprint?, machineId? }
// Output: { ok, removed, machines, machinesUsed, machinesAllowed }
// ---------------------------------------------------------------------------
app.post("/v1/deactivate", async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "invalid JSON" }, 400); }
  const licenseKey  = String(body.licenseKey  || "").trim().toUpperCase();
  const fingerprint = String(body.fingerprint || "").trim();
  const machineId   = body.machineId;
  if (!licenseKey) return c.json({ error: "licenseKey required" }, 400);
  if (!fingerprint && !(parseInt(machineId, 10) > 0)) return c.json({ error: "fingerprint or machineId required" }, 400);
  const db  = c.env.DB;
  const lic = await findLicense(db, licenseKey);
  if (!lic) return c.json({ error: "license not found" }, 404);
  const target = (parseInt(machineId, 10) > 0)
    ? await findMachine(db, licenseKey, { machineId })
    : await findMachine(db, licenseKey, { fingerprint });
  let removed = 0;
  if (target) {
    await releaseMachine(db, licenseKey, target, { reason: "self_service", self: !!fingerprint && target.fingerprint === fingerprint, by: fingerprint.slice(0, 14) || null });
    removed = 1;
  }
  const machines = await listMachines(db, licenseKey, fingerprint);
  return c.json({ ok: true, removed, machines, machinesUsed: machines.length, machinesAllowed: lic.machines_allowed || 2 });
});

// ---------------------------------------------------------------------------
// AI Apply — proxy the user's request to Anthropic, after verifying the
// signed token and that the underlying license is still active (catches
// subscriptions cancelled between token issue and now).
// ---------------------------------------------------------------------------
app.post("/v1/ai-apply", async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "invalid JSON" }, 400); }

  const token = String(body.token || "");
  const payload = await verifyToken(token, c.env.TOKEN_SECRET);
  if (!payload) return c.json({ error: "invalid or expired token" }, 401);

  // Re-check license status (token alone isn't enough — sub may have lapsed)
  const lic = await findLicense(c.env.DB, payload.key);
  if (!isLicenseUsable(lic)) {
    return c.json({ error: "license " + (lic ? lic.status : "missing") }, 403);
  }

  // ------------------------------------------------------------------------
  // Per-license MONTHLY AI cost limit. Tracks actual Anthropic token cost in
  // µUSD. Resets on the 1st of the next month at 00:00 UTC. Configured via
  // MONTHLY_AI_BUDGET_USD env var (default $4.05 if unset / invalid).
  //
  // DB columns are named "..._today" / "..._reset_at" but their semantics
  // are now MONTHLY. Renaming would require a migration; we accept the
  // mismatch in column names.
  // ------------------------------------------------------------------------
  const budgetMicroUsd = licenseBudgetMicroUsd(c.env, lic);
  const now = nowMs();

  let costMonth  = lic.ai_cost_today_micro_usd || 0;
  let callsMonth = lic.ai_calls_today || 0;
  let resetAt    = lic.ai_calls_reset_at || 0;

  // If the reset moment has passed, roll counters over to a fresh month.
  // Anchor = the license's created_at (so resets fall on the same calendar
  // day each month — e.g. license created Jun 15 → resets on the 15th).
  const resetAnchorMs = lic.created_at || now;
  if (resetAt <= now) {
    resetAt    = nextAnniversaryResetUtcMs(resetAnchorMs, now);
    costMonth  = 0;
    callsMonth = 0;
    await c.env.DB.prepare(
      "UPDATE licenses SET ai_cost_today_micro_usd = 0, ai_calls_today = 0, ai_calls_reset_at = ?, updated_at = ? WHERE key = ?"
    ).bind(resetAt, now, payload.key).run();
  }

  // Block when accumulated cost has reached the monthly budget. We allow
  // one call to push slightly over (we charge AFTER the call when actual
  // usage is known) — typical overage is <$0.05.
  if (costMonth >= budgetMicroUsd) {
    const msUntilReset   = Math.max(0, resetAt - now);
    const daysUntilReset = Math.ceil(msUntilReset / (24 * 60 * 60 * 1000));
    const budgetUsd      = (budgetMicroUsd / 1_000_000).toFixed(2);
    return c.json({
      error:        "Monthly AI budget reached ($" + budgetUsd + "/month). Resets in ~" + daysUntilReset + " day(s).",
      rateLimited:  true,
      costThisMonthMicroUsd: costMonth,
      budgetMicroUsd,
      resetAt
    }, 429);
  }

  // ------------------------------------------------------------------------
  // Forward to Anthropic
  // ------------------------------------------------------------------------
  const anthropicReq = {
    model:      body.model      || "claude-haiku-4-5-20251001",
    max_tokens: body.max_tokens || 2048,
    messages:   body.messages   || []
  };
  if (body.system) anthropicReq.system = body.system;

  const { res: upstream, attempts: anthropicAttempts } = await fetchWithRetry(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "content-type":      "application/json",
        "x-api-key":         c.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(anthropicReq)
    },
    { maxAttempts: 4, baseMs: 500 }   // ~0.5→1→2s backoff on 529/429/5xx
  );

  // Parse Anthropic's usage so we can charge for the real token count.
  // Failed calls (no usage block in response) cost the user nothing.
  const text = await upstream.text();
  let thisCallCost = 0;
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.usage) {
      thisCallCost = calcCostMicroUsd(parsed.usage);
    }
  } catch { /* non-JSON response — Anthropic error etc. — no charge */ }

  // Persist the new totals. Always bump the call counter (kept for stats),
  // and add the actual cost on top of this month's running total.
  callsMonth += 1;
  costMonth  += thisCallCost;
  await c.env.DB.prepare(
    "UPDATE licenses SET ai_cost_today_micro_usd = ?, ai_calls_today = ?, ai_calls_reset_at = ?, updated_at = ? WHERE key = ?"
  ).bind(costMonth, callsMonth, resetAt, now, payload.key).run();

  // Telemetry: log this AI call with its cost for historical aggregation.
  // (The monthly running total resets, but this event row stays — that's how
  // we build per-month spend rollups for customer support.)
  await logEvent(c.env.DB, {
    licenseKey:    payload.key,
    eventType:     "ai_call",
    detail:        { provider: "anthropic", model: anthropicReq.model, http_status: upstream.status, attempts: anthropicAttempts },
    costMicroUsd:  thisCallCost
  });

  // Pass through Anthropic's status + body, plus rate-limit headers so the
  // plugin can show usage without re-parsing the body. All values in µUSD
  // (plugin maps 1 µUSD = 1 token for display).
  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type":          "application/json",
      "X-RateLimit-Limit":     String(budgetMicroUsd),
      "X-RateLimit-Remaining": String(Math.max(0, budgetMicroUsd - costMonth)),
      "X-RateLimit-Used":      String(costMonth),
      "X-RateLimit-Reset":     String(Math.floor(resetAt / 1000))   // seconds-since-epoch
    }
  });
});

// ---------------------------------------------------------------------------
// POST /v1/transcribe — Speech-to-text via ElevenLabs Scribe v2.
//
// Used by the Premiere Pro plugin: it exports the active sequence's audio
// to .wav, uploads it here, and gets back word-level transcript JSON that
// it converts to an .srt and imports back into PR as a caption track.
//
// Request: multipart/form-data
//   token         — license token (same shape as /v1/ai-apply)
//   audio         — audio file (.wav, .mp3, .m4a, .flac, .ogg, .webm)
//   language_code — optional ISO 639-1 code; omit for auto-detect
//   diarize       — optional "true"/"false" (default false; speaker IDs)
//
// Response: ElevenLabs Scribe JSON
//   {
//     language_code: "de",
//     language_probability: 0.98,
//     text: "...full transcript...",
//     words: [
//       { text:"Heute", type:"word", start:0.0, end:0.5, speaker_id:"..." },
//       { text:" ",     type:"spacing", start:0.5, end:0.55 },
//       ...
//     ]
//   }
// + same X-RateLimit-* headers as /v1/ai-apply.
//
// Cost: $0.005/min audio (Scribe v2 batch). Derived from the last word's
// `end` timestamp in the response. Tracked against the same monthly budget
// as Claude calls (in µUSD) — keeps the budget model simple.
// ---------------------------------------------------------------------------
app.post("/v1/transcribe", async (c) => {
  // 1. Parse multipart form
  let form;
  try { form = await c.req.formData(); }
  catch { return c.json({ error: "expected multipart/form-data" }, 400); }

  const token        = String(form.get("token") || "");
  const audioFile    = form.get("audio");
  const languageCode = String(form.get("language_code") || "").trim();
  const diarize      = String(form.get("diarize") || "").trim() === "true";

  if (!token)     return c.json({ error: "token field required" }, 400);
  if (!audioFile) return c.json({ error: "audio field required (multipart file)" }, 400);

  // 2. Verify token
  const payload = await verifyToken(token, c.env.TOKEN_SECRET);
  if (!payload) return c.json({ error: "invalid or expired token" }, 401);

  // 3. Re-check license
  const lic = await findLicense(c.env.DB, payload.key);
  if (!isLicenseUsable(lic)) {
    return c.json({ error: "license " + (lic ? lic.status : "missing") }, 403);
  }

  // 4. Monthly budget gate (shared with /v1/ai-apply — Claude + Whisper roll
  //    into the same µUSD pot). Reset logic matches /v1/ai-apply for parity.
  const budgetMicroUsd = licenseBudgetMicroUsd(c.env, lic);
  const now = nowMs();

  let costMonth  = lic.ai_cost_today_micro_usd || 0;
  let callsMonth = lic.ai_calls_today || 0;
  let resetAt    = lic.ai_calls_reset_at || 0;

  const resetAnchorMs = lic.created_at || now;
  if (resetAt <= now) {
    resetAt    = nextAnniversaryResetUtcMs(resetAnchorMs, now);
    costMonth  = 0;
    callsMonth = 0;
    await c.env.DB.prepare(
      "UPDATE licenses SET ai_cost_today_micro_usd = 0, ai_calls_today = 0, ai_calls_reset_at = ?, updated_at = ? WHERE key = ?"
    ).bind(resetAt, now, payload.key).run();
  }

  if (costMonth >= budgetMicroUsd) {
    const msUntilReset   = Math.max(0, resetAt - now);
    const daysUntilReset = Math.ceil(msUntilReset / (24 * 60 * 60 * 1000));
    const budgetUsd      = (budgetMicroUsd / 1_000_000).toFixed(2);
    return c.json({
      error:        "Monthly AI budget reached ($" + budgetUsd + "/month). Resets in ~" + daysUntilReset + " day(s).",
      rateLimited:  true,
      costThisMonthMicroUsd: costMonth,
      budgetMicroUsd,
      resetAt
    }, 429);
  }

  // 5. Check ElevenLabs key is configured
  if (!c.env.ELEVENLABS_API_KEY) {
    return c.json({ error: "Backend misconfigured: ELEVENLABS_API_KEY not set" }, 500);
  }

  // 6. Build multipart payload for ElevenLabs Scribe v2
  const elForm = new FormData();
  elForm.append("model_id", "scribe_v2");
  elForm.append("file", audioFile);
  elForm.append("timestamps_granularity", "word");
  elForm.append("tag_audio_events", "false");  // suppress [music]/[laughter]
  if (languageCode) elForm.append("language_code", languageCode);
  if (diarize)      elForm.append("diarize", "true");

  // 7. Forward to ElevenLabs
  let upstream;
  try {
    upstream = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method:  "POST",
      headers: { "xi-api-key": c.env.ELEVENLABS_API_KEY },
      body:    elForm
    });
  } catch (e) {
    return c.json({ error: "ElevenLabs request failed: " + String(e && e.message || e) }, 502);
  }

  const text = await upstream.text();

  // 8. Derive cost from audio duration (last word's `end` timestamp).
  //    Scribe v2 batch pricing ≈ $0.005/min = ~83 µUSD/sec.
  //    Failed calls = no cost.
  let thisCallCost = 0;
  let audioDurationSec = 0;
  if (upstream.ok) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && Array.isArray(parsed.words) && parsed.words.length > 0) {
        // Find the actual end of speech (skip trailing "spacing" entries
        // which sometimes have generous end times).
        for (let i = parsed.words.length - 1; i >= 0; i--) {
          const w = parsed.words[i];
          if (w && typeof w.end === "number" && w.end > 0) {
            audioDurationSec = w.end;
            break;
          }
        }
      }
      // Round up to the next 0.1 second to be slightly conservative.
      audioDurationSec = Math.ceil(audioDurationSec * 10) / 10;
      // 5000 µUSD per 60 seconds = 83.333 µUSD/sec
      thisCallCost = Math.round(audioDurationSec * (5000 / 60));
    } catch { /* non-JSON / error response — don't charge */ }
  }

  // 9. Persist cost. Always bump call counter even on failed calls so we
  //    have visibility into usage patterns.
  callsMonth += 1;
  costMonth  += thisCallCost;
  await c.env.DB.prepare(
    "UPDATE licenses SET ai_cost_today_micro_usd = ?, ai_calls_today = ?, ai_calls_reset_at = ?, updated_at = ? WHERE key = ?"
  ).bind(costMonth, callsMonth, resetAt, now, payload.key).run();

  // Telemetry: log this transcription with its derived cost.
  await logEvent(c.env.DB, {
    licenseKey:    payload.key,
    eventType:     "ai_call",
    detail:        { provider: "elevenlabs", model: "scribe_v2", audio_duration_sec: audioDurationSec, http_status: upstream.status },
    costMicroUsd:  thisCallCost
  });

  // 10. Pass through ElevenLabs's response + budget headers
  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type":          "application/json",
      "X-RateLimit-Limit":     String(budgetMicroUsd),
      "X-RateLimit-Remaining": String(Math.max(0, budgetMicroUsd - costMonth)),
      "X-RateLimit-Used":      String(costMonth),
      "X-RateLimit-Reset":     String(Math.floor(resetAt / 1000)),
      "X-Audio-Duration-Sec":  String(audioDurationSec),
      "X-Transcribe-Cost":     String(thisCallCost)
    }
  });
});

// ---------------------------------------------------------------------------
// Auto-update — check for a newer plugin version, serve installer downloads.
//
// Single source of truth: GitHub Releases on RefinedMotion/stacked-captions
// (private repo). We read release metadata via the GitHub API using a stored
// fine-grained PAT (GITHUB_TOKEN secret), then either return version + notes
// (/v1/check-update) or 302-redirect to a short-lived GitHub-signed S3 URL
// for the asset bytes (/v1/download-installer). The download bytes never
// flow through the Worker — GitHub's CDN serves them directly to the client.
//
// Both endpoints require a valid token + active license, so we can:
//   - prevent random people downloading paid installers
//   - cut off updates the moment a subscription lapses
//   - one day, gate beta channels per license
//
// New release flow:
//   1. Build .pkg on Mac (build-mac.sh) + .zxp on Win (build-zxp.ps1)
//   2. gh release create v1.1.0 ./build-mac/StackedCaptions-1.1.0.pkg ./dist/StackedCaptions-1.1.0.zxp --notes "..."
//   3. Plugins auto-detect within 24h.
//
// Mark a release [required] (e.g. for a security fix) by including the
// literal string "[required]" in the release name or release notes — the
// plugin will then disable the "Later" button and force the update.
// ---------------------------------------------------------------------------

const GH_REPO = "RefinedMotion/stacked-captions";
const GH_API  = "https://api.github.com";

// Asset filename patterns by platform. Matched case-insensitively against
// release asset names. First match wins. Adjust if release filenames change.
const ASSET_PATTERNS = {
  mac: [/^StackedCaptions[-_].*\.pkg$/i],
  win: [/^StackedCaptions[-_].*\.exe$/i, /^StackedCaptions[-_].*\.zxp$/i]
};

// Parse "v1.2.3" or "1.2.3" (with optional -beta.x or +build suffix) into
// [major, minor, patch]. Returns null if the input isn't recognisable semver.
function parseSemver(s) {
  if (typeof s !== "string") return null;
  const m = s.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function semverGt(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

// Read the latest published (non-draft, non-prerelease) release from GitHub.
async function fetchLatestRelease(env) {
  const url = `${GH_API}/repos/${GH_REPO}/releases/latest`;
  const headers = {
    "Accept":               "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent":           "stacked-captions-api"
  };
  if (env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub releases/latest ${res.status}: ${body.slice(0, 200)}`);
  }
  return await res.json();
}

// Pick the first asset on a release whose name matches a pattern for the
// requested platform. Returns null if nothing fits.
function pickPlatformAsset(release, platform) {
  const patterns = ASSET_PATTERNS[platform];
  if (!patterns || !release || !Array.isArray(release.assets)) return null;
  for (const pat of patterns) {
    const found = release.assets.find(a => pat.test(a.name || ""));
    if (found) return found;
  }
  return null;
}

// Normalise the various platform strings the plugin might send.
function normalisePlatform(raw) {
  const p = String(raw || "").toLowerCase().trim();
  if (p === "mac" || p === "darwin" || p === "osx" || p === "macos") return "mac";
  if (p === "win" || p === "windows" || p === "win32" || p === "win64") return "win";
  return null;
}

// ---------------------------------------------------------------------------
// POST /v1/check-update
//   body: { token, currentVersion, platform }
//
// Response (200):
//   {
//     updateAvailable: boolean,
//     latestVersion:   "1.1.0",
//     isRequired:      boolean,
//     releaseName:     "v1.1.0 — bug fixes",
//     releaseNotes:    "...markdown...",
//     publishedAt:     "2026-06-01T12:34:56Z",
//     download:        { fileName, sizeBytes, url } | null
//   }
// ---------------------------------------------------------------------------
app.post("/v1/check-update", async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "invalid JSON" }, 400); }

  const token          = String(body.token || "");
  const currentVersion = String(body.currentVersion || "").trim();
  const platform       = normalisePlatform(body.platform);

  if (!platform)       return c.json({ error: "platform must be 'mac' or 'win'" }, 400);
  if (!currentVersion) return c.json({ error: "currentVersion required" }, 400);

  // License-OPTIONAL by design: a user who can't activate (e.g. a connectivity
  // or activation bug) must still be able to discover and pull the fix. If a
  // valid token is present we honour it (licensed users get a token-embedded
  // download URL for telemetry); otherwise we still return update info. The
  // real gate stays at activation, and the installer bytes are public anyway.
  const payload = token ? await verifyToken(token, c.env.TOKEN_SECRET) : null;

  let release;
  try {
    release = await fetchLatestRelease(c.env);
  } catch (e) {
    console.error("check-update: GitHub fetch failed:", e && e.message);
    return c.json({
      error: "could not reach update server",
      detail: String(e && e.message || e)
    }, 502);
  }

  const latestVersion = (release.tag_name || "").replace(/^v/i, "");
  const latest        = parseSemver(latestVersion);
  const current       = parseSemver(currentVersion);

  if (!latest) {
    console.warn("check-update: latest tag not parseable:", release.tag_name);
    return c.json({ updateAvailable: false, reason: "invalid latest tag", latestVersion });
  }

  const updateAvailable = current ? semverGt(latest, current) : true;
  const asset           = pickPlatformAsset(release, platform);

  // [required] marker in release name or body forces the update (no "Later" button).
  const isRequired =
    /\[required\]/i.test(release.body || "") ||
    /\[required\]/i.test(release.name || "");

  // Build the absolute URL the plugin will GET to download the asset.
  // We base it off c.req.url so this works on both api.refinedmotion.de
  // and the *.workers.dev fallback.
  let downloadUrl = null;
  if (asset) {
    const origin = new URL(c.req.url).origin;
    downloadUrl =
      `${origin}/v1/download-installer` +
      `?platform=${platform}` +
      `&assetId=${asset.id}` +
      `&token=${encodeURIComponent(token)}`;
  }

  return c.json({
    updateAvailable,
    latestVersion,
    isRequired,
    releaseName:  release.name || release.tag_name || "",
    releaseNotes: release.body || "",
    publishedAt:  release.published_at || null,
    download:     asset ? {
      fileName:  asset.name,
      sizeBytes: asset.size,
      url:       downloadUrl
    } : null
  });
});

// ---------------------------------------------------------------------------
// GET /v1/download-installer?token=...&platform=...&assetId=...
//
// Verifies token + license, then asks GitHub for the asset with
// Accept: application/octet-stream. GitHub responds 302 with a short-lived
// signed S3 URL. We forward that redirect to the client so the bytes flow
// from GitHub's CDN, not through us.
// ---------------------------------------------------------------------------
app.get("/v1/download-installer", async (c) => {
  const token    = String(c.req.query("token") || "");
  const platform = normalisePlatform(c.req.query("platform"));
  const assetId  = String(c.req.query("assetId") || "");

  if (!assetId)  return c.json({ error: "assetId required" }, 400);
  if (!platform) return c.json({ error: "platform must be 'mac' or 'win'" }, 400);

  // License-OPTIONAL (see /v1/check-update): the installer is public, so anyone
  // may pull it — this is what lets activation-blocked users self-heal to a fix.
  const payload = token ? await verifyToken(token, c.env.TOKEN_SECRET) : null;

  const ghUrl = `${GH_API}/repos/${GH_REPO}/releases/assets/${encodeURIComponent(assetId)}`;
  const headers = {
    "Accept":               "application/octet-stream",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent":           "stacked-captions-api"
  };
  if (c.env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${c.env.GITHUB_TOKEN}`;

  // redirect: "manual" so we get the 302 ourselves and can pass its Location
  // through (otherwise fetch would follow it and we'd be proxying bytes).
  let upstream;
  try {
    upstream = await fetch(ghUrl, { headers, redirect: "manual" });
  } catch (e) {
    console.error("download-installer: GitHub fetch threw:", e && e.message);
    return c.json({ error: "could not reach update server" }, 502);
  }

  if (upstream.status === 301 || upstream.status === 302) {
    const signed = upstream.headers.get("location");
    if (signed) {
      // Telemetry: which platform + which asset got downloaded.
      await logEvent(c.env.DB, {
        licenseKey: payload ? payload.key : null,
        eventType:  "update_downloaded",
        detail:     { platform, assetId }
      });
      return Response.redirect(signed, 302);
    }
  }

  const debugBody = await upstream.text();
  console.error("download-installer: unexpected GitHub status", upstream.status, debugBody.slice(0, 300));
  return c.json({
    error: "could not fetch asset from GitHub",
    githubStatus: upstream.status
  }, 502);
});

// ---------------------------------------------------------------------------
// POST /v1/support  { message, log?, meta? }
//
// In-plugin "Report a bug" form. Forwards the user's message + the panel's
// diagnostic log to the support inbox via Resend. Deliberately UNauthenticated
// (and license-agnostic) so a user whose license/activation is broken — i.e.
// exactly when they need support — can still reach us. Sizes are capped to
// keep one report from blowing up an email.
// ---------------------------------------------------------------------------
app.post("/v1/support", async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch (e) { return c.json({ ok: false, error: "invalid JSON" }, 400); }

  const message = String(body.message || "").slice(0, 8000).trim();
  const logText = String(body.log || "").slice(0, 40000);
  const meta    = (body.meta && typeof body.meta === "object") ? body.meta : {};
  // Attached session log files — the plugin auto-collects the last few from its
  // on-disk logs folder. Each is { name, contentB64 (base64) }. Cap count +
  // per-file size defensively so one report can't blow up the email.
  const logFiles = (Array.isArray(body.logFiles) ? body.logFiles : [])
    .slice(0, 3)
    .filter((f) => f && typeof f.name === "string" && typeof f.contentB64 === "string")
    .map((f) => ({ name: String(f.name).slice(0, 120), contentB64: String(f.contentB64).slice(0, 400000) }));
  // "bug" (default) or "question" — controls the email subject so the inbox
  // can tell a bug report from a how-do-I question at a glance.
  const kind    = String(body.kind || "bug").toLowerCase() === "question" ? "question" : "bug";
  if (!message) return c.json({ ok: false, error: "message is required" }, 400);

  // Resolve the LICENSE email from the license key (the plugin knows the key,
  // not the registered email). This puts the customer's email + license status
  // into the support email AND makes it the reply-to, so we always know who's
  // writing. Best-effort — a not-yet-activated user simply has no key.
  if (meta.licenseKey) {
    try {
      const lic = await c.env.DB.prepare(
        "SELECT u.email AS email, l.status AS status, l.plan AS plan " +
        "FROM licenses l JOIN users u ON l.user_id = u.id WHERE l.key = ?"
      ).bind(String(meta.licenseKey).trim().toUpperCase()).first();
      if (lic && lic.email) {
        meta.email         = lic.email;   // drives the "Email:" line + reply_to
        meta.licenseStatus = lic.status;
        if (!meta.plan) meta.plan = lic.plan;
      }
    } catch (e) { /* best-effort — never block a support message */ }
  }

  const result = await sendSupportEmail(c.env, { message, logText, meta, kind, logFiles });
  if (!result.ok) return c.json({ ok: false, error: result.reason || "send_failed" }, 502);
  return c.json({ ok: true, id: result.id });
});

// ---------------------------------------------------------------------------
// Email — sends transactional emails via Resend. Best-effort: failures are
// logged but never break the webhook response (LS would otherwise retry).
// ---------------------------------------------------------------------------

// Legal Impressum — required by § 5 TMG for commercial emails sent from
// Germany. Edit here if address / tax info changes.
const IMPRESSUM = {
  tradeName:    "Refined Motion",
  name:         "Philipp Kies",
  addressLine1: "Am Fichtenbusch 16",
  addressLine2: "33378 Rheda-Wiedenbrück",
  country:      "Germany",
  taxIdLabel:   "Steuernr.",
  taxId:        "347/5138/2835",
  website:      "refinedmotion.de"
};

function planLabel(plan) {
  if (plan === "monthly") return "Monthly · €12.99 / month";
  if (plan === "annual")  return "Annual · €119.88 / year";
  return plan;
}

function emailHtml(opts) {
  // opts: { key, planLabel, statusLabel, expiryLabel, expiryDate, portalUrl, supportEmail }
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; background:#f5f5f7; color:#1d1d1f; line-height:1.5;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" width="100%" style="max-width:560px; margin:0 auto;">
  <tr><td style="padding:40px 24px 8px;">
    <div style="font-size:12px; color:#888; letter-spacing:0.08em; text-transform:uppercase; font-weight:600;">Refined Motion</div>
    <h1 style="font-size:24px; margin:14px 0 6px; font-weight:600; color:#1d1d1f;">Welcome to Stacked Captions</h1>
    <p style="margin:0; color:#555;">Your subscription is set up. Here's your license key:</p>
  </td></tr>
  <tr><td style="padding:20px 24px 4px;">
    <div style="background:#ffffff; border:1px solid #e3e3e6; border-radius:10px; padding:22px; text-align:center;">
      <div style="font-family:'SF Mono','Menlo',Monaco,Consolas,monospace; font-size:17px; font-weight:600; color:#1d1d1f; letter-spacing:0.02em; word-break:break-all;">${opts.key}</div>
      <div style="margin-top:10px; font-size:12px; color:#888;">Copy this key — you'll need it in the next step.</div>
    </div>
  </td></tr>
  <tr><td style="padding:24px 24px 8px;">
    <h2 style="font-size:16px; margin:0 0 12px; font-weight:600; color:#1d1d1f;">Get started</h2>
    <ol style="margin:0; padding-left:22px; color:#1d1d1f;">
      <li style="margin-bottom:10px;">
        <strong>Download the installer</strong> — your purchase confirmation
        (separate email from Lemon Squeezy) contains the download link. Pick the
        file for your system:
        <code style="background:#f0f0f2; padding:1px 5px; border-radius:3px; font-family:'SF Mono',Menlo,monospace; font-size:13px;">.exe</code>
        for Windows,
        <code style="background:#f0f0f2; padding:1px 5px; border-radius:3px; font-family:'SF Mono',Menlo,monospace; font-size:13px;">.pkg</code>
        for Mac.
      </li>
      <li style="margin-bottom:10px;">
        <strong>Run the installer.</strong> It's code-signed (Windows: Certum;
        Mac: Apple-notarized), so it installs cleanly — no extra tools needed.
        It sets the plugin up for After Effects automatically.
      </li>
      <li style="margin-bottom:10px;">
        Restart <strong>After Effects</strong> (or open it if it was closed).
      </li>
      <li style="margin-bottom:10px;">
        In AE: <strong>Window → Extensions → Stacked Captions</strong>.
        Expand <strong>License &amp; Account</strong> at the top of the panel.
      </li>
      <li style="margin-bottom:4px;">
        Paste your license key (above) and click <strong>Activate</strong>.
      </li>
    </ol>
  </td></tr>
  <tr><td style="padding:24px;">
    <div style="border:1px solid #e3e3e6; border-radius:10px; padding:16px 18px; background:#ffffff;">
      <div style="font-size:12px; color:#888; letter-spacing:0.06em; text-transform:uppercase; font-weight:600; margin-bottom:10px;">Subscription</div>
      <table style="width:100%; font-size:14px; border-collapse:collapse;">
        <tr><td style="padding:4px 0; color:#666;">Plan</td><td style="padding:4px 0; text-align:right; color:#1d1d1f;">${opts.planLabel}</td></tr>
        <tr><td style="padding:4px 0; color:#666;">Status</td><td style="padding:4px 0; text-align:right; color:#1d1d1f;">${opts.statusLabel}</td></tr>
        <tr><td style="padding:4px 0; color:#666;">${opts.expiryLabel}</td><td style="padding:4px 0; text-align:right; color:#1d1d1f;">${opts.expiryDate}</td></tr>
        <tr><td style="padding:4px 0; color:#666;">Machines</td><td style="padding:4px 0; text-align:right; color:#1d1d1f;">Up to 2 per license</td></tr>
      </table>
    </div>
  </td></tr>
  ${opts.portalUrl ? `<tr><td style="padding:0 24px 24px;">
    <a href="${opts.portalUrl}" style="display:inline-block; background:#1d1d1f; color:#ffffff; text-decoration:none; font-size:14px; font-weight:500; padding:11px 20px; border-radius:8px;">Manage Subscription</a>
    <div style="font-size:12px; color:#888; margin-top:8px;">Update payment method, change plan, or cancel.</div>
  </td></tr>` : ""}
  <tr><td style="padding:0 24px 40px; font-size:12px; color:#888; text-align:center; border-top:1px solid #e3e3e6; padding-top:24px; line-height:1.7;">
    Questions? Reply to this email or write to
    <a href="mailto:${opts.supportEmail}" style="color:#0066cc; text-decoration:none;">${opts.supportEmail}</a>
    <div style="margin-top:16px; color:#aaa; font-size:11px;">
      ${IMPRESSUM.tradeName} · ${IMPRESSUM.name}<br>
      ${IMPRESSUM.addressLine1} · ${IMPRESSUM.addressLine2} · ${IMPRESSUM.country}<br>
      ${IMPRESSUM.taxIdLabel} ${IMPRESSUM.taxId} · ${IMPRESSUM.website}
    </div>
  </td></tr>
</table>
</body></html>`;
}

function emailText(opts) {
  return `Welcome to Stacked Captions
Your subscription is set up.

YOUR LICENSE KEY
================
${opts.key}

GET STARTED
1. Download the installer. Your purchase confirmation email (from Lemon
   Squeezy) contains the download link. Pick the file for your system:
   .exe for Windows, .pkg for Mac.
2. Run the installer. It's code-signed (Windows: Certum; Mac: Apple-
   notarized), so it installs cleanly — no extra tools needed. It sets
   the plugin up for After Effects automatically.
3. Restart After Effects (or open it if it was closed).
4. In AE: Window > Extensions > Stacked Captions. Expand
   "License & Account" at the top of the panel.
5. Paste your license key (above) and click Activate.

SUBSCRIPTION
Plan:           ${opts.planLabel}
Status:         ${opts.statusLabel}
${opts.expiryLabel}:  ${opts.expiryDate}
Machines:       Up to 2 per license

${opts.portalUrl ? "Manage your subscription:\n" + opts.portalUrl + "\n" : ""}
Questions? Reply to this email or write to ${opts.supportEmail}

----
${IMPRESSUM.tradeName} · ${IMPRESSUM.name}
${IMPRESSUM.addressLine1}
${IMPRESSUM.addressLine2}
${IMPRESSUM.country}
${IMPRESSUM.taxIdLabel} ${IMPRESSUM.taxId}
${IMPRESSUM.website}`;
}

async function sendLicenseEmail(env, opts) {
  // opts: { email, key, plan, status, expiresAt, portalUrl }
  if (!env.RESEND_API_KEY) {
    console.warn("Resend: RESEND_API_KEY not set — skipping email send to", opts.email);
    return { ok: false, reason: "no_api_key" };
  }

  const isTrialing  = opts.status === "trial";
  const subject     = isTrialing
    ? "Your Stacked Captions trial has started"
    : "Your Stacked Captions subscription is active";
  const statusLabel = isTrialing ? "Trial (7 days free)" : "Active";
  const expiryLabel = isTrialing ? "First charge" : "Renews";
  const expiryDate  = opts.expiresAt
    ? new Date(opts.expiresAt).toISOString().slice(0, 10)
    : "—";

  const tmplOpts = {
    key:          opts.key,
    planLabel:    planLabel(opts.plan),
    statusLabel,
    expiryLabel,
    expiryDate,
    portalUrl:    opts.portalUrl || "",
    supportEmail: env.SUPPORT_EMAIL || "mail@refinedmotion.de"
  };

  const fromName  = env.FROM_NAME  || "Stacked Captions";
  const fromEmail = env.FROM_EMAIL || "noreply@mail.refinedmotion.de";
  const replyTo   = env.SUPPORT_EMAIL || "mail@refinedmotion.de";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type":  "application/json"
      },
      body: JSON.stringify({
        from:     `${fromName} <${fromEmail}>`,
        to:       [opts.email],
        reply_to: replyTo,
        subject,
        html:     emailHtml(tmplOpts),
        text:     emailText(tmplOpts)
      })
    });

    if (!res.ok) {
      const body = await res.text();
      console.error("Resend send failed:", res.status, body);
      return { ok: false, status: res.status, body };
    }
    const data = await res.json();
    console.log("Resend: email sent", data.id, "to", opts.email);
    return { ok: true, id: data.id };
  } catch (e) {
    console.error("Resend send threw:", e && e.message);
    return { ok: false, reason: "exception", error: e && e.message };
  }
}

// Forward an in-plugin support request (message + diagnostic log + context)
// to the support inbox via Resend. Sets reply_to to the user's email when we
// have a valid-looking one, so a reply goes straight back to them.
async function sendSupportEmail(env, opts) {
  if (!env.RESEND_API_KEY) {
    console.warn("Resend: RESEND_API_KEY not set — skipping support email");
    return { ok: false, reason: "no_api_key" };
  }
  const to        = env.SUPPORT_INBOX || "mail@refinedmotion.de";
  const fromName  = env.FROM_NAME  || "Stacked Captions";
  const fromEmail = env.FROM_EMAIL || "noreply@mail.refinedmotion.de";

  const m = opts.meta || {};
  const metaLines = [
    m.email         ? `Email:    ${m.email}`         : null,
    m.licenseKey    ? `License:  ${m.licenseKey}`    : null,
    m.licenseStatus ? `Status:   ${m.licenseStatus}` : null,
    m.plan          ? `Plan:     ${m.plan}`          : null,
    m.pluginVersion ? `Plugin:   ${m.pluginVersion}` : null,
    m.appVersion    ? `Host app: ${m.appVersion}`    : null,
    m.host          ? `Host:     ${m.host}`          : null,
    m.os            ? `OS:       ${m.os}`            : null
  ].filter(Boolean).join("\n");

  // Only set reply_to when the supplied email looks valid, otherwise Resend
  // rejects the whole request.
  const replyTo = (m.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m.email)) ? m.email : undefined;

  const isQuestion = opts.kind === "question";
  const attachments = (opts.logFiles || [])
    .filter((f) => f && f.name && f.contentB64)
    .map((f) => ({ filename: f.name, content: f.contentB64 }));

  const text =
    "New " + (isQuestion ? "QUESTION" : "BUG REPORT") + " from the Stacked Captions plugin.\n\n" +
    "=== MESSAGE ===\n" + opts.message + "\n\n" +
    (metaLines ? "=== CONTEXT ===\n" + metaLines + "\n\n" : "") +
    "=== PLUGIN LOG (current session) ===\n" + (opts.logText || "(no log captured)") + "\n" +
    (attachments.length
      ? "\n=== ATTACHED SESSION LOG FILES (" + attachments.length + ") ===\n" +
        attachments.map((a) => "  " + a.filename).join("\n") + "\n"
      : "\n(no session log files attached)\n");

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type":  "application/json"
      },
      body: JSON.stringify({
        from:        `${fromName} <${fromEmail}>`,
        to:          [to],
        reply_to:    replyTo,
        subject:     isQuestion ? "Support question — Stacked Captions" : "Bug report — Stacked Captions",
        text,
        attachments: attachments.length ? attachments : undefined
      })
    });
    if (!res.ok) {
      const b = await res.text();
      console.error("Support email failed:", res.status, b);
      return { ok: false, reason: "resend_" + res.status };
    }
    const data = await res.json();
    console.log("Resend: support email sent", data.id);
    return { ok: true, id: data.id };
  } catch (e) {
    console.error("Support email threw:", e && e.message);
    return { ok: false, reason: "exception" };
  }
}

// ---------------------------------------------------------------------------
// Lemon Squeezy webhook — mints/updates licenses as the customer's
// subscription evolves. LS signs each call with HMAC-SHA256 of the raw body
// using the webhook signing secret we configure in their dashboard.
// ---------------------------------------------------------------------------
function variantIdToPlan(env, variantId) {
  const v = String(variantId);
  if (v === String(env.LS_VARIANT_MONTHLY)) return "monthly";
  if (v === String(env.LS_VARIANT_ANNUAL))  return "annual";
  return null;
}

function parseIsoMs(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return isNaN(t) ? null : t;
}

// Hex-encoded HMAC-SHA256 (matches what LS sends in X-Signature)
async function hmacSha256Hex(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

// Timing-safe string compare (avoid leaking secret bits via early-exit)
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

app.post("/v1/webhooks/lemon-squeezy", async (c) => {
  // Read the raw body FIRST — we need it intact for signature verification.
  const rawBody = await c.req.text();
  const signature = c.req.header("X-Signature") || "";

  // Verify signature if we have a secret configured. (Skip-with-warning if
  // not set, so the endpoint is still testable before first secret upload.)
  if (c.env.LS_WEBHOOK_SECRET) {
    const expected = await hmacSha256Hex(rawBody, c.env.LS_WEBHOOK_SECRET);
    if (!safeEqual(signature, expected)) {
      console.warn("LS webhook: invalid signature");
      // Log the rejection to D1 — a signing-secret mismatch silently drops
      // real purchases (no license, no email). This makes it visible in the
      // events table instead of vanishing into console warnings.
      let evName = "?";
      try { var pj = JSON.parse(rawBody); evName = (pj && pj.meta && pj.meta.event_name) || "?"; } catch (e) {}
      try {
        await logEvent(c.env.DB, {
          eventType: "webhook_rejected",
          detail: { reason: "invalid_signature", event_name: evName, had_signature: !!signature }
        });
      } catch (eLog) {}
      return c.json({ error: "invalid signature" }, 401);
    }
  } else {
    console.warn("LS webhook: LS_WEBHOOK_SECRET not set — accepting unverified payload (dev only!)");
  }

  // Parse payload
  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { return c.json({ error: "invalid JSON" }, 400); }

  const eventName = payload && payload.meta && payload.meta.event_name;
  const attrs = payload && payload.data && payload.data.attributes;
  // Subscription events carry the Subscription object (data.id = subscription
  // id). The payment events (subscription_payment_success / _failed /
  // _recovered) carry a Subscription INVOICE: data.id is the invoice id and
  // the subscription id sits in attributes.subscription_id.
  const subId = (attrs && attrs.subscription_id != null && String(attrs.subscription_id)) ||
                (payload && payload.data && payload.data.id ? String(payload.data.id) : null);

  console.log("LS webhook:", eventName, "subId=", subId);

  if (!eventName || !attrs) {
    return c.json({ error: "malformed payload" }, 400);
  }

  const db = c.env.DB;

  // ----- Self-heal: link an orphan license to this subscription ------------
  // If a subscription lifecycle event (renewal / cancel / update / …) arrives
  // for a subscription_id we don't have on file, but the customer's email
  // matches a license that was never linked to any subscription (e.g. one we
  // minted manually after a missed/failed webhook), adopt this subscription_id
  // onto that license. After this, all the "WHERE subscription_id = ?" updates
  // below take effect, so the license follows the real subscription's
  // lifecycle (trial → active → cancelled/expired) automatically.
  if (subId && eventName !== "subscription_created" && attrs) {
    try {
      const known = await db.prepare("SELECT key FROM licenses WHERE subscription_id = ?").bind(subId).first();
      if (!known) {
        const healEmail = String(attrs.user_email || "").toLowerCase().trim();
        if (healEmail) {
          // (licenses are keyed by `key`; the former `l.id` lookup threw inside
          // this try and the self-heal never linked anything.)
          const orphan = await db.prepare(
            "SELECT l.key FROM licenses l JOIN users u ON u.id = l.user_id " +
            "WHERE lower(u.email) = ? AND (l.subscription_id IS NULL OR l.subscription_id = '') " +
            "ORDER BY l.created_at DESC LIMIT 1"
          ).bind(healEmail).first();
          if (orphan) {
            await db.prepare("UPDATE licenses SET subscription_id = ?, updated_at = ? WHERE key = ?")
                    .bind(subId, nowMs(), orphan.key).run();
            await logEvent(db, {
              licenseKey: orphan.key, email: healEmail,
              eventType:  "license_subscription_linked",
              detail:     { subscription_id: subId, ls_event: eventName, reason: "email_fallback" }
            });
          }
        }
      }
    } catch (eHeal) { /* best-effort — never block the webhook */ }
  }

  // ----- Subscription created → mint license -------------------------------
  if (eventName === "subscription_created") {
    const email = String(attrs.user_email || "").toLowerCase().trim();
    if (!email) return c.json({ error: "no user_email" }, 400);

    const variantId = attrs.variant_id;
    const plan = variantIdToPlan(c.env, variantId) || "unknown";

    // Idempotency: if a license already exists for this LS subscription_id,
    // return it (LS retries on non-2xx; we want this to be safe to replay).
    if (subId) {
      const existing = await db.prepare(
        "SELECT * FROM licenses WHERE subscription_id = ?"
      ).bind(subId).first();
      if (existing) {
        return c.json({ ok: true, licenseKey: existing.key, note: "already minted" });
      }
    }

    // Find or create user
    const lsCustomerId = attrs.customer_id ? String(attrs.customer_id) : null;
    let user = await db.prepare(
      "SELECT * FROM users WHERE email = ?"
    ).bind(email).first();
    if (!user) {
      await db.prepare(
        "INSERT INTO users (email, customer_id, created_at) VALUES (?, ?, ?)"
      ).bind(email, lsCustomerId, nowMs()).run();
      user = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
    } else if (!user.customer_id && lsCustomerId) {
      await db.prepare("UPDATE users SET customer_id = ? WHERE id = ?")
              .bind(lsCustomerId, user.id).run();
    }

    // Map LS status → our status
    const lsStatus = String(attrs.status || "").toLowerCase();
    let status = "active";
    if (lsStatus === "on_trial") status = "trial";
    else if (lsStatus === "past_due") status = "past_due";
    else if (lsStatus === "cancelled") status = "cancelled";
    else if (lsStatus === "expired" || lsStatus === "unpaid") status = "expired";   // unpaid = dunning exhausted, no access

    // expires_at = renews_at (next billing date — defines current paid period)
    const expiresAt = parseIsoMs(attrs.renews_at) || parseIsoMs(attrs.trial_ends_at) || (nowMs() + 30 * 24 * 60 * 60 * 1000);

    const key = randomLicenseKey();
    const ts = nowMs();
    await db.prepare(`
      INSERT INTO licenses (key, user_id, status, plan, expires_at, machines_allowed, subscription_id, past_due_since, created_at, updated_at)
      VALUES               (?,    ?,       ?,      ?,    ?,          ?,                ?,               ?,              ?,          ?         )
    `).bind(key, user.id, status, plan, expiresAt, 2, subId, status === "past_due" ? ts : null, ts, ts).run();

    await logEvent(db, {
      licenseKey: key, email,
      eventType:  "license_minted",
      detail:     { source: "lemon_squeezy", subscription_id: subId, plan, status, expiresAt }
    });

    console.log("LS webhook: minted license", key, "for", email, "plan=", plan);

    // Send the license key by email. Best-effort: if Resend fails the webhook
    // still returns 200 (we don't want LS to retry just because email is down —
    // the license is already in the DB and the admin lookup endpoint works).
    const portalUrl = (attrs.urls && attrs.urls.customer_portal) || "";
    const mailResult = await sendLicenseEmail(c.env, {
      email, key, plan, status, expiresAt, portalUrl
    });
    return c.json({
      ok:         true,
      licenseKey: key,
      email,
      plan,
      status,
      expiresAt,
      emailSent:  mailResult.ok,
      emailDebug: mailResult.ok ? undefined : mailResult  // includes status + body when failed
    });
  }

  // ----- Recurring payment succeeded → extend expires_at -------------------
  if (eventName === "subscription_payment_success" ||
      eventName === "subscription_payment_recovered") {
    if (!subId) return c.json({ ok: true, note: "no subId" });
    const newExpiresAt = parseIsoMs(attrs.renews_at);
    const lic = await db.prepare("SELECT key, email FROM licenses l LEFT JOIN users u ON u.id = l.user_id WHERE l.subscription_id = ?").bind(subId).first();
    if (newExpiresAt) {
      await db.prepare(
        "UPDATE licenses SET expires_at = ?, status = 'active', past_due_since = NULL, updated_at = ? WHERE subscription_id = ?"
      ).bind(newExpiresAt, nowMs(), subId).run();
    } else {
      // Payment recovered but no fresh renews_at in the payload — still clear
      // past_due_since + reactivate so the plugin un-pauses.
      await db.prepare(
        "UPDATE licenses SET status = 'active', past_due_since = NULL, updated_at = ? WHERE subscription_id = ?"
      ).bind(nowMs(), subId).run();
    }
    if (lic) {
      await logEvent(db, {
        licenseKey: lic.key, email: lic.email,
        eventType:  "license_renewed",
        detail:     { ls_event: eventName, subscription_id: subId, newExpiresAt }
      });
    }
    return c.json({ ok: true, event: eventName });
  }

  // ----- Subscription updated (plan change, etc.) --------------------------
  if (eventName === "subscription_updated") {
    if (!subId) return c.json({ ok: true, note: "no subId" });
    const lsStatus = String(attrs.status || "").toLowerCase();
    const status =
      lsStatus === "on_trial" ? "trial" :
      lsStatus === "past_due" ? "past_due" :
      lsStatus === "cancelled" ? "cancelled" :
      lsStatus === "expired" ? "expired" :
      lsStatus === "unpaid" ? "expired" :     // dunning exhausted: LS revoked access (a later payment_success reactivates)
      lsStatus === "active" ? "active" :
      null;
    const expiresAt = parseIsoMs(attrs.ends_at) || parseIsoMs(attrs.renews_at);
    const newPlan   = variantIdToPlan(c.env, attrs.variant_id);

    // Read previous state so we can log meaningful diffs (status_changed,
    // plan_changed) rather than a single noisy "updated" event.
    const prev = await db.prepare(
      "SELECT l.key, u.email, l.status AS prev_status, l.plan AS prev_plan FROM licenses l LEFT JOIN users u ON u.id = l.user_id WHERE l.subscription_id = ?"
    ).bind(subId).first();

    const updates = [];
    const binds = [];
    if (status)     { updates.push("status = ?");     binds.push(status); }
    if (expiresAt)  { updates.push("expires_at = ?"); binds.push(expiresAt); }
    if (newPlan)    { updates.push("plan = ?");       binds.push(newPlan); }
    // Keep past_due_since in sync when this event carries a status change:
    // stamp it on first entry into past_due, clear it on any other status.
    if (status === "past_due") {
      if (!prev || prev.prev_status !== "past_due") { updates.push("past_due_since = ?"); binds.push(nowMs()); }
    } else if (status) {
      updates.push("past_due_since = NULL");
    }
    if (updates.length) {
      updates.push("updated_at = ?"); binds.push(nowMs());
      binds.push(subId);
      await db.prepare(
        "UPDATE licenses SET " + updates.join(", ") + " WHERE subscription_id = ?"
      ).bind(...binds).run();
    }

    if (prev) {
      if (status && status !== prev.prev_status) {
        await logEvent(db, {
          licenseKey: prev.key, email: prev.email,
          eventType:  "license_status_changed",
          detail:     { from: prev.prev_status, to: status, ls_event: eventName, subscription_id: subId }
        });
      }
      if (newPlan && newPlan !== prev.prev_plan) {
        await logEvent(db, {
          licenseKey: prev.key, email: prev.email,
          eventType:  "license_plan_changed",
          detail:     { from: prev.prev_plan, to: newPlan, ls_event: eventName, subscription_id: subId }
        });
      }
    }
    return c.json({ ok: true, event: eventName, status, expiresAt });
  }

  // Helper: read the license + email pair for a given subscription, used by
  // the events below to write a richer audit log.
  async function _licForSub(sub) {
    return await db.prepare(
      "SELECT l.key, u.email, l.status AS prev_status FROM licenses l LEFT JOIN users u ON u.id = l.user_id WHERE l.subscription_id = ?"
    ).bind(sub).first();
  }

  // ----- Payment failed → mark past_due, no expiry change ------------------
  if (eventName === "subscription_payment_failed") {
    if (!subId) return c.json({ ok: true });
    const prev = await _licForSub(subId);
    // Only a license that still has access enters past_due. The final failed
    // retry can arrive after subscription_updated(unpaid) mapped the license
    // to expired — it must not revive it into a fresh 3-day grace.
    if (prev && !["active", "trial", "past_due"].includes(prev.prev_status)) {
      return c.json({ ok: true, event: eventName, note: "ignored for status " + prev.prev_status });
    }
    // Stamp past_due_since ONLY on the first entry into past_due, so the 3-day
    // grace clock isn't reset by each of LS's ~4 dunning retries.
    if (prev && prev.prev_status === "past_due") {
      await db.prepare(
        "UPDATE licenses SET status = 'past_due', updated_at = ? WHERE subscription_id = ?"
      ).bind(nowMs(), subId).run();
    } else {
      await db.prepare(
        "UPDATE licenses SET status = 'past_due', past_due_since = ?, updated_at = ? WHERE subscription_id = ?"
      ).bind(nowMs(), nowMs(), subId).run();
    }
    if (prev) {
      await logEvent(db, {
        licenseKey: prev.key, email: prev.email,
        eventType:  "license_payment_failed",
        detail:     { from: prev.prev_status, to: "past_due", subscription_id: subId }
      });
    }
    return c.json({ ok: true, event: eventName });
  }

  // ----- Cancelled → user still has access until ends_at -------------------
  if (eventName === "subscription_cancelled") {
    if (!subId) return c.json({ ok: true });
    const prev = await _licForSub(subId);
    const endsAt = parseIsoMs(attrs.ends_at) || parseIsoMs(attrs.renews_at);
    if (endsAt) {
      await db.prepare(
        "UPDATE licenses SET status = 'cancelled', expires_at = ?, updated_at = ? WHERE subscription_id = ?"
      ).bind(endsAt, nowMs(), subId).run();
    } else {
      await db.prepare(
        "UPDATE licenses SET status = 'cancelled', updated_at = ? WHERE subscription_id = ?"
      ).bind(nowMs(), subId).run();
    }
    if (prev) {
      await logEvent(db, {
        licenseKey: prev.key, email: prev.email,
        eventType:  "license_status_changed",
        detail:     { from: prev.prev_status, to: "cancelled", access_until: endsAt, subscription_id: subId }
      });
    }
    return c.json({ ok: true, event: eventName });
  }

  // ----- Resumed (cancellation reversed) -----------------------------------
  if (eventName === "subscription_resumed") {
    if (!subId) return c.json({ ok: true });
    const prev = await _licForSub(subId);
    const newExpiresAt = parseIsoMs(attrs.renews_at);
    const sql = newExpiresAt
      ? "UPDATE licenses SET status = 'active', expires_at = ?, past_due_since = NULL, updated_at = ? WHERE subscription_id = ?"
      : "UPDATE licenses SET status = 'active', past_due_since = NULL, updated_at = ? WHERE subscription_id = ?";
    const binds = newExpiresAt ? [newExpiresAt, nowMs(), subId] : [nowMs(), subId];
    await db.prepare(sql).bind(...binds).run();
    if (prev) {
      await logEvent(db, {
        licenseKey: prev.key, email: prev.email,
        eventType:  "license_status_changed",
        detail:     { from: prev.prev_status, to: "active", reason: "resumed", subscription_id: subId }
      });
    }
    return c.json({ ok: true, event: eventName });
  }

  // ----- Subscription fully expired ----------------------------------------
  if (eventName === "subscription_expired") {
    if (!subId) return c.json({ ok: true });
    const prev = await _licForSub(subId);
    await db.prepare(
      "UPDATE licenses SET status = 'expired', updated_at = ? WHERE subscription_id = ?"
    ).bind(nowMs(), subId).run();
    if (prev) {
      await logEvent(db, {
        licenseKey: prev.key, email: prev.email,
        eventType:  "license_status_changed",
        detail:     { from: prev.prev_status, to: "expired", subscription_id: subId }
      });
    }
    return c.json({ ok: true, event: eventName });
  }

  // ----- Order refunded → kill the license ---------------------------------
  if (eventName === "order_refunded") {
    // LS sends the subscription event too for sub refunds; for one-time
    // we just log this. (We don't sell one-time products yet.)
    console.log("LS webhook: order_refunded — manual review may be needed");
    return c.json({ ok: true, event: eventName });
  }

  // ----- Anything else: log + 200 (so LS doesn't retry forever) ------------
  console.log("LS webhook: unhandled event", eventName);
  return c.json({ ok: true, event: eventName, note: "unhandled" });
});

// ---------------------------------------------------------------------------
// Admin: list ALL licenses with filters + free-text search. Used for customer
// support ("Anna can't activate — what's her status?", "how many active
// monthly subs do I have?", etc).
//
//   GET /v1/admin/list-licenses
//       ?status=active|trial|cancelled|past_due|expired   (optional, exact match)
//       &plan=monthly|annual|...                          (optional, exact match)
//       &q=substring                                      (optional, matches in
//                                                          email + license key,
//                                                          case-insensitive)
//       &limit=N                                          (default 100, max 500)
//       &offset=N                                         (default 0, for paging)
//
// Returns enriched records joined with user email + a machines_used count +
// per-license AI cost so you can see who's near the rate-limit. Includes
// a summary block at the top with totals broken down by status + plan.
// ---------------------------------------------------------------------------
app.get("/v1/admin/list-licenses", async (c) => {
  const auth = c.req.header("Authorization") || "";
  const expected = `Bearer ${c.env.ADMIN_TOKEN}`;
  if (!c.env.ADMIN_TOKEN || auth !== expected) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const status = String(c.req.query("status") || "").trim().toLowerCase();
  const plan   = String(c.req.query("plan")   || "").trim().toLowerCase();
  const q      = String(c.req.query("q")      || "").trim().toLowerCase();
  const limit  = Math.min(500, Math.max(1, parseInt(c.req.query("limit"), 10) || 100));
  const offset = Math.max(0, parseInt(c.req.query("offset"), 10) || 0);

  // Build WHERE clause from filters. Bind params positionally for D1.
  const where = [];
  const binds = [];
  if (status) { where.push("l.status = ?"); binds.push(status); }
  if (plan)   { where.push("l.plan = ?");   binds.push(plan); }
  if (q) {
    // Substring search across email + license key
    where.push("(LOWER(u.email) LIKE ? OR LOWER(l.key) LIKE ?)");
    binds.push("%" + q + "%", "%" + q + "%");
  }
  const whereClause = where.length ? "WHERE " + where.join(" AND ") : "";

  // Main listing query — join users for email, count machines per license.
  // ORDER BY created_at DESC so newest customers float to the top.
  const sql = `
    SELECT
      l.key,
      u.email,
      l.status,
      l.plan,
      l.expires_at,
      l.machines_allowed,
      (SELECT COUNT(*) FROM machines m WHERE m.license_key = l.key) AS machines_used,
      l.ai_cost_today_micro_usd  AS ai_cost_this_month_micro_usd,
      l.ai_calls_today           AS ai_calls_this_month,
      l.ai_calls_reset_at        AS ai_cost_reset_at,
      l.subscription_id,
      l.created_at,
      l.updated_at
    FROM licenses l
    LEFT JOIN users u ON u.id = l.user_id
    ${whereClause}
    ORDER BY l.created_at DESC
    LIMIT ? OFFSET ?
  `;
  const rs = await c.env.DB.prepare(sql).bind(...binds, limit, offset).all();
  const licenses = rs.results || [];

  // Total count for the same filters (without limit/offset)
  const countSql = `
    SELECT COUNT(*) AS n
    FROM licenses l
    LEFT JOIN users u ON u.id = l.user_id
    ${whereClause}
  `;
  const countRow = await c.env.DB.prepare(countSql).bind(...binds).first();
  const total = (countRow && countRow.n) || 0;

  // Summary aggregates by status + by plan, independent of filters so you
  // always see the big picture.
  const byStatusRs = await c.env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM licenses GROUP BY status ORDER BY n DESC"
  ).all();
  const byPlanRs = await c.env.DB.prepare(
    "SELECT plan, COUNT(*) AS n FROM licenses GROUP BY plan ORDER BY n DESC"
  ).all();

  const summary = {
    total_licenses: total,
    by_status: (byStatusRs.results || []).reduce((acc, r) => { acc[r.status || "unknown"] = r.n; return acc; }, {}),
    by_plan:   (byPlanRs.results   || []).reduce((acc, r) => { acc[r.plan   || "unknown"] = r.n; return acc; }, {}),
    monthly_ai_budget_micro_usd: monthlyBudgetMicroUsd(c.env)
  };

  return c.json({
    ok:       true,
    summary,
    filters:  { status: status || null, plan: plan || null, q: q || null, limit, offset },
    count:    licenses.length,
    licenses
  });
});

// ---------------------------------------------------------------------------
// Admin: deep-dive on a single customer — license(s), all machines, full
// event history, and a monthly AI-spend rollup. Used for customer support
// ("Anna sagt sie hat ein Problem — was ist passiert?").
//
//   GET /v1/admin/customer-detail?q=<email-or-key-or-partial>
//       &events_limit=N    (default 200, max 1000)
//
// `q` matches against email (substring, case-insensitive) AND license key
// (substring, case-insensitive). If multiple users/licenses match, returns
// all of them — narrow your search if you only want one.
// ---------------------------------------------------------------------------
app.get("/v1/admin/customer-detail", async (c) => {
  const auth = c.req.header("Authorization") || "";
  const expected = `Bearer ${c.env.ADMIN_TOKEN}`;
  if (!c.env.ADMIN_TOKEN || auth !== expected) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const q = String(c.req.query("q") || "").trim().toLowerCase();
  if (!q) return c.json({ error: "q query param required (email or license key, full or partial)" }, 400);
  const eventsLimit = Math.min(1000, Math.max(1, parseInt(c.req.query("events_limit"), 10) || 200));

  const db = c.env.DB;

  // Find every matching license — by user email or by license key substring.
  const licRs = await db.prepare(`
    SELECT
      l.key,
      l.user_id,
      u.email,
      u.customer_id           AS ls_customer_id,
      u.created_at            AS user_created_at,
      l.status,
      l.plan,
      l.expires_at,
      l.machines_allowed,
      l.subscription_id,
      l.ai_cost_today_micro_usd AS ai_cost_this_month_micro_usd,
      l.ai_calls_today          AS ai_calls_this_month,
      l.ai_calls_reset_at       AS ai_cost_reset_at,
      l.created_at,
      l.updated_at
    FROM licenses l
    LEFT JOIN users u ON u.id = l.user_id
    WHERE LOWER(u.email) LIKE ? OR LOWER(l.key) LIKE ?
    ORDER BY l.created_at DESC
  `).bind("%" + q + "%", "%" + q + "%").all();

  const licenses = licRs.results || [];
  if (licenses.length === 0) {
    return c.json({ ok: true, q, matches: 0, customers: [] });
  }

  // For each matching license, gather machines + events + monthly AI rollup.
  const customers = [];
  for (const lic of licenses) {
    // Machines on this license
    const machinesRs = await db.prepare(`
      SELECT fingerprint, os, app_version, first_seen_at, last_seen_at
      FROM machines
      WHERE license_key = ?
      ORDER BY last_seen_at DESC
    `).bind(lic.key).all();

    // What the panel shows for each machine (and what a customer reads out).
    const machinesOut = [];
    for (const m of (machinesRs.results || [])) {
      machinesOut.push(Object.assign({}, m, { display_id: await machineDisplayId(m.fingerprint) }));
    }

    // Recent events for this license, newest first
    const eventsRs = await db.prepare(`
      SELECT created_at, event_type, detail, cost_micro_usd
      FROM events
      WHERE license_key = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(lic.key, eventsLimit).all();

    // Monthly AI-spend rollup from events table (full history, not just this month).
    // strftime turns ms-epoch into a "YYYY-MM" bucket.
    const monthlyRs = await db.prepare(`
      SELECT
        strftime('%Y-%m', created_at / 1000, 'unixepoch') AS month,
        SUM(cost_micro_usd)                                AS total_micro_usd,
        COUNT(*)                                           AS calls
      FROM events
      WHERE license_key = ? AND event_type = 'ai_call'
      GROUP BY month
      ORDER BY month DESC
    `).bind(lic.key).all();

    customers.push({
      // License + user info
      key:              lic.key,
      email:            lic.email,
      ls_customer_id:   lic.ls_customer_id,
      user_created_at:  lic.user_created_at,
      status:           lic.status,
      plan:             lic.plan,
      expires_at:       lic.expires_at,
      machines_allowed: lic.machines_allowed,
      subscription_id:  lic.subscription_id,
      created_at:       lic.created_at,
      updated_at:       lic.updated_at,
      // Direct link to Lemon Squeezy backend for billing-side history
      lemon_squeezy_url: lic.subscription_id
        ? `https://app.lemonsqueezy.com/subscriptions/${lic.subscription_id}`
        : null,
      // Live counters (current month)
      ai_cost_this_month_micro_usd: lic.ai_cost_this_month_micro_usd || 0,
      ai_calls_this_month:          lic.ai_calls_this_month || 0,
      ai_cost_reset_at:             lic.ai_cost_reset_at,
      ai_cost_limit_micro_usd:      monthlyBudgetMicroUsd(c.env),
      // Joined data
      machines:        machinesOut,
      events:          (eventsRs.results || []).map(e => ({
        created_at:     e.created_at,
        event_type:     e.event_type,
        detail:         e.detail ? safeJsonParse(e.detail) : null,
        cost_micro_usd: e.cost_micro_usd || 0
      })),
      monthly_ai_spend: monthlyRs.results || []
    });
  }

  return c.json({
    ok:      true,
    q,
    matches: customers.length,
    customers
  });
});

// Helper used by customer-detail when re-hydrating JSON-encoded event detail
function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}

// ---------------------------------------------------------------------------
// Admin: look up license(s) by email — used during testing to retrieve the
// key the webhook minted, before we have proper email delivery.
// ---------------------------------------------------------------------------
app.get("/v1/admin/find-license", async (c) => {
  const auth = c.req.header("Authorization") || "";
  const expected = `Bearer ${c.env.ADMIN_TOKEN}`;
  if (!c.env.ADMIN_TOKEN || auth !== expected) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const email = String(c.req.query("email") || "").toLowerCase().trim();
  if (!email) return c.json({ error: "email query param required" }, 400);

  const user = await c.env.DB.prepare(
    "SELECT * FROM users WHERE email = ?"
  ).bind(email).first();
  if (!user) return c.json({ ok: true, licenses: [] });

  const rs = await c.env.DB.prepare(
    "SELECT key, plan, status, expires_at, machines_allowed, subscription_id, created_at FROM licenses WHERE user_id = ? ORDER BY created_at DESC"
  ).bind(user.id).all();
  return c.json({ ok: true, email, licenses: rs.results || [] });
});

// ---------------------------------------------------------------------------
// 404 fallback
// ---------------------------------------------------------------------------
app.notFound((c) => c.json({ error: "not found", path: c.req.path }, 404));

app.onError((err, c) => {
  console.error("Worker error:", err);
  return c.json({ error: err.message || "internal error" }, 500);
});

// ---------------------------------------------------------------------------
// Admin: free a machine slot for a customer (support case "machine limit
// reached" with a stale machine). The machine is addressed by row id, the
// display id the panel shows, a full fingerprint or a unique fingerprint
// prefix (customer-detail prints both).
//   POST /v1/admin/remove-machine  { licenseKey, machineId? | displayId? | fingerprint? }
// ---------------------------------------------------------------------------
app.post("/v1/admin/remove-machine", async (c) => {
  const auth = c.req.header("Authorization") || "";
  const expected = `Bearer ${c.env.ADMIN_TOKEN}`;
  if (!c.env.ADMIN_TOKEN || auth !== expected) {
    return c.json({ error: "unauthorized" }, 401);
  }
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "invalid JSON" }, 400); }
  const licenseKey = String(body.licenseKey || "").trim().toUpperCase();
  if (!licenseKey) return c.json({ error: "licenseKey required" }, 400);
  const db  = c.env.DB;
  const lic = await findLicense(db, licenseKey);
  if (!lic) return c.json({ error: "license not found" }, 404);
  const target = await findMachine(db, licenseKey, { machineId: body.machineId, fingerprint: body.fingerprint, displayId: body.displayId, allowPrefix: true });
  if (!target) {
    const machines = await listMachines(db, licenseKey, "");
    return c.json({ error: "machine not found (or prefix not unique)", machines }, 404);
  }
  await releaseMachine(db, licenseKey, target, { reason: "admin", by: "admin" });
  const machines = await listMachines(db, licenseKey, "");
  return c.json({ ok: true, removed: await machineView(target, ""), machines, machinesUsed: machines.length, machinesAllowed: lic.machines_allowed || 2 });
});

// ---------------------------------------------------------------------------
// Admin: correct a license status (used by admin-sync-unpaid.ps1 to retire
// licenses whose Lemon Squeezy subscription went "unpaid" before the webhook
// mapped that status). Logged like a webhook status change.
//   POST /v1/admin/set-license-status  { licenseKey, status, reason?, expiresAt? | days? }
// ---------------------------------------------------------------------------
app.post("/v1/admin/set-license-status", async (c) => {
  const auth = c.req.header("Authorization") || "";
  const expected = `Bearer ${c.env.ADMIN_TOKEN}`;
  if (!c.env.ADMIN_TOKEN || auth !== expected) {
    return c.json({ error: "unauthorized" }, 401);
  }
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "invalid JSON" }, 400); }
  const licenseKey = String(body.licenseKey || "").trim().toUpperCase();
  const status     = String(body.status || "").trim().toLowerCase();
  const reason     = String(body.reason || "").slice(0, 200);
  const ALLOWED = ["active", "trial", "past_due", "cancelled", "expired"];
  if (!licenseKey) return c.json({ error: "licenseKey required" }, 400);
  if (!ALLOWED.includes(status)) return c.json({ error: "status must be one of " + ALLOWED.join(", ") }, 400);
  const db  = c.env.DB;
  const lic = await findLicense(db, licenseKey);
  if (!lic) return c.json({ error: "license not found" }, 404);
  // Optional new expiry (ms) or +days; "active"/"trial" with an expiry in the
  // past would report success while isLicenseUsable keeps rejecting it.
  const nowTs = nowMs();
  let newExpires = null;
  if (body.expiresAt != null) newExpires = parseInt(body.expiresAt, 10) || null;
  else if (body.days != null) newExpires = nowTs + (parseInt(body.days, 10) || 0) * 24 * 60 * 60 * 1000;
  const effectiveExpires = newExpires != null ? newExpires : lic.expires_at;
  if ((status === "active" || status === "trial") && effectiveExpires && effectiveExpires < nowTs) {
    return c.json({ error: "expires_at is in the past; pass expiresAt (ms) or days to extend the license", expires_at: lic.expires_at }, 400);
  }
  if (lic.status === status && newExpires == null) return c.json({ ok: true, changed: false, status });
  // Entering past_due here is always a fresh entry (a stale stamp from an
  // earlier past_due period would end the 3-day grace at once).
  await db.prepare(
    "UPDATE licenses SET status = ?, expires_at = COALESCE(?, expires_at), past_due_since = CASE WHEN ? = 'past_due' THEN ? ELSE NULL END, updated_at = ? WHERE key = ?"
  ).bind(status, newExpires, status, nowTs, nowTs, licenseKey).run();
  const u = await db.prepare("SELECT email FROM users WHERE id = ?").bind(lic.user_id).first();
  await logEvent(db, {
    licenseKey, email: u ? u.email : null,
    eventType:  "license_status_changed",
    detail:     { from: lic.status, to: status, by: "admin", reason: reason || null, expiresAt: newExpires }
  });
  return c.json({ ok: true, changed: true, from: lic.status, status, expiresAt: effectiveExpires });
});

export default app;
