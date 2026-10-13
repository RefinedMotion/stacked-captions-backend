// Integration tests for the Worker's license endpoints: the REAL Hono app
// (src/index.js) on an in-memory SQLite that mimics D1 (prepare / bind /
// first / all / run), schema from schema/*.sql. Needs Node 22.5+ (node:sqlite).
//   npm test
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

const app = (await import("../src/index.js")).default;

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) {
    this.args = a.map((v) => { if (v === undefined) throw new Error("D1: cannot bind undefined"); return v; });
    return this;
  }
  async first(col) {
    const row = this.db.prepare(this.sql).get(...this.args);
    if (row === undefined) return null;
    return col ? row[col] : row;
  }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args), success: true, meta: {} }; }
  async run() { const info = this.db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } }; }
}
const sqlite = new DatabaseSync(":memory:");
for (const f of ["init.sql", "add-events.sql"]) sqlite.exec(fs.readFileSync(new URL("../schema/" + f, import.meta.url), "utf8"));
const DB = { prepare: (sql) => new Stmt(sqlite, sql) };
const env = {
  DB, ADMIN_TOKEN: "admin-test", TOKEN_SECRET: "secret-test",
  LS_VARIANT_MONTHLY: "1659438", LS_VARIANT_ANNUAL: "1659439",
  MONTHLY_AI_BUDGET_USD: "1.00", ANNUAL_AI_BUDGET_USD: "2.00", APP_ENV: "test",
};
globalThis.fetch = async (url) => { throw new Error("unexpected outbound fetch in test: " + url); };

async function call(path, body, headers, method = "POST") {
  const res = await app.request(path, {
    method,
    headers: Object.assign({ "content-type": "application/json" }, headers || {}),
    body: body ? JSON.stringify(body) : undefined,
  }, env);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const ADMIN = { Authorization: "Bearer admin-test" };
let passes = 0, fails = 0;
function assert(cond, name, info) {
  if (cond) { passes++; console.log("  PASS " + name); }
  else { fails++; console.log("  FAIL " + name + (info !== undefined ? "  -> " + JSON.stringify(info).slice(0, 400) : "")); }
}
function events(type, key) {
  return sqlite.prepare("SELECT * FROM events WHERE event_type = ? AND (? IS NULL OR license_key = ?) ORDER BY id").all(type, key ?? null, key ?? null)
    .map((e) => Object.assign({}, e, { detail: e.detail ? JSON.parse(e.detail) : null }));
}
async function sha8(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf).slice(0, 4)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const DAY = 24 * 60 * 60 * 1000;
const HEX8 = /^[0-9a-f]{8}$/;

console.log("=== (1) slots: activate / limit / list / release ===");
const mk = await call("/v1/admin/create-license", { email: "slots@example.com", plan: "monthly", status: "active", days: 30 }, ADMIN);
assert(mk.status === 200 && /^SC-/.test(mk.json.licenseKey) && mk.json.machinesAllowed === 2, "admin create-license", mk.json);
const KEY = mk.json.licenseKey;
const FP_A = "sc-m-a1b2c3d", FP_B = "sc-m-b2c3d4e", FP_C = "sc-m-c3d4e5f";   // real fingerprints: sc-m- + up to 8 hex
const a1 = await call("/v1/activate", { licenseKey: KEY, fingerprint: FP_A, os: "win32 10.0.26200", appVersion: "1.0.9" });
assert(a1.status === 200 && a1.json.ok && a1.json.machinesUsed === 1 && a1.json.machinesAllowed === 2, "activate machine A", a1.json);
const a2 = await call("/v1/activate", { licenseKey: KEY, fingerprint: FP_B, os: "darwin 23.0", appVersion: "1.1.0" });
assert(a2.status === 200 && a2.json.machinesUsed === 2, "activate machine B", a2.json);
const a3 = await call("/v1/activate", { licenseKey: KEY, fingerprint: FP_C, os: "win32 11", appVersion: "1.1.0" });
assert(a3.status === 403 && a3.json.error === "machine limit reached" && Array.isArray(a3.json.machines) && a3.json.machines.length === 2
       && a3.json.machinesUsed === 2 && a3.json.machinesAllowed === 2 && /Manage machines/.test(a3.json.hint), "third machine -> 403 with the machine list", a3.json);
const m0 = a3.json.machines[0];
const rawLeak = JSON.stringify(a3.json).indexOf(FP_A) >= 0 || JSON.stringify(a3.json).indexOf(FP_B) >= 0;
assert(typeof m0.id === "number" && HEX8.test(m0.displayId) && !("fp" in m0) && !("fingerprint" in m0) && !rawLeak && typeof m0.os === "string"
       && typeof m0.appVersion === "string" && m0.firstSeenAt > 0 && m0.lastSeenAt > 0 && m0.current === false, "403 rows carry id + 8-hex display id (never the fingerprint), os, version, dates, current=false", m0);
const list = await call("/v1/machines", { licenseKey: KEY, fingerprint: FP_A });
const cur = list.json.machines.find((m) => m.current);
assert(list.status === 200 && list.json.machines.length === 2 && list.json.machines.filter((m) => m.current).length === 1
       && cur.displayId === await sha8(FP_A) && list.json.machinesUsed === 2 && JSON.stringify(list.json).indexOf(FP_A) < 0,
       "/v1/machines lists both, marks the caller as current, display id = sha256(fingerprint)[0..8]", list.json);
const idA = cur.id, idB = list.json.machines.find((m) => !m.current).id;
assert(a3.json.machines.find((m) => m.id === idB).displayId === list.json.machines.find((m) => m.id === idB).displayId, "display id is stable across endpoints", null);
const list404 = await call("/v1/machines", { licenseKey: "SC-NOPE-NOPE-NOPE-NOPE-NOPE-NOPE" });
assert(list404.status === 404, "/v1/machines unknown key -> 404", list404.json);
const listNoKey = await call("/v1/machines", { fingerprint: FP_A });
assert(listNoKey.status === 400, "/v1/machines without key -> 400", listNoKey.json);
const dPrefix = await call("/v1/deactivate", { licenseKey: KEY, fingerprint: FP_A.slice(0, 11) });
assert(dPrefix.status === 200 && dPrefix.json.removed === 0 && dPrefix.json.machinesUsed === 2, "self-service: a fingerprint PREFIX releases nothing (exact match only)", dPrefix.json);
const d1 = await call("/v1/deactivate", { licenseKey: KEY, fingerprint: FP_C, machineId: idB });
assert(d1.status === 200 && d1.json.removed === 1 && d1.json.machinesUsed === 1 && d1.json.machines.length === 1 && d1.json.machines[0].id === idA,
       "deactivate by machineId from a third machine releases B", d1.json);
const ev1 = events("machine_deactivated", KEY);
assert(ev1.length === 1 && ev1[0].detail.machineId === idB && ev1[0].detail.fingerprint === FP_B.slice(0, 14) && ev1[0].detail.self === false
       && ev1[0].detail.by === FP_C.slice(0, 14) && ev1[0].detail.reason === "self_service", "event machine_deactivated (self=false, by=caller prefix)", ev1);
const a3b = await call("/v1/activate", { licenseKey: KEY, fingerprint: FP_C, os: "win32 11", appVersion: "1.1.0" });
assert(a3b.status === 200 && a3b.json.machinesUsed === 2, "machine C activates once the slot is free", a3b.json);
const hbB = await call("/v1/heartbeat", { licenseKey: KEY, fingerprint: FP_B });
assert(hbB.status === 403 && /not activated/.test(hbB.json.error), "released machine B: heartbeat -> 403", hbB.json);
const dSelf = await call("/v1/deactivate", { licenseKey: KEY, fingerprint: FP_C });
assert(dSelf.status === 200 && dSelf.json.removed === 1 && dSelf.json.machinesUsed === 1, "Sign out: deactivate by own fingerprint", dSelf.json);
const ev2 = events("machine_deactivated", KEY);
assert(ev2.length === 2 && ev2[1].detail.self === true && ev2[1].detail.fingerprint === FP_C.slice(0, 14), "event marks a self sign-out", ev2[1]);
const hbC = await call("/v1/heartbeat", { licenseKey: KEY, fingerprint: FP_C });
assert(hbC.status === 403, "signed-out machine C: heartbeat -> 403", hbC.json);
const dAgain = await call("/v1/deactivate", { licenseKey: KEY, fingerprint: FP_C });
assert(dAgain.status === 200 && dAgain.json.removed === 0 && dAgain.json.machinesUsed === 1, "deactivate again -> removed 0 (idempotent)", dAgain.json);
const dBad = await call("/v1/deactivate", { licenseKey: KEY });
assert(dBad.status === 400, "deactivate without fingerprint/machineId -> 400", dBad.json);
const d404 = await call("/v1/deactivate", { licenseKey: "SC-NOPE-NOPE-NOPE-NOPE-NOPE-NOPE", fingerprint: FP_C });
assert(d404.status === 404, "deactivate unknown key -> 404", d404.json);

console.log("\n=== (2) ownership: a machineId of another license is not released ===");
const mk2 = await call("/v1/admin/create-license", { email: "other@example.com", plan: "annual", status: "active", days: 365 }, ADMIN);
const KEY2 = mk2.json.licenseKey;
const o1 = await call("/v1/activate", { licenseKey: KEY2, fingerprint: "sc-m-d4e5f60", os: "darwin", appVersion: "1.1.0" });
const idD = (await call("/v1/machines", { licenseKey: KEY2 })).json.machines[0].id;
const dx = await call("/v1/deactivate", { licenseKey: KEY, fingerprint: FP_A, machineId: idD });
const l2 = await call("/v1/machines", { licenseKey: KEY2 });
assert(o1.status === 200 && dx.status === 200 && dx.json.removed === 0 && l2.json.machines.length === 1, "machineId of another license -> removed 0, other license untouched", { dx: dx.json, l2: l2.json });

console.log("\n=== (3) idle eviction on activate (30 days) ===");
const FP_E = "sc-m-e5f6071", FP_F = "sc-m-f607182", FP_G = "sc-m-0718293";
const e1 = await call("/v1/activate", { licenseKey: KEY, fingerprint: FP_E, os: "win32", appVersion: "1.1.0" });
assert(e1.status === 200 && e1.json.machinesUsed === 2, "license full again (A + E)", e1.json);
sqlite.prepare("UPDATE machines SET last_seen_at = ? WHERE license_key = ? AND fingerprint = ?").run(Date.now() - 31 * DAY, KEY, FP_A);
const f1 = await call("/v1/activate", { licenseKey: KEY, fingerprint: FP_F, os: "win32", appVersion: "1.1.0" });
const lf = await call("/v1/machines", { licenseKey: KEY, fingerprint: FP_F });
assert(f1.status === 200 && f1.json.machinesUsed === 2 && lf.json.machines.length === 2 && !lf.json.machines.find((m) => m.id === idA)
       && lf.json.machines.find((m) => m.current), "machine A unseen for 31 days yields its slot to F (no 403)", { f1: f1.json, lf: lf.json });
const evE = events("machine_deactivated", KEY).filter((e) => e.detail.reason === "idle_evicted");
assert(evE.length === 1 && evE[0].detail.fingerprint === FP_A.slice(0, 14) && evE[0].detail.replacedBy === FP_F.slice(0, 14), "event machine_deactivated reason idle_evicted", evE);
sqlite.prepare("UPDATE machines SET last_seen_at = ? WHERE license_key = ? AND fingerprint = ?").run(Date.now() - 10 * DAY, KEY, FP_E);
const g1 = await call("/v1/activate", { licenseKey: KEY, fingerprint: FP_G, os: "win32", appVersion: "1.1.0" });
assert(g1.status === 403 && g1.json.machines.length === 2, "machines seen within 30 days are not evicted -> 403", g1.json);
const evA = events("machine_activated", KEY);
assert(evA.length === 5, "machine_activated logged once per new machine (A,B,C,E,F)", evA.length);

console.log("\n=== (4) admin remove-machine ===");
const r401 = await call("/v1/admin/remove-machine", { licenseKey: KEY, fingerprint: FP_F }, { Authorization: "Bearer wrong" });
assert(r401.status === 401, "remove-machine without admin token -> 401", r401.json);
const rShort = await call("/v1/admin/remove-machine", { licenseKey: KEY, fingerprint: "sc-m-" }, ADMIN);
assert(rShort.status === 404 && Array.isArray(rShort.json.machines) && rShort.json.machines.length === 2, "too-short prefix -> 404 with the list", rShort.json);
const rWild = await call("/v1/admin/remove-machine", { licenseKey: KEY, fingerprint: "sc-m-f60%" }, ADMIN);
assert(rWild.status === 404, "LIKE wildcards in a prefix are escaped (no match)", rWild.json);
const rUnder = await call("/v1/admin/remove-machine", { licenseKey: KEY, fingerprint: "sc-m-____________" }, ADMIN);
assert(rUnder.status === 404, "underscore wildcards are escaped too", rUnder.json);
const rPrefix = await call("/v1/admin/remove-machine", { licenseKey: KEY, fingerprint: FP_F.slice(0, 10) }, ADMIN);
assert(rPrefix.status === 200 && rPrefix.json.removed.displayId === await sha8(FP_F) && !("fp" in rPrefix.json.removed) && rPrefix.json.machinesUsed === 1, "unique prefix removes machine F (display id in the answer)", rPrefix.json);
const evAdm = events("machine_deactivated", KEY).filter((e) => e.detail.reason === "admin");
assert(evAdm.length === 1 && evAdm[0].detail.by === "admin", "event reason admin", evAdm);
const dispE = (await call("/v1/machines", { licenseKey: KEY })).json.machines[0].displayId;
const rDisp = await call("/v1/admin/remove-machine", { licenseKey: KEY, displayId: dispE.toUpperCase() }, ADMIN);
assert(rDisp.status === 200 && rDisp.json.machinesUsed === 0 && rDisp.json.removed.displayId === dispE, "remove by display id (case-insensitive)", rDisp.json);
const h1 = await call("/v1/activate", { licenseKey: KEY, fingerprint: "sc-m-1829304", os: "win32", appVersion: "1.1.0" });
const idH = (await call("/v1/machines", { licenseKey: KEY })).json.machines[0].id;
const rId = await call("/v1/admin/remove-machine", { licenseKey: KEY, machineId: idH }, ADMIN);
assert(h1.status === 200 && rId.status === 200 && rId.json.machinesUsed === 0, "remove by machineId", rId.json);
const rNone = await call("/v1/admin/remove-machine", { licenseKey: KEY, machineId: idH }, ADMIN);
assert(rNone.status === 404, "removing an unknown machine -> 404", rNone.json);

console.log("\n=== (5) webhook: invoice events + LS \"unpaid\" -> expired (B15) ===");
const wh = (name, id, attrs) => call("/v1/webhooks/lemon-squeezy", { meta: { event_name: name }, data: { id: String(id), attributes: attrs } });
const renews = new Date(Date.now() + 30 * DAY).toISOString();
const c1 = await wh("subscription_created", 9001, { user_email: "wh@example.com", customer_id: 777, variant_id: 1659438, status: "active", renews_at: renews });
assert(c1.status === 200 && c1.json.ok && /^SC-/.test(c1.json.licenseKey) && c1.json.status === "active", "subscription_created mints an active license (no email key -> no send)", c1.json);
const WKEY = c1.json.licenseKey;
// payment events carry a subscription INVOICE: data.id = invoice id, attributes.subscription_id = the subscription
const renews2 = new Date(Date.now() + 60 * DAY).toISOString();
const p0 = await wh("subscription_payment_success", 550001, { subscription_id: 9001, user_email: "wh@example.com", billing_reason: "renewal", status: "paid", renews_at: renews2 });
const licP0 = sqlite.prepare("SELECT status, expires_at FROM licenses WHERE key = ?").get(WKEY);
assert(p0.status === 200 && licP0.expires_at === Date.parse(renews2) && events("license_renewed", WKEY).length === 1, "subscription_payment_success (invoice object) extends expires_at via attributes.subscription_id", { p0: p0.json, licP0 });
assert(sqlite.prepare("SELECT COUNT(*) AS n FROM licenses WHERE subscription_id = '550001'").get().n === 0 && events("license_subscription_linked").length === 0, "the invoice id is never adopted as a subscription id", null);
const pf = await wh("subscription_payment_failed", 550002, { subscription_id: 9001, user_email: "wh@example.com", billing_reason: "renewal", status: "pending" });
const licPf = sqlite.prepare("SELECT status, past_due_since FROM licenses WHERE key = ?").get(WKEY);
assert(pf.status === 200 && licPf.status === "past_due" && licPf.past_due_since > 0, "subscription_payment_failed (invoice object) -> past_due", licPf);
const pr = await wh("subscription_payment_recovered", 550002, { subscription_id: 9001, user_email: "wh@example.com", status: "paid", renews_at: renews2 });
const licPr = sqlite.prepare("SELECT status, past_due_since FROM licenses WHERE key = ?").get(WKEY);
assert(pr.status === 200 && licPr.status === "active" && licPr.past_due_since === null, "subscription_payment_recovered -> active, grace stamp cleared", licPr);
const u1 = await wh("subscription_updated", 9001, { user_email: "wh@example.com", variant_id: 1659438, status: "unpaid", renews_at: renews });
const licU = sqlite.prepare("SELECT status, past_due_since FROM licenses WHERE key = ?").get(WKEY);
assert(u1.status === 200 && u1.json.status === "expired" && licU.status === "expired" && licU.past_due_since === null, "subscription_updated unpaid -> license expired", { u1: u1.json, licU });
const evS = events("license_status_changed", WKEY);
assert(evS.length >= 1 && evS[evS.length - 1].detail.from === "active" && evS[evS.length - 1].detail.to === "expired", "status change logged active -> expired", evS);
const pfLate = await wh("subscription_payment_failed", 550003, { subscription_id: 9001, user_email: "wh@example.com", status: "pending" });
const licLate = sqlite.prepare("SELECT status, past_due_since FROM licenses WHERE key = ?").get(WKEY);
assert(pfLate.status === 200 && /ignored/.test(pfLate.json.note || "") && licLate.status === "expired" && licLate.past_due_since === null, "a late payment_failed does not revive an expired license into past_due", { pfLate: pfLate.json, licLate });
const actX = await call("/v1/activate", { licenseKey: WKEY, fingerprint: "sc-m-2930415", os: "win32", appVersion: "1.1.0" });
assert(actX.status === 403 && /license expired/.test(actX.json.error), "expired license cannot activate", actX.json);
const p1 = await wh("subscription_payment_success", 550004, { subscription_id: 9001, user_email: "wh@example.com", status: "paid", renews_at: new Date(Date.now() + 90 * DAY).toISOString() });
const licP = sqlite.prepare("SELECT status FROM licenses WHERE key = ?").get(WKEY);
assert(p1.status === 200 && licP.status === "active", "a later payment_success reactivates", licP);
const c2 = await wh("subscription_created", 9002, { user_email: "wh2@example.com", customer_id: 778, variant_id: 1659439, status: "unpaid", renews_at: renews });
assert(c2.status === 200 && c2.json.status === "expired", "subscription_created with unpaid -> expired", c2.json);
// self-heal still links a manually minted (orphan) license on a subscription event of the same email
const mk3 = await call("/v1/admin/create-license", { email: "orphan@example.com", plan: "monthly", status: "active", days: 30 }, ADMIN);
const u3 = await wh("subscription_updated", 9003, { user_email: "orphan@example.com", variant_id: 1659438, status: "active", renews_at: renews2 });
const lic3 = sqlite.prepare("SELECT subscription_id, expires_at FROM licenses WHERE key = ?").get(mk3.json.licenseKey);
assert(u3.status === 200 && lic3.subscription_id === "9003" && lic3.expires_at === Date.parse(renews2), "orphan license adopts the subscription id from a subscription event (self-heal kept)", lic3);

console.log("\n=== (5b) webhook: test-mode events are ignored ===");
const tm = await call("/v1/webhooks/lemon-squeezy", { meta: { event_name: "subscription_created", test_mode: true }, data: { id: "7001", attributes: { user_email: "testmode@example.com", customer_id: 1, variant_id: 1659298, status: "on_trial", renews_at: renews } } });
const tmLic = sqlite.prepare("SELECT COUNT(*) AS n FROM licenses l JOIN users u ON u.id = l.user_id WHERE u.email = 'testmode@example.com'").get().n;
const tmEv = events("webhook_rejected").filter((e) => e.detail && e.detail.reason === "test_mode");
assert(tm.status === 200 && tm.json.ignored === "test_mode" && tmLic === 0 && tmEv.length === 1 && tmEv[0].email === "testmode@example.com" && tmEv[0].detail.variant_id === "1659298", "a test-mode subscription_created mints nothing and is logged as webhook_rejected/test_mode", { tm: tm.json, tmLic, tmEv });
const tmU = await call("/v1/webhooks/lemon-squeezy", { meta: { event_name: "subscription_updated", test_mode: true }, data: { id: "9001", attributes: { user_email: "wh@example.com", variant_id: 1659438, status: "expired", renews_at: renews } } });
const licAfterTm = sqlite.prepare("SELECT status FROM licenses WHERE key = ?").get(WKEY);
assert(tmU.status === 200 && tmU.json.ignored === "test_mode" && licAfterTm.status === "active", "a test-mode subscription_updated never touches a live license", { tmU: tmU.json, licAfterTm });
const live = await call("/v1/webhooks/lemon-squeezy", { meta: { event_name: "subscription_updated", test_mode: false }, data: { id: "9001", attributes: { user_email: "wh@example.com", variant_id: 1659438, status: "active", renews_at: renews } } });
assert(live.status === 200 && !live.json.ignored, "meta.test_mode false is processed normally", live.json);

console.log("\n=== (6) admin set-license-status ===");
const s401 = await call("/v1/admin/set-license-status", { licenseKey: KEY, status: "expired" }, { Authorization: "Bearer nope" });
assert(s401.status === 401, "set-license-status without admin token -> 401", s401.json);
const sBad = await call("/v1/admin/set-license-status", { licenseKey: KEY, status: "void" }, ADMIN);
assert(sBad.status === 400, "invalid status -> 400", sBad.json);
const sPd = await call("/v1/admin/set-license-status", { licenseKey: KEY, status: "past_due", reason: "test" }, ADMIN);
const licPd = sqlite.prepare("SELECT status, past_due_since FROM licenses WHERE key = ?").get(KEY);
assert(sPd.status === 200 && sPd.json.changed === true && licPd.status === "past_due" && licPd.past_due_since > 0, "active -> past_due stamps past_due_since", { sPd: sPd.json, licPd });
sqlite.prepare("UPDATE licenses SET past_due_since = ? WHERE key = ?").run(Date.now() - 10 * DAY, KEY);   // old stamp from an earlier period
await call("/v1/admin/set-license-status", { licenseKey: KEY, status: "cancelled" }, ADMIN);
const sPd2 = await call("/v1/admin/set-license-status", { licenseKey: KEY, status: "past_due" }, ADMIN);
const licPd2 = sqlite.prepare("SELECT status, past_due_since FROM licenses WHERE key = ?").get(KEY);
assert(sPd2.status === 200 && licPd2.status === "past_due" && Date.now() - licPd2.past_due_since < 60 * 1000, "re-entering past_due gets a FRESH grace stamp (no stale stamp kept)", licPd2);
const sEx = await call("/v1/admin/set-license-status", { licenseKey: KEY, status: "expired", reason: "LS unpaid sync" }, ADMIN);
const licEx = sqlite.prepare("SELECT status, past_due_since FROM licenses WHERE key = ?").get(KEY);
assert(sEx.status === 200 && sEx.json.from === "past_due" && licEx.status === "expired" && licEx.past_due_since === null, "past_due -> expired clears past_due_since", { sEx: sEx.json, licEx });
const sSame = await call("/v1/admin/set-license-status", { licenseKey: KEY, status: "expired" }, ADMIN);
assert(sSame.status === 200 && sSame.json.changed === false, "same status -> changed false, no event", sSame.json);
sqlite.prepare("UPDATE licenses SET expires_at = ? WHERE key = ?").run(Date.now() - DAY, KEY);
const sActPast = await call("/v1/admin/set-license-status", { licenseKey: KEY, status: "active" }, ADMIN);
assert(sActPast.status === 400 && /expires_at is in the past/.test(sActPast.json.error), "active with an expiry in the past -> 400 with hint (would stay locked)", sActPast.json);
const sActDays = await call("/v1/admin/set-license-status", { licenseKey: KEY, status: "active", days: 30, reason: "goodwill" }, ADMIN);
const licAct = sqlite.prepare("SELECT status, expires_at FROM licenses WHERE key = ?").get(KEY);
assert(sActDays.status === 200 && licAct.status === "active" && licAct.expires_at > Date.now() + 29 * DAY, "active with days=30 extends the expiry", licAct);
const actOk = await call("/v1/activate", { licenseKey: KEY, fingerprint: "sc-m-3041526", os: "win32", appVersion: "1.1.0" });
assert(actOk.status === 200, "the extended license activates again", actOk.json);
const evAdmS = events("license_status_changed", KEY).filter((e) => e.detail.by === "admin");
assert(evAdmS.length >= 4 && evAdmS[evAdmS.length - 1].detail.reason === "goodwill" && evAdmS[evAdmS.length - 1].email === "slots@example.com", "admin status changes logged with reason + email", evAdmS.slice(-1));
const mExp = await call("/v1/machines", { licenseKey: WKEY });
assert(mExp.status === 200, "listing machines works regardless of license status", mExp.json);

console.log("\n" + passes + " passed, " + fails + " failed");
process.exit(fails ? 1 : 0);
