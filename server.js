"use strict";
// DryRun: hosted payment-gateway sandbox API. Zero dependencies, Node 18+.
const http = require("http"), crypto = require("crypto"), fs = require("fs"), dns = require("dns").promises, net = require("net");

const PORT = +process.env.PORT || 8080;
const DATA_FILE = process.env.DATA_FILE || "./data.json";
const SIGNUP_TOKEN = process.env.SIGNUP_TOKEN || "";
const MAX_ACCOUNTS = +process.env.MAX_ACCOUNTS || 2000;
const MAX_PAYMENTS_PER_ACCOUNT = 500;
let INDEX_HTML = null;
try { INDEX_HTML = fs.readFileSync(require("path").join(__dirname, "public", "index.html")); } catch {}
// Behind Fly's proxy the socket address is the proxy, so use the header it sets (only trusted on Fly).
const clientIp = (req) => (process.env.FLY_APP_NAME && req.headers["fly-client-ip"]) || req.socket.remoteAddress || "?";
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_WEBHOOKS === "1";
const RETRY_MS = (process.env.RETRY_MS || "0,2000,10000,30000").split(",").map(Number);
const SETTLE_MS = process.env.SETTLE_DELAY_MS ? +process.env.SETTLE_DELAY_MS : 3000;
const PLANS = { free: { monthly: 200, rpm: 30 }, pro: { monthly: 20000, rpm: 300 } };

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
  "4000000000000069": "expired", "4000000000003220": "3ds", "4000000000000408": "timeout",
};
const FAILS = { decline: ["SBX-4002", "Card declined by issuer"], nsf: ["SBX-4051", "Insufficient funds"], expired: ["SBX-4054", "Card expired"] };

// ---------- storage ----------
let DB = { accounts: {}, keys: {} };
try { DB = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {}
let timer = null;
const save = () => { clearTimeout(timer); timer = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify(DB), () => {}), 200); };
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

async function deliver(acc, event) {
  const wh = acc.webhook;
  if (!wh || !wh.url) return;
  const rec = { event_id: event.id, event_type: event.type, url: wh.url, delivered: false, attempts: [] };
  acc.deliveries.unshift(rec); acc.deliveries = acc.deliveries.slice(0, 100);
  const body = JSON.stringify(event);
  for (const wait of RETRY_MS) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const at = new Date().toISOString();
    try {
      await checkWebhookUrl(wh.url);
      const ts = Math.floor(Date.now() / 1000);
      const res = await fetch(wh.url, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000), body,
        headers: { "content-type": "application/json", "x-dryrun-signature": sign(wh.secret, ts, body), "x-dryrun-event": event.type },
      });
      rec.attempts.push({ at, status: res.status });
      if (res.status >= 200 && res.status < 300) { rec.delivered = true; break; }
    } catch (e) { rec.attempts.push({ at, error: String(e.message || e).slice(0, 120) }); }
  }
  save();
}
function emit(acc, p) {
  const ok = p.transaction_state === "success";
  deliver(acc, { id: "evt_" + rnd(8), type: ok ? "payment.succeeded" : "payment.failed", created_at: new Date().toISOString(), data: pub(p) });
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
    if (amount > r2(p.amount - p.refunded_amount)) return ["SBX-4225", `Amount exceeds refundable balance of ${r2(p.amount - p.refunded_amount).toFixed(2)}`];
  }
  if (type === "void") {
    if (["refund", "void"].includes(p.transaction_type)) return ["SBX-4226", "Refunds and voids cannot be voided"];
    if (p.transaction_type === "authorization" && p.captured_amount > 0) return ["SBX-4227", "Authorization already captured; refund the capture instead"];
    if (p.transaction_type !== "authorization" && p.refunded_amount > 0) return ["SBX-4228", "Transaction already refunded; it can no longer be voided"];
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
function settle(acc, p, ok, code, message) {
  p.transaction_state = ok ? "success" : "failed";
  p.status = { code, message };
  delete p._3ds;
  if (ok) effects(acc, p);
  save();
  setTimeout(() => emit(acc, p), 300);
}

function createPayment(acc, b) {
  if (typeof b.request_id !== "string" || !b.request_id || b.request_id.length > 64) throw bad(400, "invalid_request", "request_id is required (string, max 64 chars)");
  const dup = acc.payments.find((p) => p.request_id === b.request_id);
  if (dup) throw bad(409, "duplicate_request", "request_id already used; fetch the original transaction instead", { transaction_id: dup.id });
  if (!TYPES[b.method]) throw bad(400, "invalid_request", `method must be one of ${Object.keys(TYPES).join(", ")}`);
  if (!TYPES[b.method].includes(b.transaction_type)) throw bad(400, "invalid_request", `transaction_type for ${b.method} must be one of ${TYPES[b.method].join(", ")}`);
  const scenario = b.scenario || "auto";
  if (!SCENARIOS.includes(scenario)) throw bad(400, "invalid_request", `scenario must be one of ${SCENARIOS.join(", ")}`);
  if (scenario === "3ds" && b.method !== "card") throw bad(400, "invalid_request", "3ds scenario is only available for card payments");

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
  if (b.method === "card" && !parent && scenario === "auto" && !/^\d{16}$/.test(card)) throw bad(400, "invalid_request", "card_number must have 16 digits when scenario is auto");

  let outcome = scenario;
  if (scenario === "auto") outcome = parent || b.method !== "card" ? "approve" : CARDS[card] || "decline";

  const p = {
    id: "tx_" + rnd(8), request_id: b.request_id, transaction_type: type, transaction_state: "pending", method: b.method,
    amount, currency, parent_transaction_id: parent ? parent.id : null, status: { code: "SBX-2010", message: "Processing" },
    created_at: new Date().toISOString(),
  };
  if (b.method === "card" && !parent && card) p.card_last4 = card.slice(-4);
  if (type === "authorization") p.captured_amount = 0;
  if (PAY.includes(type)) p.refunded_amount = 0;
  acc.payments.unshift(p);
  if (acc.payments.length > MAX_PAYMENTS_PER_ACCOUNT) acc.payments.length = MAX_PAYMENTS_PER_ACCOUNT;

  if (outcome === "approve") { settle(acc, p, true, "SBX-2000", "Transaction approved"); return { status: 201, body: pub(p) }; }
  if (outcome === "timeout") {
    p.status = { code: "SBX-5040", message: "Gateway timeout; outcome unknown" };
    setTimeout(() => settle(acc, p, true, "SBX-2000", "Approved after timeout"), SETTLE_MS);
    save();
    return { status: 504, body: { error: { code: "SBX-5040", message: "Gateway timeout. Outcome unknown: wait for the webhook or poll GET /v1/payments/{id} before retrying.", transaction_id: p.id } } };
  }
  if (outcome === "3ds") {
    p._3ds = true; p.status = { code: "SBX-2020", message: "Waiting for 3D Secure" };
    save();
    return { status: 202, body: { ...pub(p), three_ds: { required: true, confirm_url: `/v1/payments/${p.id}/3ds` } } };
  }
  const f = FAILS[outcome] || FAILS.decline;
  settle(acc, p, false, f[0], f[1]);
  return { status: 201, body: pub(p) };
}

// ---------- http plumbing ----------
const buckets = new Map(), signups = new Map();
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
function auth(req) {
  const m = (req.headers.authorization || "").match(/^Bearer (sk_test_[a-f0-9]+)$/);
  const id = m && DB.keys[sha(m[1])];
  if (!id) throw bad(401, "unauthorized", "Missing or invalid API key. Send 'Authorization: Bearer sk_test_...'");
  return DB.accounts[id];
}

async function route(req, res) {
  const url = new URL(req.url, "http://x"), path = url.pathname, m = req.method;
  if (m === "GET" && path === "/health") return send(res, 200, { ok: true });
  if (m === "GET" && (path === "/" || path === "/index.html") && INDEX_HTML) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": INDEX_HTML.length, "cache-control": "no-cache", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    return res.end(INDEX_HTML);
  }

  if (m === "POST" && path === "/v1/accounts") {
    if (SIGNUP_TOKEN && req.headers["x-signup-token"] !== SIGNUP_TOKEN) throw bad(403, "forbidden", "Signup is invite-only");
    if (limited(signups, clientIp(req), 5, 3600e3)) throw bad(429, "rate_limited", "Too many signups from this address");
    if (Object.keys(DB.accounts).length >= MAX_ACCOUNTS) throw bad(503, "signups_closed", "Signups are temporarily closed");
    const key = "sk_test_" + rnd(24), id = "acct_" + rnd(6);
    DB.accounts[id] = { id, plan: "free", created_at: new Date().toISOString(), usage: { month: "", count: 0 }, payments: [], deliveries: [], webhook: null };
    DB.keys[sha(key)] = id; save();
    return send(res, 201, { account_id: id, api_key: key, plan: "free", note: "Store this key now; it cannot be shown again." });
  }

  const acc = auth(req);
  if (limited(buckets, acc.id, PLANS[acc.plan].rpm, 60e3)) throw bad(429, "rate_limited", "Rate limit exceeded; slow down");

  if (m === "POST" && path === "/v1/payments") {
    const month = new Date().toISOString().slice(0, 7);
    if (acc.usage.month !== month) acc.usage = { month, count: 0 };
    if (acc.usage.count >= PLANS[acc.plan].monthly) throw bad(402, "plan_limit", `Monthly limit of ${PLANS[acc.plan].monthly} payments reached for the ${acc.plan} plan`);
    const out = createPayment(acc, await readBody(req));
    acc.usage.count++; save();
    return send(res, out.status, out.body);
  }
  if (m === "GET" && path === "/v1/payments") {
    const limit = Math.min(Math.max(+url.searchParams.get("limit") || 25, 1), 100), state = url.searchParams.get("state");
    return send(res, 200, { data: acc.payments.filter((p) => !state || p.transaction_state === state).slice(0, limit).map(pub) });
  }
  let mt;
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
    if (b.result === "approve") settle(acc, p, true, "SBX-2000", "Approved after 3D Secure");
    else settle(acc, p, false, "SBX-4030", "3D Secure authentication failed");
    return send(res, 200, pub(p));
  }
  if (path === "/v1/webhook") {
    if (m === "GET") return send(res, 200, acc.webhook || { url: null });
    if (m === "PUT") {
      const b = await readBody(req), u = await checkWebhookUrl(b.url);
      acc.webhook = { url: u, secret: (acc.webhook && acc.webhook.secret) || "whsec_" + rnd(20) }; save();
      return send(res, 200, acc.webhook);
    }
    if (m === "DELETE") { acc.webhook = null; save(); return send(res, 200, { url: null }); }
  }
  if (m === "POST" && path === "/v1/webhook/test") {
    if (!acc.webhook) throw bad(409, "no_webhook", "Register a webhook first with PUT /v1/webhook");
    deliver(acc, { id: "evt_" + rnd(8), type: "ping", created_at: new Date().toISOString(), data: {} });
    return send(res, 202, { queued: true });
  }
  if (m === "GET" && path === "/v1/webhook/deliveries") return send(res, 200, { data: acc.deliveries });
  if (m === "GET" && path === "/v1/usage") return send(res, 200, { plan: acc.plan, month: acc.usage.month, used: acc.usage.count, limit: PLANS[acc.plan].monthly });
  if (m === "DELETE" && path === "/v1/payments") { acc.payments = []; acc.deliveries = []; save(); return send(res, 200, { cleared: true }); }
  throw bad(404, "not_found", "Unknown endpoint");
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (e instanceof ApiError) return send(res, e.status, { error: { code: e.code, message: e.message, ...e.extra } });
    console.error(e); send(res, 500, { error: { code: "internal", message: "Unexpected error" } });
  });
});
if (require.main === module) server.listen(PORT, () => console.log(`DryRun API listening on :${PORT}`));
module.exports = server;
