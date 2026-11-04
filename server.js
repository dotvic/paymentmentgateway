"use strict";
// DryRun: hosted payment-gateway sandbox API. Zero dependencies, Node 18+.
const http = require("http"), crypto = require("crypto"), fs = require("fs"), dns = require("dns").promises, net = require("net");
const TDS = require("./tds");
const SCH = require("./schemes");

const PORT = +process.env.PORT || 8080;
const DATA_FILE = process.env.DATA_FILE || "./data.json";
const SIGNUP_TOKEN = process.env.SIGNUP_TOKEN || "";
const MAX_ACCOUNTS = +process.env.MAX_ACCOUNTS || 2000;
const MAX_PAYMENTS_PER_ACCOUNT = 500;
const PUBLIC_DIR = require("path").join(__dirname, "public");
// Behind Fly's proxy the socket address is the proxy, so use the header it sets (only trusted on Fly).
const clientIp = (req) => (process.env.FLY_APP_NAME && req.headers["fly-client-ip"]) || req.socket.remoteAddress || "?";
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_WEBHOOKS === "1";
const RETRY_MS = (process.env.RETRY_MS || "0,2000,10000,30000").split(",").map(Number);
const SETTLE_MS = process.env.SETTLE_DELAY_MS ? +process.env.SETTLE_DELAY_MS : 3000;
const PLANS = { free: { monthly: 200, rpm: 30 }, pro: { monthly: 20000, rpm: 300 } };
const TRIAL_DAYS = process.env.TRIAL_DAYS === undefined ? 14 : Math.max(0, +process.env.TRIAL_DAYS || 0);
const trialActive = (a) => !!(a.trial && Date.parse(a.trial.ends) > Date.now());
// The plan that applies right now: a paid subscription or an active free trial both give Pro.
const planOf = (a) => (a.plan === "pro" || trialActive(a) ? "pro" : "free");
function requirePro(a, what) {
  if (planOf(a) !== "pro") throw bad(402, "pro_required", `${what} is included in Pro and in the free trial. Confirm your email to start the ${TRIAL_DAYS}-day trial, or upgrade to Pro.`);
}

// ---------- billing (Stripe) and legal pages: configured with environment variables ----------
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_PRICE = process.env.STRIPE_PRICE_ID || "";
const STRIPE_WH_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_BASE = (process.env.STRIPE_API_BASE || "https://api.stripe.com").replace(/\/$/, "");
const PRO_LABEL = process.env.PRO_PRICE_LABEL || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || (process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : `http://localhost:${PORT}`)).replace(/\/$/, "");
const billingOn = () => !!(STRIPE_KEY && STRIPE_PRICE && STRIPE_WH_SECRET);
const INACTIVE_DAYS = 365;
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LEGAL = {
  OPERATOR: process.env.OPERATOR_NAME || "[operator name not set]",
  ADDRESS: process.env.OPERATOR_ADDRESS || "[operator address not set]",
  EMAIL: process.env.CONTACT_EMAIL || "[contact email not set]",
  BACKUPHOST: process.env.BACKUP_PROVIDER_NAME || "Tigris Data, Inc., via Fly.io",
  MAILER: process.env.EMAIL_PROVIDER_NAME || "Resend (Resend, Inc.)",
  PHONE: process.env.OPERATOR_PHONE || "[phone not set]",
  VATID: process.env.OPERATOR_VAT_ID || "[VAT ID not set, or not applicable]",
  LAW: process.env.GOVERNING_LAW || "the country where the operator is established",
  PRICE: PRO_LABEL || "the price shown at checkout",
  UPDATED: process.env.LEGAL_UPDATED || "31 October 2026",
  DAYS: String(INACTIVE_DAYS),
};
const PAGES = {}, ASSETS = {};
(function loadAssets() {
  const files = { "/favicon.svg": ["favicon.svg", "image/svg+xml"], "/favicon.png": ["favicon.png", "image/png"], "/favicon.ico": ["favicon.png", "image/png"], "/apple-touch-icon.png": ["apple-touch-icon.png", "image/png"] };
  for (const [url, [f, type]] of Object.entries(files)) { try { ASSETS[url] = { body: fs.readFileSync(require("path").join(PUBLIC_DIR, f)), type }; } catch {} }
})();
(function loadPages() {
  const read = (f) => { try { return fs.readFileSync(require("path").join(PUBLIC_DIR, f), "utf8"); } catch { return null; } };
  const idx = read("index.html");
  if (idx) PAGES["/"] = PAGES["/index.html"] = { body: Buffer.from(idx), script: true };
  for (const n of ["terms", "privacy", "impressum"]) {
    const t = read(n + ".html");
    if (t) PAGES["/" + n] = { body: Buffer.from(t.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in LEGAL ? escHtml(LEGAL[k]) : ""))) };
  }
  if (!process.env.OPERATOR_NAME) console.warn("OPERATOR_NAME is not set: the Terms and Privacy pages show placeholders.");
})();
function sendPage(res, pg) {
  const csp = pg.script
    ? "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    : "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8", "content-length": pg.body.length, "cache-control": "no-cache",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": csp,
    "x-frame-options": "DENY", "strict-transport-security": "max-age=31536000",
  });
  res.end(pg.body);
}

const TYPES = {
  card: ["purchase", "authorization", "capture-authorization", "refund", "void"],
  paypal: ["debit", "authorization", "capture-authorization", "refund", "void"],
  ideal: ["debit", "refund"],
  sepa: ["debit", "refund"],
};
const FOLLOW = ["capture-authorization", "refund", "void"], PAY = ["purchase", "debit", "capture-authorization"];
const CURRENCIES = ["EUR", "USD", "GBP"];
const SCENARIOS = ["auto", "approve", "decline", "timeout", "3ds"];
const CARDS = {
  "4111111111111111": "approve", "4000000000000002": "decline", "4000000000009995": "nsf",
  "4000000000000069": "expired", "4000000000000408": "timeout",
};
// 3-D Secure test cards: outcome "3ds" is the challenge flow, "3ds_Y" / "3ds_N" / "3ds_A" / "3ds_U" / "3ds_R" end without a challenge.
for (const [num, status] of Object.entries(TDS.CARDS)) CARDS[num] = status === "C" ? "3ds" : "3ds_" + status;
// Visa, Mastercard and American Express test cards (see schemes.js)
for (const c of SCH.TEST_CARDS) CARDS[c.number] = c.outcome;
const MAX_3DS_LOGS = 20;
function trimLogs(acc) {
  let kept = 0;
  for (const p of acc.payments) if (p._tds && ++kept > MAX_3DS_LOGS) delete p._tds;
}
const FAILS = { decline: ["SBX-4002", "Card declined by issuer"], nsf: ["SBX-4051", "Insufficient funds"], expired: ["SBX-4054", "Card expired"], invalid_card: ["SBX-4014", "Invalid card number"] };

// ---------- storage (SQLite, see store.js) ----------
const { Store } = require("./store");
const DB_FILE = process.env.DB_FILE || DATA_FILE.replace(/\.json$/i, "") + ".db";
const store = new Store(DB_FILE, { legacyJson: DATA_FILE.endsWith(".json") ? DATA_FILE : null });
const DB = store.load();
let timer = null, flushFull = false;
const dirty = new Set();
// save(acc): this account (and the small lookup tables) changed. save(): something else changed, check every account.
// saveMaps(): only keys, emails, tokens or trials changed.
const save = (acc) => { if (acc && acc.id) dirty.add(acc.id); else if (acc !== null) flushFull = true; schedule(); };
const saveMaps = () => schedule();
function schedule() { if (!timer) timer = setTimeout(flushNow, 200); }
function flushNow() {
  clearTimeout(timer); timer = null;
  const full = flushFull, ids = new Set(dirty);
  flushFull = false; dirty.clear();
  try { store.flush(DB, full ? null : ids); }
  catch (e) { console.error("DATABASE WRITE FAILED:", e.message); flushFull = true; schedule(); }
}
const backups = require("./backup").createBackupService(store, process.env, { beforeSnapshot: flushNow });
const rnd = (n) => crypto.randomBytes(n).toString("hex");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const r2 = (n) => Math.round(n * 100) / 100;

class ApiError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
const bad = (s, c, m, x) => new ApiError(s, c, m, x);

// ---------- webhooks ----------
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || /^fe[89ab]/.test(l)) return true;
    const m = l.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return m ? isPrivateIp(m[1]) : false;
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
async function checkWebhookUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw bad(400, "invalid_url", "url must be a valid http(s) URL"); }
  if (!["http:", "https:"].includes(u.protocol)) throw bad(400, "invalid_url", "url must use http or https");
  if (!ALLOW_PRIVATE) {
    if (u.protocol !== "https:") throw bad(400, "invalid_url", "url must use https");
    let addrs;
    try { addrs = await dns.lookup(u.hostname, { all: true }); } catch { throw bad(400, "invalid_url", "hostname does not resolve"); }
    if (addrs.some((a) => isPrivateIp(a.address))) throw bad(400, "invalid_url", "url must not point to a private or internal address");
  }
  return u.toString();
}
const sign = (secret, ts, body) => `t=${ts},v1=${crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// opts: { hook: webhook behaviours from a failure script, replayOf: id of the delivery being replayed }
async function deliver(acc, event, opts = {}) {
  const wh = acc.webhook;
  if (!wh || !wh.url) return;
  const hook = opts.hook || {}, flags = [];
  if (hook.drop) flags.push("dropped");
  if (hook.delay_ms) flags.push("delayed");
  if (hook.bad_signature) flags.push("bad_signature");
  if (hook.duplicate) flags.push("duplicate");
  if (opts.replayOf) flags.push("replay");
  const copies = hook.drop ? 1 : 1 + (hook.duplicate || 0);
  const body = JSON.stringify(event);
  for (let c = 0; c < copies; c++) {
    const rec = { id: "dlv_" + rnd(6), event_id: event.id, event_type: event.type, url: wh.url, delivered: false, attempts: [], created_at: new Date().toISOString(), event };
    if (flags.length) rec.flags = flags.slice();
    if (opts.replayOf) rec.replay_of = opts.replayOf;
    if (c > 0) rec.copy = c + 1;
    acc.deliveries.unshift(rec); acc.deliveries = acc.deliveries.slice(0, 100);
    if (hook.drop) { rec.attempts.push({ at: rec.created_at, error: "not sent: dropped by your failure script" }); save(acc); return; }
    if (hook.delay_ms) await sleep(hook.delay_ms);
    for (const wait of RETRY_MS) {
      if (wait) await sleep(wait);
      const at = new Date().toISOString(), t0 = Date.now();
      try {
        await checkWebhookUrl(wh.url);
        const ts = Math.floor(Date.now() / 1000);
        const res = await fetch(wh.url, {
          method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000), body,
          headers: { "content-type": "application/json", "x-dryrun-signature": sign(hook.bad_signature ? wh.secret + "_wrong" : wh.secret, ts, body), "x-dryrun-event": event.type, ...(opts.replayOf ? { "x-dryrun-replay": "true" } : {}) },
        });
        let snippet = "";
        try { snippet = (await res.text()).slice(0, 300); } catch {}
        rec.attempts.push({ at, status: res.status, ms: Date.now() - t0, ...(snippet ? { response: snippet } : {}) });
        if (res.status >= 200 && res.status < 300) { rec.delivered = true; break; }
      } catch (e) { rec.attempts.push({ at, ms: Date.now() - t0, error: String(e.message || e).slice(0, 120) }); }
    }
    save(acc);
  }
}
function emit(acc, p) {
  const ok = p.transaction_state === "success";
  deliver(acc, { id: "evt_" + rnd(8), type: ok ? "payment.succeeded" : "payment.failed", created_at: new Date().toISOString(), data: pub(p) }, { hook: p._hook });
}

// ---------- disputes (chargebacks), see disputes.js ----------
const DISPUTE_REVIEW_MS = process.env.DISPUTE_REVIEW_DELAY_MS ? +process.env.DISPUTE_REVIEW_DELAY_MS : 5000;
const DSP = Object.assign(require("./disputes")({ bad, rnd, r2, reviewMs: DISPUTE_REVIEW_MS }), { CATEGORIES: require("./disputes").CATEGORIES });
function emitDispute(acc, d, type) {
  deliver(acc, { id: "evt_" + rnd(8), type, created_at: new Date().toISOString(), data: DSP.publicDispute(d) });
}
// Decides disputes that are due (finished reviews, passed deadlines) and sends their webhook events.
function sweepDisputes(acc) {
  const evs = DSP.sweep(acc);
  if (!evs.length) return;
  save(acc);
  for (const e of evs) emitDispute(acc, e.d, e.type);
}

// ---------- clearing, settlement and payouts, see settlement.js ----------
const STL = require("./settlement")({ bad, rnd });
const MCP = require("./mcp")({ port: () => (server.address() || {}).port || PORT, allowedOrigins: (process.env.MCP_ALLOWED_ORIGINS || "").split(",").map((x) => x.trim()).filter(Boolean), version: "1.0.0" });
const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + "T00:00:00Z")) && new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d;
function sendText(res, status, type, body, filename) {
  res.writeHead(status, { "content-type": type + "; charset=utf-8", "content-length": Buffer.byteLength(body), "x-content-type-options": "nosniff", ...(filename ? { "content-disposition": `attachment; filename="${filename}"` } : {}) });
  res.end(body);
}

// ---------- gateway simulation ----------
const pub = (p) => Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith("_")));

function checkParent(p, type, amount) {
  if (p.transaction_state !== "success") return ["SBX-4220", "Parent transaction did not succeed"];
  if (p.voided) return ["SBX-4221", "Parent transaction is already voided"];
  if (type === "capture-authorization") {
    if (p.transaction_type !== "authorization") return ["SBX-4222", "capture-authorization needs an authorization as parent"];
    if (amount > r2(p.amount - p.captured_amount)) return ["SBX-4223", `Amount exceeds uncaptured balance of ${r2(p.amount - p.captured_amount).toFixed(2)}`];
  }
  if (type === "refund") {
    if (!PAY.includes(p.transaction_type)) return ["SBX-4224", "refund needs a purchase, debit or capture as parent"];
    const left = r2(p.amount - p.refunded_amount - (p.disputed_amount || 0));
    if (amount > left) return ["SBX-4225", `Amount exceeds refundable balance of ${left.toFixed(2)}` + (p.disputed_amount ? " (money held back by a dispute cannot be refunded)" : "")];
  }
  if (type === "void") {
    if (["refund", "void"].includes(p.transaction_type)) return ["SBX-4226", "Refunds and voids cannot be voided"];
    if (p.transaction_type === "authorization" && p.captured_amount > 0) return ["SBX-4227", "Authorization already captured; refund the capture instead"];
    if (p.transaction_type !== "authorization" && p.refunded_amount > 0) return ["SBX-4228", "Transaction already refunded; it can no longer be voided"];
    if (p.dispute_id) return ["SBX-4233", "Transaction is disputed; it can no longer be voided"];
    if (p.settled_in) return ["SBX-4234", `Transaction was already cleared in settlement ${p.settled_in}; it can no longer be voided. Refund it instead`];
  }
  return null;
}
function effects(acc, p) {
  if (p.transaction_type === "authorization") p.captured_amount = 0;
  else if (PAY.includes(p.transaction_type)) p.refunded_amount = 0;
  const par = p.parent_transaction_id && acc.payments.find((x) => x.id === p.parent_transaction_id);
  if (!par) return;
  if (p.transaction_type === "capture-authorization") par.captured_amount = r2(par.captured_amount + p.amount);
  if (p.transaction_type === "refund") par.refunded_amount = r2(par.refunded_amount + p.amount);
  if (p.transaction_type === "void") par.voided = true;
}
// ---------- card on file: agreements and merchant-initiated payments (MIT) ----------
// A customer-initiated first payment (store_credential) creates an agreement. Later payments with initiator "merchant"
// charge the stored card without the customer present: no card number, no 3-D Secure.
const MIT_TYPES = ["recurring", "instalment", "unscheduled"];
const MIT_SCENARIOS = ["auto", "approve", "decline", "nsf", "expired", "timeout"];
const MAX_AGREEMENTS = 50;
function emitAgreement(acc, a, type) { deliver(acc, { id: "evt_" + rnd(8), type, created_at: new Date().toISOString(), data: { ...a } }); }
function makeAgreement(acc, p) {
  const st = p._store, au = p.authentication || null;
  const a = {
    id: "agr_" + rnd(8), state: "active", type: st.type, scheme: p.scheme || null, card_last4: p.card_last4 || null, currency: p.currency,
    created_at: new Date().toISOString(), initial_payment_id: p.id, network_transaction_id: p.network_transaction_id || null,
    sca: { performed: !!au && au.trans_status === "Y", trans_status: au ? au.trans_status : null, eci: au ? au.eci : null },
    instalments: st.type === "instalment" ? { total: st.instalments, used: 1 } : null, charges: 0, last_charge_at: null, last_result: null, cancelled_at: null,
  };
  acc.agreements = acc.agreements || [];
  if (acc.agreements.length >= MAX_AGREEMENTS) { const i = acc.agreements.findLastIndex((x) => x.state !== "active"); acc.agreements.splice(i < 0 ? acc.agreements.length - 1 : i, 1); }
  acc.agreements.unshift(a); p.agreement_id = a.id;
  emitAgreement(acc, a, "agreement.created");
}
function agreementEffects(acc, p, ok) {
  if (ok && p._store && !p.agreement_id) return makeAgreement(acc, p);
  if (p.initiator !== "merchant" || !p.agreement_id) return;
  const a = (acc.agreements || []).find((x) => x.id === p.agreement_id);
  if (!a) return;
  a.last_result = ok ? { payment_id: p.id, state: "success" } : { payment_id: p.id, state: "failed", code: p.status.code, scheme_response: p.scheme_response || null };
  if (!ok) return;
  a.charges++; a.last_charge_at = new Date().toISOString();
  if (a.instalments && ++a.instalments.used >= a.instalments.total) { a.state = "completed"; emitAgreement(acc, a, "agreement.completed"); }
}
function mitWarnings(a, currency) {
  return currency === "EUR" && !a.sca.performed ? ["The first payment of this agreement was not authenticated with 3-D Secure. In the EU, issuers may decline merchant-initiated payments that rest on a first payment without strong customer authentication."] : [];
}
function settle(acc, p, ok, code, message) {
  p.transaction_state = ok ? "success" : "failed";
  p.status = { code, message };
  delete p._3ds;
  if (ok && p.initiator && p.scheme && !p.network_transaction_id) p.network_transaction_id = SCH.newNtid(p.scheme);
  if (ok) effects(acc, p);
  agreementEffects(acc, p, ok);
  save(acc);
  setTimeout(() => emit(acc, p), 300);
}

// ---------- failure script (Pro / trial) ----------
const SCRIPT_OUTCOMES = ["approve", "decline", "nsf", "expired", "timeout", "3ds", "3ds_Y", "3ds_N", "3ds_A", "3ds_U", "3ds_R"];
const SCRIPT_HTTP = [500, 502, 503];
const MAX_RULES = 20;
function parseScript(b) {
  if (!b || !Array.isArray(b.rules)) throw bad(400, "invalid_script", "Body must be {\"rules\": [...]}");
  if (b.rules.length > MAX_RULES) throw bad(400, "invalid_script", `At most ${MAX_RULES} rules`);
  const num = (v, min, max, what, int) => {
    if (typeof v !== "number" || !isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) throw bad(400, "invalid_script", `${what} must be ${int ? "a whole number" : "a number"} between ${min} and ${max}`);
    return v;
  };
  const only = (o, allowed, what) => { for (const k of Object.keys(o)) if (!allowed.includes(k)) throw bad(400, "invalid_script", `Unknown field "${k}" in ${what}. Allowed: ${allowed.join(", ")}`); };
  const rules = b.rules.map((r, i) => {
    const at = `rule ${i + 1}`;
    if (!r || typeof r !== "object" || Array.isArray(r)) throw bad(400, "invalid_script", `${at} must be an object`);
    only(r, ["name", "when", "then"], at);
    const w = r.when || {}, t = r.then || {};
    if (typeof w !== "object" || typeof t !== "object" || Array.isArray(w) || Array.isArray(t)) throw bad(400, "invalid_script", `${at}: when and then must be objects`);
    only(w, ["nth", "every", "amount_gte", "amount_lte", "currency", "method", "transaction_type", "scheme", "initiator", "probability"], at + " when");
    only(t, ["outcome", "latency_ms", "http_error", "webhook"], at + " then");
    const when = {};
    if ("nth" in w) when.nth = num(w.nth, 1, 1e9, `${at}: nth`, true);
    if ("every" in w) when.every = num(w.every, 1, 1e9, `${at}: every`, true);
    if ("amount_gte" in w) when.amount_gte = num(w.amount_gte, 0, 1e7, `${at}: amount_gte`);
    if ("amount_lte" in w) when.amount_lte = num(w.amount_lte, 0, 1e7, `${at}: amount_lte`);
    if ("probability" in w) when.probability = num(w.probability, 0, 1, `${at}: probability`);
    if ("currency" in w) { if (!CURRENCIES.includes(w.currency)) throw bad(400, "invalid_script", `${at}: currency must be one of ${CURRENCIES.join(", ")}`); when.currency = w.currency; }
    if ("method" in w) { if (!TYPES[w.method]) throw bad(400, "invalid_script", `${at}: method must be one of ${Object.keys(TYPES).join(", ")}`); when.method = w.method; }
    if ("initiator" in w) { if (!["customer", "merchant"].includes(w.initiator)) throw bad(400, "invalid_script", `${at}: initiator must be customer or merchant`); when.initiator = w.initiator; }
    if ("scheme" in w) { if (!SCH.SCHEMES[w.scheme]) throw bad(400, "invalid_script", `${at}: scheme must be one of ${Object.keys(SCH.SCHEMES).join(", ")}`); when.scheme = w.scheme; }
    if ("transaction_type" in w) { if (!Object.values(TYPES).some((l) => l.includes(w.transaction_type))) throw bad(400, "invalid_script", `${at}: unknown transaction_type`); when.transaction_type = w.transaction_type; }
    const then = {};
    if ("outcome" in t) { if (!SCRIPT_OUTCOMES.includes(t.outcome)) throw bad(400, "invalid_script", `${at}: outcome must be one of ${SCRIPT_OUTCOMES.join(", ")}`); then.outcome = t.outcome; }
    if ("latency_ms" in t) then.latency_ms = num(t.latency_ms, 0, 10000, `${at}: latency_ms`, true);
    if ("http_error" in t) { if (!SCRIPT_HTTP.includes(t.http_error)) throw bad(400, "invalid_script", `${at}: http_error must be one of ${SCRIPT_HTTP.join(", ")}`); then.http_error = t.http_error; }
    if ("webhook" in t) {
      const h = t.webhook;
      if (!h || typeof h !== "object" || Array.isArray(h)) throw bad(400, "invalid_script", `${at}: webhook must be an object`);
      only(h, ["duplicate", "delay_ms", "drop", "bad_signature"], at + " webhook");
      then.webhook = {};
      if ("duplicate" in h) then.webhook.duplicate = num(h.duplicate, 1, 3, `${at}: webhook.duplicate`, true);
      if ("delay_ms" in h) then.webhook.delay_ms = num(h.delay_ms, 1, 60000, `${at}: webhook.delay_ms`, true);
      if ("drop" in h) { if (typeof h.drop !== "boolean") throw bad(400, "invalid_script", `${at}: webhook.drop must be true or false`); if (h.drop) then.webhook.drop = true; }
      if ("bad_signature" in h) { if (typeof h.bad_signature !== "boolean") throw bad(400, "invalid_script", `${at}: webhook.bad_signature must be true or false`); if (h.bad_signature) then.webhook.bad_signature = true; }
    }
    if (!Object.keys(then).length) throw bad(400, "invalid_script", `${at}: "then" must do something (outcome, latency_ms, http_error or webhook)`);
    const name = r.name === undefined ? "" : String(r.name).slice(0, 60);
    return { name, when, then };
  });
  return rules;
}
// Returns the first matching rule (and its 1-based number) for a payment request, counting this request.
function matchScript(acc, ctx) {
  const sc = acc.script;
  if (!sc || !sc.rules.length || planOf(acc) !== "pro") return null;
  sc.count++;
  for (let i = 0; i < sc.rules.length; i++) {
    const w = sc.rules[i].when;
    if (w.nth !== undefined && sc.count !== w.nth) continue;
    if (w.every !== undefined && sc.count % w.every !== 0) continue;
    if (w.amount_gte !== undefined && ctx.amount < w.amount_gte) continue;
    if (w.amount_lte !== undefined && ctx.amount > w.amount_lte) continue;
    if (w.currency && ctx.currency !== w.currency) continue;
    if (w.method && ctx.method !== w.method) continue;
    if (w.transaction_type && ctx.type !== w.transaction_type) continue;
    if (w.scheme && ctx.scheme !== w.scheme) continue;
    if (w.initiator && ctx.initiator !== w.initiator) continue;
    if (w.probability !== undefined && Math.random() >= w.probability) continue;
    return { n: i + 1, rule: sc.rules[i] };
  }
  return null;
}

// Adds the card scheme's own response code next to our SBX code, for example Visa 05 or Amex 100.
function schemeResponse(p, outcome) {
  const r = SCH.responseFor(p.scheme, outcome);
  if (r) p.scheme_response = { scheme: p.scheme, code: r.code, message: r.message, retry_advice: r.retry };
  const adv = p.initiator === "merchant" && SCH.mitAdviceFor(p.scheme, outcome);
  if (r && adv) p.scheme_response.merchant_advice = { action: adv.action, code: adv.code, text: adv.text };
}
function createPayment(acc, b) {
  const meta = { latency_ms: 0 };
  const out = createPaymentInner(acc, b, meta);
  out.latency_ms = meta.latency_ms;
  return out;
}
function createPaymentInner(acc, b, meta) {
  if (typeof b.request_id !== "string" || !b.request_id || b.request_id.length > 64) throw bad(400, "invalid_request", "request_id is required (string, max 64 chars)");
  const dup = acc.payments.find((p) => p.request_id === b.request_id);
  if (dup) throw bad(409, "duplicate_request", "request_id already used; fetch the original transaction instead", { transaction_id: dup.id });
  if (!TYPES[b.method]) throw bad(400, "invalid_request", `method must be one of ${Object.keys(TYPES).join(", ")}`);
  if (!TYPES[b.method].includes(b.transaction_type)) throw bad(400, "invalid_request", `transaction_type for ${b.method} must be one of ${TYPES[b.method].join(", ")}`);
  const initiator = b.initiator === undefined ? "customer" : b.initiator, mit = initiator === "merchant";
  if (!["customer", "merchant"].includes(initiator)) throw bad(400, "invalid_request", "initiator must be customer or merchant");
  if (mit && (b.method !== "card" || !["purchase", "authorization"].includes(b.transaction_type))) throw bad(400, "invalid_request", "initiator merchant is only available for card purchase and authorization");
  const scenario = b.scenario || "auto";
  const allowed = mit ? MIT_SCENARIOS : SCENARIOS;
  if (!allowed.includes(scenario)) throw bad(400, "invalid_request", `scenario must be one of ${allowed.join(", ")}` + (mit ? " (3-D Secure is not possible without the customer)" : ""));
  let store = null, agr = null, mitType = null;
  if (b.store_credential !== undefined) {
    const sc = b.store_credential;
    if (mit || b.method !== "card" || !["purchase", "authorization"].includes(b.transaction_type)) throw bad(400, "invalid_request", "store_credential belongs on a customer-initiated card purchase or authorization");
    if (!sc || typeof sc !== "object" || Array.isArray(sc) || !MIT_TYPES.includes(sc.type)) throw bad(400, "invalid_request", `store_credential must be {"type": one of ${MIT_TYPES.join(", ")}}`);
    store = { type: sc.type };
    if (sc.type === "instalment") {
      if (!Number.isInteger(sc.instalments) || sc.instalments < 2 || sc.instalments > 60) throw bad(400, "invalid_request", "store_credential.instalments must be a whole number from 2 to 60 (the first payment counts as number 1)");
      store.instalments = sc.instalments;
    } else if (sc.instalments !== undefined) throw bad(400, "invalid_request", "store_credential.instalments is only for type instalment");
    if ((acc.agreements || []).filter((x) => x.state === "active").length >= MAX_AGREEMENTS) throw bad(429, "too_many_agreements", `At most ${MAX_AGREEMENTS} active agreements; cancel some first`);
  }
  if (mit) {
    if (b.card_number !== undefined || b.card_cvv !== undefined) throw bad(400, "invalid_request", "Merchant-initiated payments use the card on file. Do not send card_number or card_cvv");
    agr = (acc.agreements || []).find((x) => x.id === b.agreement_id);
    if (!agr) throw bad(b.agreement_id ? 404 : 400, b.agreement_id ? "not_found" : "invalid_request", b.agreement_id ? "agreement_id not found" : "agreement_id is required when initiator is merchant");
    if (agr.state !== "active") throw bad(422, "SBX-4240", `Agreement is ${agr.state}; no more merchant-initiated payments are allowed`);
    mitType = b.mit_type === undefined ? agr.type : b.mit_type;
    if (mitType !== agr.type) throw bad(400, "invalid_request", `mit_type must be ${agr.type} for this agreement`);
    if (agr.instalments && agr.instalments.used >= agr.instalments.total) throw bad(422, "SBX-4242", "All instalments have been collected");
  }
  if (scenario === "3ds" && (b.method !== "card" || !["purchase", "authorization"].includes(b.transaction_type))) throw bad(400, "invalid_request", "3ds scenario is only available for card purchase and authorization");

  const type = b.transaction_type;
  let amount = Number(b.amount), parent = null;
  if (FOLLOW.includes(type)) {
    parent = acc.payments.find((p) => p.id === b.parent_transaction_id);
    if (!parent) throw bad(404, "not_found", "parent_transaction_id not found");
    if (parent.method !== b.method) throw bad(422, "SBX-4229", "Parent transaction used a different payment method");
    if (type === "void") amount = parent.amount;
  }
  if (!(amount > 0) || amount > 1e7) throw bad(400, "invalid_request", "amount must be a number between 0.01 and 10000000");
  amount = r2(amount);
  const currency = parent ? parent.currency : b.currency;
  if (!CURRENCIES.includes(currency)) throw bad(400, "invalid_request", `currency must be one of ${CURRENCIES.join(", ")}`);
  if (parent) { const e = checkParent(parent, type, amount); if (e) throw bad(422, e[0], e[1]); }

  const card = String(b.card_number || "").replace(/\s/g, "");
  let scheme = mit ? agr.scheme : null;
  if (b.method === "card" && !parent && !mit) {
    if (scenario === "auto" || card) {
      const chk = SCH.check(card, b.card_cvv);
      if (chk.error && (scenario === "auto" || card)) throw bad(400, "invalid_request", chk.error + (scenario === "auto" ? "" : " (or leave card_number out when you set a scenario)"));
      scheme = chk.scheme;
    }
  }

  let outcome = scenario;
  if (scenario === "auto") outcome = parent || b.method !== "card" || mit ? "approve" : CARDS[card] || (scheme && !SCH.luhn(card) ? "invalid_card" : "decline");

  const hit = matchScript(acc, { amount, currency, method: b.method, type, scheme, initiator });
  let latency_ms = 0, hook = null;
  if (hit) {
    const t = hit.rule.then;
    if (t.http_error) { meta.latency_ms = t.latency_ms || 0; return { status: t.http_error, injected: true, body: { error: { code: "SBX-5000", message: `Gateway error injected by your failure script (rule ${hit.n}). No payment was created; retry with the same request_id.`, script_rule: hit.n } } }; }
    latency_ms = meta.latency_ms = t.latency_ms || 0; hook = t.webhook || null;
    const canTds = b.method === "card" && !parent && !mit && ["purchase", "authorization"].includes(type);
    if (t.outcome && (canTds || !t.outcome.startsWith("3ds"))) outcome = t.outcome;
  }

  const p = {
    id: "tx_" + rnd(8), request_id: b.request_id, transaction_type: type, transaction_state: "pending", method: b.method,
    amount, currency, parent_transaction_id: parent ? parent.id : null, status: { code: "SBX-2010", message: "Processing" },
    created_at: new Date().toISOString(),
  };
  if (mit) {
    p.initiator = "merchant"; p.agreement_id = agr.id; p.mit_type = mitType; p.card_last4 = agr.card_last4;
    if (agr.scheme) p.scheme = agr.scheme;
    if (agr.network_transaction_id) p.original_network_transaction_id = agr.network_transaction_id;
    const w = mitWarnings(agr, currency); if (w.length) p.warnings = w;
  } else if (b.method === "card" && !parent) p.initiator = "customer";
  if (store) p._store = store;
  if (b.method === "card" && !parent && !mit && card) { p.card_last4 = card.slice(-4); if (scheme) p.scheme = scheme; }
  else if (parent && parent.scheme) p.scheme = parent.scheme;
  if (hit) p.script_rule = hit.n;
  if (hook) p._hook = hook;
  if (type === "authorization") p.captured_amount = 0;
  if (PAY.includes(type)) p.refunded_amount = 0;
  acc.payments.unshift(p);
  if (acc.payments.length > MAX_PAYMENTS_PER_ACCOUNT) acc.payments.length = MAX_PAYMENTS_PER_ACCOUNT;

  if (outcome === "approve") { settle(acc, p, true, "SBX-2000", "Transaction approved"); return { status: 201, body: pub(p) }; }
  if (outcome === "timeout") {
    p.status = { code: "SBX-5040", message: "Gateway timeout; outcome unknown" };
    setTimeout(() => settle(acc, p, true, "SBX-2000", "Approved after timeout"), SETTLE_MS);
    save(acc);
    return { status: 504, body: { error: { code: "SBX-5040", message: "Gateway timeout. Outcome unknown: wait for the webhook or poll GET /v1/payments/{id} before retrying.", transaction_id: p.id } } };
  }
  if (outcome === "3ds" || outcome.startsWith("3ds_")) {
    const status = outcome === "3ds" ? "C" : outcome.slice(4);
    const tr = TDS.begin({ amount, currency, last4: card.slice(-4) || "0000", scheme }, status);
    p._tds = tr; p.authentication = TDS.summary(tr);
    trimLogs(acc);
    if (status === "C") {
      p._3ds = true; p.status = { code: "SBX-2020", message: "Waiting for 3D Secure" };
      save(acc);
      return { status: 202, body: { ...pub(p), three_ds: { required: true, confirm_url: `/v1/payments/${p.id}/3ds`, log_url: `/v1/payments/${p.id}/3ds-log` } } };
    }
    if (!tr.payment.ok) schemeResponse(p, "decline");
    settle(acc, p, tr.payment.ok, tr.payment.code, tr.payment.message);
    return { status: 201, body: pub(p) };
  }
  const f = FAILS[outcome] || FAILS.decline;
  schemeResponse(p, FAILS[outcome] ? outcome : "decline");
  settle(acc, p, false, f[0], f[1]);
  return { status: 201, body: pub(p) };
}

// ---------- http plumbing ----------
const buckets = new Map(), signups = new Map(), adminFails = new Map();
function limited(map, key, limit, windowMs) {
  const now = Date.now(), b = map.get(key);
  if (!b || now - b.start > windowMs) { map.set(key, { start: now, n: 1 }); return false; }
  return ++b.n > limit;
}
function send(res, status, obj, headers = {}) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s), ...headers });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = "", size = 0;
    req.on("data", (c) => { size += c.length; if (size > 1e6) { reject(bad(413, "too_large", "Body exceeds 1 MB")); req.destroy(); } else d += c; });
    req.on("end", () => { if (!d) return resolve({}); try { const j = JSON.parse(d); resolve(j && typeof j === "object" ? j : {}); } catch { reject(bad(400, "invalid_json", "Body must be valid JSON")); } });
  });
}
function readRaw(req, max = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > max) { reject(bad(413, "too_large", "Body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function auth(req) {
  const m = (req.headers.authorization || "").match(/^Bearer (sk_test_[a-f0-9]+)$/);
  const id = m && DB.keys[sha(m[1])];
  const acc = id && DB.accounts[id];
  if (!acc) throw bad(401, "unauthorized", "Missing or invalid API key. Send 'Authorization: Bearer sk_test_...'");
  const today = new Date().toISOString().slice(0, 10);
  if (acc.last_seen !== today) { acc.last_seen = today; save(acc); }
  return acc;
}


// ---------- email: verification and sign-in links ----------
const EMAIL_API_KEY = process.env.EMAIL_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "";
const EMAIL_API_BASE = process.env.EMAIL_API_BASE || "https://api.resend.com";
const emailOn = () => !!(EMAIL_API_KEY && EMAIL_FROM && PUBLIC_URL);
const MAIL_IP_LIMIT = +process.env.MAIL_IP_PER_HOUR || 10;
const VERIFY_MS = 60 * 60e3, LOGIN_MS = 15 * 60e3;
const mailLimits = new Map(), mailIpLimits = new Map();
function cleanEmail(v) {
  const e = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (e.length < 5 || e.length > 254 || !/^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[a-z]{2,}$/.test(e)) throw bad(400, "invalid_email", "Enter a valid email address");
  return e;
}
async function sendMail(to, subject, text) {
  const r = await fetch(EMAIL_API_BASE + "/emails", {
    method: "POST",
    headers: { authorization: "Bearer " + EMAIL_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error("email provider answered " + r.status);
}
function makeToken(type, acct, email, ms) {
  const token = rnd(24);
  DB.tokens[sha(token)] = { type, acct, email, exp: Date.now() + ms };
  const keys = Object.keys(DB.tokens);
  if (keys.length > 20000) for (const k of keys.slice(0, keys.length - 20000)) delete DB.tokens[k];
  save();
  return token;
}
function takeToken(token, type) {
  if (typeof token !== "string" || !/^[a-f0-9]{48}$/.test(token)) throw bad(400, "invalid_token", "This link is not valid");
  const h = sha(token), t = DB.tokens[h];
  if (!t || t.type !== type || t.exp < Date.now() || !DB.accounts[t.acct]) { delete DB.tokens[h]; throw bad(400, "invalid_token", "This link has expired or was already used. Request a new one."); }
  delete DB.tokens[h]; saveMaps();
  return t;
}
function dropAccountEmail(acc) {
  if (acc.email && DB.emails[acc.email] === acc.id) delete DB.emails[acc.email];
  delete acc.email; delete acc.email_verified;
  for (const h of Object.keys(DB.tokens)) if (DB.tokens[h].acct === acc.id) delete DB.tokens[h];
}
function issueKey(acc) {
  for (const h of Object.keys(DB.keys)) if (DB.keys[h] === acc.id) delete DB.keys[h];
  const key = "sk_test_" + rnd(24);
  DB.keys[sha(key)] = acc.id; saveMaps();
  return key;
}

// ---------- account deletion and cleanup ----------
function purgeAccount(id) {
  const a = DB.accounts[id];
  if (a) dropAccountEmail(a);
  delete DB.accounts[id];
  for (const h of Object.keys(DB.keys)) if (DB.keys[h] === id) delete DB.keys[h];
  save();
}
function purgeInactive() {
  const now = Date.now();
  for (const h of Object.keys(DB.tokens)) if (DB.tokens[h].exp < now) delete DB.tokens[h];
  const cutoff = Date.now() - INACTIVE_DAYS * 864e5;
  for (const a of Object.values(DB.accounts)) {
    const paying = a.plan === "pro" || (a.stripe && a.stripe.subscription);
    if (!paying && (Date.parse(a.last_seen || a.created_at) || 0) < cutoff) purgeAccount(a.id);
  }
}

// ---------- Stripe (plain HTTPS calls, no SDK) ----------
function formEncode(obj, prefix, out) {
  out = out || [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === "object") formEncode(v, key, out);
    else if (v !== undefined) out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out;
}
async function stripe(method, p, params) {
  let res;
  try {
    res = await fetch(STRIPE_BASE + p, {
      method, signal: AbortSignal.timeout(10000),
      headers: { authorization: "Bearer " + STRIPE_KEY, ...(params ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: params ? formEncode(params).join("&") : undefined,
    });
  } catch { throw bad(502, "billing_error", "Could not reach the payment provider. Try again in a moment."); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("stripe", method, p, res.status, j.error && j.error.message);
    throw bad(502, "billing_error", "The payment provider could not complete the request. Try again later.", { provider_status: res.status });
  }
  return j;
}
function verifyStripeSignature(raw, header) {
  if (!header || !STRIPE_WH_SECRET) return false;
  let t = null; const v1 = [];
  for (const part of String(header).split(",")) {
    const i = part.indexOf("="), k = part.slice(0, i), v = part.slice(i + 1);
    if (k === "t") t = v; else if (k === "v1") v1.push(v);
  }
  if (!t || !v1.length || !(Math.abs(Date.now() / 1000 - Number(t)) <= 300)) return false;
  const expected = crypto.createHmac("sha256", STRIPE_WH_SECRET).update(`${t}.${raw}`).digest("hex");
  return v1.some((v) => v.length === expected.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected)));
}
function handleStripeEvent(ev) {
  const o = (ev.data && ev.data.object) || {};
  const byCustomer = (c) => (c ? Object.values(DB.accounts).find((a) => a.stripe && a.stripe.customer === c) : null);
  if (ev.type === "checkout.session.completed") {
    const acc = DB.accounts[o.client_reference_id];
    if (!acc || o.mode !== "subscription" || !["paid", "no_payment_required"].includes(o.payment_status)) return;
    acc.stripe = { customer: o.customer, subscription: o.subscription, status: "active" };
    acc.plan = "pro"; save();
  } else if (ev.type === "customer.subscription.created" || ev.type === "customer.subscription.updated") {
    const acc = byCustomer(o.customer);
    if (!acc) return;
    acc.stripe.subscription = o.id; acc.stripe.status = o.status;
    acc.plan = ["active", "trialing", "past_due"].includes(o.status) ? "pro" : "free"; save();
  } else if (ev.type === "customer.subscription.deleted") {
    const acc = byCustomer(o.customer);
    if (!acc) return;
    acc.stripe.subscription = null; acc.stripe.status = "canceled"; acc.plan = "free"; save();
  }
}

async function route(req, res) {
  const url = new URL(req.url, "http://x"), path = url.pathname, m = req.method;
  if (m === "GET" && path === "/health") return send(res, 200, { ok: true });
  if (m === "GET" && PAGES[path]) return sendPage(res, PAGES[path]);
  if (m === "GET" && ASSETS[path]) { res.writeHead(200, { "content-type": ASSETS[path].type, "content-length": ASSETS[path].body.length, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" }); return res.end(ASSETS[path].body); }
  if (m === "GET" && path === "/v1/schemes") return send(res, 200, { schemes: SCH.publicProfiles(), dispute_categories: DSP.CATEGORIES, note: "Simulated behaviour only. Zanboxx never connects to the real card networks. Codes are simplified for teaching." });
  if (m === "GET" && path === "/v1/config") return send(res, 200, { billing: billingOn(), pro_price: PRO_LABEL || null, email: emailOn() });


  if (path.startsWith("/admin/")) {
    const want = process.env.ADMIN_TOKEN || "";
    if (!want) throw bad(404, "not_found", "Unknown endpoint");
    if (limited(adminFails, clientIp(req), 20, 3600e3)) throw bad(429, "rate_limited", "Too many attempts");
    const got = (req.headers.authorization || "").replace(/^Bearer /, "");
    const a = crypto.createHash("sha256").update(got).digest(), b = crypto.createHash("sha256").update(want).digest();
    if (!crypto.timingSafeEqual(a, b)) throw bad(401, "unauthorized", "Missing or wrong admin token");
    adminFails.delete(clientIp(req));
    if (m === "GET" && path === "/admin/status") {
      const accounts = Object.values(DB.accounts);
      return send(res, 200, {
        node: process.version, uptime_s: Math.round(process.uptime()), database: DB_FILE, database_bytes: store.sizeBytes(),
        accounts: accounts.length, pro_accounts: accounts.filter((x) => planOf(x) === "pro").length, verified_emails: Object.keys(DB.emails).length,
        backups: backups.status(),
      });
    }
    if (m === "POST" && path === "/admin/backup") {
      try { const r = await backups.run("manual"); return send(res, 200, { ok: !r.error, file: r.file, offsite: r.offsite, warning: r.error }); }
      catch (e) { throw bad(500, "backup_failed", e.message); }
    }
    throw bad(404, "not_found", "Unknown endpoint");
  }

  if (m === "POST" && path === "/stripe/webhook") {
    if (!billingOn()) throw bad(404, "not_found", "Unknown endpoint");
    const raw = await readRaw(req);
    if (!verifyStripeSignature(raw, req.headers["stripe-signature"])) throw bad(400, "invalid_signature", "Signature verification failed");
    let ev;
    try { ev = JSON.parse(raw); } catch { throw bad(400, "invalid_json", "Body must be valid JSON"); }
    handleStripeEvent(ev);
    return send(res, 200, { received: true });
  }

  if (m === "POST" && path === "/v1/accounts") {
    if (SIGNUP_TOKEN && req.headers["x-signup-token"] !== SIGNUP_TOKEN) throw bad(403, "forbidden", "Signup is invite-only");
    if (limited(signups, clientIp(req), +process.env.SIGNUPS_PER_HOUR || 5, 3600e3)) throw bad(429, "rate_limited", "Too many signups from this address");
    if (Object.keys(DB.accounts).length >= MAX_ACCOUNTS) throw bad(503, "signups_closed", "Signups are temporarily closed");
    const key = "sk_test_" + rnd(24), id = "acct_" + rnd(6);
    DB.accounts[id] = { id, plan: "free", created_at: new Date().toISOString(), usage: { month: "", count: 0 }, payments: [], deliveries: [], webhook: null };
    DB.keys[sha(key)] = id; save(DB.accounts[id]);
    return send(res, 201, { account_id: id, api_key: key, plan: "free", note: "Store this key now; it cannot be shown again." });
  }

  if (m === "POST" && path === "/v1/login") {
    if (!emailOn()) throw bad(503, "email_unavailable", "Email sign-in is not open yet");
    const email = cleanEmail((await readBody(req)).email);
    if (limited(mailIpLimits, clientIp(req), MAIL_IP_LIMIT, 3600e3) || limited(mailLimits, "login:" + email, 3, 3600e3)) throw bad(429, "rate_limited", "Too many requests. Try again in an hour.");
    const id = DB.emails[email];
    if (id && DB.accounts[id]) {
      const token = makeToken("login", id, email, LOGIN_MS);
      sendMail(email, "Your Zanboxx sign-in link", `Open this link within 15 minutes to get a new API key for your Zanboxx account:\n\n${PUBLIC_URL}/?login=${token}\n\nSigning in replaces your current API key, so the old key stops working. If you did not ask for this, ignore this email and nothing changes.`).catch((e) => console.error("mail failed:", e.message));
    }
    return send(res, 200, { sent: true, message: "If that address belongs to an account, a sign-in link is on its way." });
  }
  if (m === "POST" && path === "/v1/login/redeem") {
    if (limited(mailIpLimits, "redeem:" + clientIp(req), 30, 3600e3)) throw bad(429, "rate_limited", "Too many attempts. Try again later.");
    const t = takeToken((await readBody(req)).token, "login"), a = DB.accounts[t.acct];
    return send(res, 200, { account_id: a.id, api_key: issueKey(a), email: a.email || null, note: "Your previous API key no longer works." });
  }
  if (m === "POST" && path === "/v1/email/verify") {
    if (limited(mailIpLimits, "verify:" + clientIp(req), 30, 3600e3)) throw bad(429, "rate_limited", "Too many attempts. Try again later.");
    const t = takeToken((await readBody(req)).token, "verify"), a = DB.accounts[t.acct];
    if (DB.emails[t.email] && DB.emails[t.email] !== a.id) throw bad(409, "email_in_use", "That address is already linked to another account");
    if (a.email && DB.emails[a.email] === a.id) delete DB.emails[a.email];
    a.email = t.email; a.email_verified = true; DB.emails[t.email] = a.id;
    let trialEnds = null;
    const eh = sha(t.email);
    if (TRIAL_DAYS > 0 && !a.trial && !DB.trials[eh]) {
      DB.trials[eh] = Date.now();
      a.trial = { started: new Date().toISOString(), ends: new Date(Date.now() + TRIAL_DAYS * 864e5).toISOString() };
      trialEnds = a.trial.ends;
    }
    save();
    return send(res, 200, { verified: true, email: t.email, trial_ends: trialEnds });
  }

  if (path === "/mcp") {
    if (m !== "POST") return send(res, 405, { error: { code: "method_not_allowed", message: "Use POST with JSON-RPC 2.0 (MCP Streamable HTTP). There is no server-sent event stream." } }, { allow: "POST" });
    if (!MCP.originOk(req)) throw bad(403, "forbidden_origin", "Origin not allowed. Set MCP_ALLOWED_ORIGINS for browser clients.");
    const key = (req.headers.authorization || "").match(/^Bearer (sk_test_[a-f0-9]+)$/);
    let macc;
    try { macc = auth(req); } catch (e) { return send(res, 401, { error: { code: "unauthorized", message: "Send your Zanboxx API key as 'Authorization: Bearer sk_test_...'" } }, { "www-authenticate": 'Bearer realm="zanboxx"' }); }
    if (limited(buckets, macc.id, PLANS[planOf(macc)].rpm, 60e3)) throw bad(429, "rate_limited", "Rate limit exceeded; slow down");
    return MCP.handle(req, res, { readRaw, send, key: key[1] });
  }

  const acc = auth(req);
  const plan = planOf(acc);
  if (limited(buckets, acc.id, PLANS[plan].rpm, 60e3)) throw bad(429, "rate_limited", "Rate limit exceeded; slow down");

  if (m === "POST" && path === "/v1/payments") {
    const month = new Date().toISOString().slice(0, 7);
    if (acc.usage.month !== month) acc.usage = { month, count: 0 };
    if (acc.usage.count >= PLANS[plan].monthly) throw bad(402, "plan_limit", `Monthly limit of ${PLANS[plan].monthly} payments reached for the ${plan} plan`);
    const out = createPayment(acc, await readBody(req));
    if (!out.injected) acc.usage.count++;
    save(acc);
    if (out.latency_ms) await sleep(out.latency_ms);
    return send(res, out.status, out.body);
  }
  let mt;
  if (m === "POST" && (mt = path.match(/^\/v1\/payments\/(tx_[a-f0-9]+)\/dispute$/))) {
    const p = acc.payments.find((x) => x.id === mt[1]), b = await readBody(req);
    if (!p) throw bad(404, "not_found", "Transaction not found");
    const d = DSP.create(acc, p, b);
    save(acc); emitDispute(acc, d, "dispute.created");
    return send(res, 201, DSP.publicDispute(d));
  }
  const today = () => new Date().toISOString().slice(0, 10);
  if (m === "GET" && path === "/v1/reports/transactions") {
    const date = url.searchParams.get("date") || today();
    if (!validDate(date)) throw bad(400, "invalid_request", "date must be a real date like 2026-11-03 (UTC)");
    return sendText(res, 200, "text/csv", STL.transactionsCsv(acc, date), `zbx-transactions-${date.replace(/-/g, "")}.csv`);
  }
  if (path === "/v1/settlements" || path.startsWith("/v1/settlements/")) {
    const sts = acc.settlements || [];
    if (m === "GET" && path === "/v1/settlements/fees") return send(res, 200, STL.FEES);
    if (m === "POST" && path === "/v1/settlements") {
      const b = await readBody(req), date = b.date === undefined ? today() : b.date;
      if (typeof date !== "string" || !validDate(date)) throw bad(400, "invalid_request", "date must be a real date like 2026-11-03 (UTC)");
      if (date > today()) throw bad(400, "invalid_request", "date cannot be in the future");
      const st = STL.createBatch(acc, date);
      save(acc);
      deliver(acc, { id: "evt_" + rnd(8), type: "settlement.created", created_at: new Date().toISOString(), data: STL.summary(st) });
      return send(res, 201, { ...STL.summary(st), files: STL.listFiles(st) });
    }
    if (m === "GET" && path === "/v1/settlements") return send(res, 200, { data: sts.map(STL.summary) });
    if ((mt = path.match(/^\/v1\/settlements\/(stl_[a-f0-9]+)(?:\/(reconcile|files)(?:\/([A-Za-z0-9._-]+))?)?$/))) {
      const st = sts.find((x) => x.id === mt[1]);
      if (!st) throw bad(404, "not_found", "Settlement not found");
      if (m === "GET" && !mt[2]) return send(res, 200, { ...STL.summary(st), files: STL.listFiles(st), records: st.records });
      if (m === "GET" && mt[2] === "files" && !mt[3]) return send(res, 200, { data: STL.listFiles(st) });
      if (m === "GET" && mt[2] === "files") { const f = STL.build(st, mt[3]); if (!f) throw bad(404, "not_found", "File not found. List the files at /v1/settlements/{id}/files"); return sendText(res, 200, f.type, f.body, mt[3]); }
      if (m === "POST" && mt[2] === "reconcile") return send(res, 200, STL.reconcile(st, await readBody(req)));
    }
    throw bad(404, "not_found", "Unknown endpoint");
  }
  if (path === "/v1/agreements" || path.startsWith("/v1/agreements/")) {
    const ags = acc.agreements || [];
    if (m === "GET" && path === "/v1/agreements") {
      const limit = Math.min(Math.max(+url.searchParams.get("limit") || 25, 1), 100), state = url.searchParams.get("state");
      return send(res, 200, { data: ags.filter((a) => !state || a.state === state).slice(0, limit) });
    }
    if ((mt = path.match(/^\/v1\/agreements\/(agr_[a-f0-9]+)(\/cancel)?$/))) {
      const a = ags.find((x) => x.id === mt[1]);
      if (!a) throw bad(404, "not_found", "Agreement not found");
      if (m === "GET" && !mt[2]) return send(res, 200, a);
      if (m === "POST" && mt[2]) {
        if (a.state !== "active") throw bad(409, "invalid_state", `Agreement is already ${a.state}`);
        a.state = "cancelled"; a.cancelled_at = new Date().toISOString();
        save(acc); emitAgreement(acc, a, "agreement.cancelled");
        return send(res, 200, a);
      }
    }
    throw bad(404, "not_found", "Unknown endpoint");
  }
  if (path === "/v1/disputes" || path.startsWith("/v1/disputes/")) {
    sweepDisputes(acc);
    const ds = acc.disputes || [], find = (id) => { const d = ds.find((x) => x.id === id); if (!d) throw bad(404, "not_found", "Dispute not found"); return d; };
    const payOf = (d) => acc.payments.find((x) => x.id === d.payment_id);
    if (m === "GET" && path === "/v1/disputes") {
      const limit = Math.min(Math.max(+url.searchParams.get("limit") || 25, 1), 100), state = url.searchParams.get("state");
      return send(res, 200, { data: ds.filter((d) => !state || d.state === state).slice(0, limit).map(DSP.publicDispute) });
    }
    if ((mt = path.match(/^\/v1\/disputes\/(dp_[a-f0-9]+)$/)) && m === "GET") return send(res, 200, DSP.publicDispute(find(mt[1])));
    if ((mt = path.match(/^\/v1\/disputes\/(dp_[a-f0-9]+)\/(evidence|accept)$/)) && m === "POST") {
      const d = find(mt[1]);
      if (mt[2] === "evidence") DSP.submitEvidence(acc, payOf(d), d, await readBody(req));
      else DSP.accept(acc, payOf(d), d);
      save(acc);
      emitDispute(acc, d, mt[2] === "evidence" ? "dispute.updated" : "dispute.lost");
      return send(res, 200, DSP.publicDispute(d));
    }
    throw bad(404, "not_found", "Unknown endpoint");
  }
  if (m === "GET" && path === "/v1/payments") {
    const limit = Math.min(Math.max(+url.searchParams.get("limit") || 25, 1), 100), state = url.searchParams.get("state");
    return send(res, 200, { data: acc.payments.filter((p) => !state || p.transaction_state === state).slice(0, limit).map(pub) });
  }
  if (m === "GET" && (mt = path.match(/^\/v1\/payments\/(tx_[a-f0-9]+)$/))) {
    const p = acc.payments.find((x) => x.id === mt[1]);
    if (!p) throw bad(404, "not_found", "Transaction not found");
    return send(res, 200, pub(p));
  }
  if (m === "POST" && (mt = path.match(/^\/v1\/payments\/(tx_[a-f0-9]+)\/3ds$/))) {
    const p = acc.payments.find((x) => x.id === mt[1]), b = await readBody(req);
    if (!p) throw bad(404, "not_found", "Transaction not found");
    if (!p._3ds) throw bad(409, "invalid_state", "Transaction is not waiting for 3D Secure");
    if (!["approve", "fail"].includes(b.result)) throw bad(400, "invalid_request", "result must be 'approve' or 'fail'");
    if (p._tds && TDS.finishChallenge(p._tds, b.result === "approve")) {
      p.authentication = TDS.summary(p._tds);
      settle(acc, p, p._tds.payment.ok, p._tds.payment.code, p._tds.payment.message);
    } else if (b.result === "approve") settle(acc, p, true, "SBX-2000", "Approved after 3D Secure");
    else settle(acc, p, false, "SBX-4030", "3D Secure authentication failed");
    return send(res, 200, pub(p));
  }
  if (m === "GET" && (mt = path.match(/^\/v1\/payments\/(tx_[a-f0-9]+)\/3ds-log$/))) {
    const p = acc.payments.find((x) => x.id === mt[1]);
    if (!p) throw bad(404, "not_found", "Transaction not found");
    if (!p._tds) throw bad(404, "no_log", p.authentication ? `The 3-D Secure log is no longer stored (only the latest ${MAX_3DS_LOGS} are kept)` : "This payment did not use 3-D Secure. Use a 3-D Secure test card to get a log");
    return send(res, 200, TDS.publicLog(p._tds, p.id));
  }
  if (path === "/v1/webhook") {
    if (m === "GET") return send(res, 200, acc.webhook || { url: null });
    if (m === "PUT") {
      const b = await readBody(req), u = await checkWebhookUrl(b.url);
      acc.webhook = { url: u, secret: (acc.webhook && acc.webhook.secret) || "whsec_" + rnd(20) }; save(acc);
      return send(res, 200, acc.webhook);
    }
    if (m === "DELETE") { acc.webhook = null; save(acc); return send(res, 200, { url: null }); }
  }
  if (m === "POST" && path === "/v1/webhook/test") {
    if (!acc.webhook) throw bad(409, "no_webhook", "Register a webhook first with PUT /v1/webhook");
    deliver(acc, { id: "evt_" + rnd(8), type: "ping", created_at: new Date().toISOString(), data: {} });
    return send(res, 202, { queued: true });
  }
  if (m === "GET" && path === "/v1/webhook/deliveries") return send(res, 200, { data: acc.deliveries.map(({ event, ...rest }) => rest) });
  if (path === "/v1/script") {
    if (m === "GET") return send(res, 200, { active: planOf(acc) === "pro" && !!(acc.script && acc.script.rules.length), rules: acc.script ? acc.script.rules : [], requests_counted: acc.script ? acc.script.count : 0, max_rules: MAX_RULES, pro: planOf(acc) === "pro" });
    if (m === "PUT") {
      requirePro(acc, "Failure scripting");
      acc.script = { rules: parseScript(await readBody(req)), count: 0, updated_at: new Date().toISOString() }; save(acc);
      return send(res, 200, { active: acc.script.rules.length > 0, rules: acc.script.rules, requests_counted: 0, max_rules: MAX_RULES, pro: true });
    }
    if (m === "DELETE") { acc.script = null; save(acc); return send(res, 200, { active: false, rules: [] }); }
  }
  let dm;
  if (m === "GET" && (dm = path.match(/^\/v1\/webhook\/deliveries\/(dlv_[a-f0-9]+)$/))) {
    const d = acc.deliveries.find((x) => x.id === dm[1]);
    if (!d) throw bad(404, "not_found", "Delivery not found (only the latest 100 are kept)");
    return send(res, 200, d);
  }
  if (m === "POST" && (dm = path.match(/^\/v1\/webhook\/deliveries\/(dlv_[a-f0-9]+)\/replay$/))) {
    requirePro(acc, "Webhook replay");
    if (!acc.webhook) throw bad(409, "no_webhook", "Register a webhook first with PUT /v1/webhook");
    const d = acc.deliveries.find((x) => x.id === dm[1]);
    if (!d) throw bad(404, "not_found", "Delivery not found (only the latest 100 are kept)");
    if (!d.event) throw bad(409, "not_replayable", "This delivery was made before replay existed and has no stored event");
    if (limited(buckets, "replay:" + acc.id, 20, 60e3)) throw bad(429, "rate_limited", "Too many replays; wait a minute");
    deliver(acc, d.event, { replayOf: d.id });
    return send(res, 202, { queued: true, replay_of: d.id, event_id: d.event.id });
  }


  if (m === "POST" && path === "/v1/account/email") {
    if (!emailOn()) throw bad(503, "email_unavailable", "Email is not open yet");
    const email = cleanEmail((await readBody(req)).email);
    if (limited(mailLimits, "acct:" + acc.id, 5, 3600e3) || limited(mailIpLimits, clientIp(req), MAIL_IP_LIMIT, 3600e3)) throw bad(429, "rate_limited", "Too many requests. Try again in an hour.");
    const taken = DB.emails[email] && DB.emails[email] !== acc.id;
    if (!taken) {
      const token = makeToken("verify", acc.id, email, VERIFY_MS);
      sendMail(email, "Confirm your email for Zanboxx", `Open this link within an hour to confirm this address for your Zanboxx account:\n\n${PUBLIC_URL}/?verify=${token}\n\nOnce confirmed you can sign in with a link sent to this address if you ever lose your API key. If you did not ask for this, ignore this email.`).catch((e) => console.error("mail failed:", e.message));
    }
    return send(res, 200, { sent: true, message: "If the address can be used, a confirmation link is on its way." });
  }
  if (m === "DELETE" && path === "/v1/account/email") { dropAccountEmail(acc); save(acc); return send(res, 200, { removed: true }); }
  if (m === "POST" && path === "/v1/account/rotate-key") return send(res, 200, { api_key: issueKey(acc), note: "Your previous API key no longer works." });
  if (m === "GET" && path === "/v1/usage") {
    const sub = acc.plan === "pro", tr = trialActive(acc);
    return send(res, 200, {
      email: acc.email_verified ? acc.email : null, plan, plan_source: sub ? "subscription" : tr ? "trial" : "free",
      trial_ends: tr ? acc.trial.ends : null, trial_days_left: tr ? Math.max(1, Math.ceil((Date.parse(acc.trial.ends) - Date.now()) / 864e5)) : null,
      trial_available: !acc.trial && TRIAL_DAYS > 0 && emailOn() && !acc.email_verified, trial_days: TRIAL_DAYS,
      month: acc.usage.month, used: acc.usage.count, limit: PLANS[plan].monthly, billing: billingOn(),
      subscription_status: acc.stripe ? acc.stripe.status : null, script_active: !!(acc.script && acc.script.rules.length && plan === "pro"),
    });
  }

  if (m === "POST" && path === "/v1/billing/checkout") {
    if (!billingOn()) throw bad(503, "billing_unavailable", "Pro plan billing is not open yet");
    if (acc.plan === "pro") throw bad(409, "already_pro", "This account is already on the Pro plan");
    const s = await stripe("POST", "/v1/checkout/sessions", {
      mode: "subscription", client_reference_id: acc.id,
      line_items: [{ price: STRIPE_PRICE, quantity: 1 }],
      success_url: PUBLIC_URL + "/?billing=success", cancel_url: PUBLIC_URL + "/?billing=cancelled",
      allow_promotion_codes: "true", billing_address_collection: "required",
      ...(acc.stripe && acc.stripe.customer ? { customer: acc.stripe.customer } : { tax_id_collection: { enabled: "true" }, ...(acc.email_verified ? { customer_email: acc.email } : {}) }),
    });
    if (!s.url) throw bad(502, "billing_error", "The payment provider did not return a checkout link");
    return send(res, 200, { url: s.url });
  }
  if (m === "POST" && path === "/v1/billing/portal") {
    if (!billingOn()) throw bad(503, "billing_unavailable", "Pro plan billing is not open yet");
    if (!acc.stripe || !acc.stripe.customer) throw bad(409, "no_billing", "This account has no billing history yet");
    const s = await stripe("POST", "/v1/billing_portal/sessions", { customer: acc.stripe.customer, return_url: PUBLIC_URL + "/" });
    if (!s.url) throw bad(502, "billing_error", "The payment provider did not return a billing link");
    return send(res, 200, { url: s.url });
  }
  if (m === "DELETE" && path === "/v1/account") {
    const b = await readBody(req);
    if (b.confirm !== true) throw bad(400, "confirmation_required", 'Send {"confirm": true} to delete this account and all its data');
    if (acc.stripe && acc.stripe.subscription && billingOn()) {
      try { await stripe("DELETE", `/v1/subscriptions/${encodeURIComponent(acc.stripe.subscription)}`); }
      catch (e) {
        // A subscription that no longer exists (404) is already cancelled; any other failure blocks deletion so nobody keeps paying for a deleted account.
        if (!(e.extra && e.extra.provider_status === 404)) throw bad(502, "billing_error", "Could not cancel the subscription, so the account was not deleted. Try again, or contact support.");
      }
    }
    purgeAccount(acc.id);
    return send(res, 200, { deleted: true });
  }
  if (m === "DELETE" && path === "/v1/payments") { acc.payments = []; acc.deliveries = []; acc.disputes = []; acc.agreements = []; acc.settlements = []; save(acc); return send(res, 200, { cleared: true }); }
  throw bad(404, "not_found", "Unknown endpoint");
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (e instanceof ApiError) return send(res, e.status, { error: { code: e.code, message: e.message, ...e.extra } });
    console.error(e); send(res, 500, { error: { code: "internal", message: "Unexpected error" } });
  });
});
if (require.main === module) {
  server.listen(PORT, () => console.log(`Zanboxx API listening on :${PORT} (billing ${billingOn() ? "on" : "off"})`));
  purgeInactive();
  setInterval(purgeInactive, 24 * 3600e3).unref();
  backups.start();
  setInterval(() => { for (const a of Object.values(DB.accounts)) if (DSP.hasOpen(a)) { try { sweepDisputes(a); } catch (e) { console.error("dispute sweep:", e.message); } } }, 2000).unref();
  console.log(`Database: ${DB_FILE} (${Object.keys(DB.accounts).length} accounts)`);
  // On shutdown (deploys, restarts) write pending changes first, so nothing from the last moments is lost.
  let closing = false;
  const shutdown = (sig) => {
    if (closing) return; closing = true;
    console.log(`${sig} received: saving and exiting`);
    try { flushNow(); store.close(); } catch (e) { console.error("shutdown save failed:", e.message); }
    server.close(); setTimeout(() => process.exit(0), 100).unref(); process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM")); process.on("SIGINT", () => shutdown("SIGINT"));
}
module.exports = server;
