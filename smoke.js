"use strict";
// Run: npm test  (starts the server and a local webhook receiver, then exercises every flow)
const { spawn } = require("child_process"), http = require("http"), crypto = require("crypto"), assert = require("assert");
const PORT = 18080, HOOK = 18081, STRIPE_PORT = 18082, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WH_SECRET = "whsec_test_secret";
const srv = spawn("node", ["server.js"], {
  env: {
    ...process.env, PORT, DATA_FILE: `/tmp/dryrun-test-${Date.now()}.json`, ALLOW_PRIVATE_WEBHOOKS: "1", RETRY_MS: "0,200", SETTLE_DELAY_MS: "300",
    STRIPE_SECRET_KEY: "sk_test_mock", STRIPE_PRICE_ID: "price_test_1", STRIPE_WEBHOOK_SECRET: WH_SECRET,
    STRIPE_API_BASE: `http://127.0.0.1:${STRIPE_PORT}`, PUBLIC_URL: "https://example.test", PRO_PRICE_LABEL: "EUR 19 per month",
    OPERATOR_NAME: "Test Operator Ltd", OPERATOR_ADDRESS: "1 Test Street", CONTACT_EMAIL: "legal@example.test",
  },
  stdio: "inherit",
});
// Mock Stripe: records every call so the test can check what the server sent.
const stripeCalls = []; let stripeFail404 = false;
const mockStripe = http.createServer((req, res) => {
  let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => {
    stripeCalls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: decodeURIComponent(d) });
    res.setHeader("content-type", "application/json");
    if (req.method === "DELETE" && stripeFail404) { res.writeHead(404); return res.end(JSON.stringify({ error: { message: "No such subscription" } })); }
    if (req.url === "/v1/checkout/sessions") return res.end(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.test/c/cs_1" }));
    if (req.url === "/v1/billing_portal/sessions") return res.end(JSON.stringify({ id: "bps_1", url: "https://billing.stripe.test/p/bps_1" }));
    res.end(JSON.stringify({ id: "sub_1", status: "canceled" }));
  });
}).listen(STRIPE_PORT);
const stripeSig = (raw, secret = WH_SECRET, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
const stripeEvent = async (type, object, opts = {}) => {
  const raw = JSON.stringify({ id: "evt_" + Math.random().toString(36).slice(2), type, data: { object } });
  const r = await fetch(BASE + "/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": opts.sig || stripeSig(raw) }, body: raw });
  return { status: r.status, body: await r.json() };
};
const hooks = []; let failFirst = true, secret = "";
const receiver = http.createServer((req, res) => {
  let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => {
    const [t, v] = req.headers["x-dryrun-signature"].split(",").map((s) => s.split("=")[1]);
    const ok = crypto.createHmac("sha256", secret).update(`${t}.${d}`).digest("hex") === v;
    hooks.push({ body: JSON.parse(d), ok });
    if (failFirst && JSON.parse(d).type === "payment.failed") { failFirst = false; res.writeHead(500); return res.end(); }
    res.writeHead(200); res.end();
  });
}).listen(HOOK);

let key;
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const card = (n, extra = {}) => ({ request_id: "r_" + Math.random().toString(36).slice(2), method: "card", transaction_type: "purchase", amount: 10, currency: "EUR", card_number: n, ...extra });

(async () => {
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(BASE + "/health"); break; } catch { await sleep(100); } }
    const home = await fetch(BASE + "/");
    assert.equal(home.status, 200); assert.ok((await home.text()).includes("DryRun"), "landing page served");
    assert.equal((await api("GET", "/v1/payments")).status, 401);
    const acct = await api("POST", "/v1/accounts"); key = acct.body.api_key;
    assert.equal(acct.status, 201);
    const wh = await api("PUT", "/v1/webhook", { url: `http://127.0.0.1:${HOOK}/hook` }); secret = wh.body.secret;
    assert.ok(secret.startsWith("whsec_"));

    const ok = await api("POST", "/v1/payments", card("4111 1111 1111 1111"));
    assert.equal(ok.status, 201); assert.equal(ok.body.transaction_state, "success");
    const dup = await api("POST", "/v1/payments", { ...card("4111111111111111"), request_id: ok.body.request_id });
    assert.equal(dup.status, 409);

    const refund = await api("POST", "/v1/payments", { request_id: "ref1", method: "card", transaction_type: "refund", amount: 4, parent_transaction_id: ok.body.id });
    assert.equal(refund.body.transaction_state, "success");
    const over = await api("POST", "/v1/payments", { request_id: "ref2", method: "card", transaction_type: "refund", amount: 7, parent_transaction_id: ok.body.id });
    assert.equal(over.status, 422); assert.equal(over.body.error.code, "SBX-4225");
    assert.equal((await api("GET", `/v1/payments/${ok.body.id}`)).body.refunded_amount, 4);

    const auth = await api("POST", "/v1/payments", card("4111111111111111", { transaction_type: "authorization", amount: 50 }));
    const cap = await api("POST", "/v1/payments", { request_id: "cap1", method: "card", transaction_type: "capture-authorization", amount: 30, parent_transaction_id: auth.body.id });
    assert.equal(cap.body.transaction_state, "success");
    const voidAfter = await api("POST", "/v1/payments", { request_id: "v1", method: "card", transaction_type: "void", parent_transaction_id: auth.body.id });
    assert.equal(voidAfter.body.error.code, "SBX-4227");

    const dec = await api("POST", "/v1/payments", card("4000000000000002"));
    assert.equal(dec.body.transaction_state, "failed"); assert.equal(dec.body.status.code, "SBX-4002");

    const d3 = await api("POST", "/v1/payments", card("4000000000003220"));
    assert.equal(d3.status, 202); assert.equal(d3.body.three_ds.required, true);
    const d3ok = await api("POST", `/v1/payments/${d3.body.id}/3ds`, { result: "approve" });
    assert.equal(d3ok.body.transaction_state, "success");
    assert.equal((await api("POST", `/v1/payments/${d3.body.id}/3ds`, { result: "approve" })).status, 409);

    const to = await api("POST", "/v1/payments", card("4000000000000408"));
    assert.equal(to.status, 504);
    assert.equal((await api("GET", `/v1/payments/${to.body.error.transaction_id}`)).body.transaction_state, "pending");
    await sleep(1500);
    assert.equal((await api("GET", `/v1/payments/${to.body.error.transaction_id}`)).body.transaction_state, "success");

    assert.ok(hooks.length >= 6, "webhooks delivered");
    assert.ok(hooks.every((h) => h.ok), "all signatures valid");
    const del = (await api("GET", "/v1/webhook/deliveries")).body.data.find((x) => x.event_type === "payment.failed");
    assert.equal(del.attempts.length, 2); assert.equal(del.delivered, true);

    const priv = await fetch(BASE + "/v1/webhook", { method: "PUT", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ url: "not a url" }) });
    assert.equal(priv.status, 400);
    // ---------- billing, legal pages and account deletion (against the mock Stripe) ----------
    const cfg = await (await fetch(BASE + "/v1/config")).json();
    assert.deepEqual(cfg, { billing: true, pro_price: "EUR 19 per month" });
    for (const p of ["/terms", "/privacy"]) {
      const r = await fetch(BASE + p), t = await r.text();
      assert.equal(r.status, 200);
      assert.ok(t.includes("Test Operator Ltd") && t.includes("legal@example.test"), p + " shows operator details");
      assert.ok(!t.includes("{{"), p + " has no unreplaced placeholders");
      assert.ok(r.headers.get("content-security-policy").includes("default-src 'none'"));
    }
    const home2 = await fetch(BASE + "/");
    assert.ok((await home2.text()).includes("/terms") && home2.headers.get("content-security-policy").includes("frame-ancestors 'none'"));

    const a2 = await api("POST", "/v1/accounts"); key = a2.body.api_key; const accId = a2.body.account_id;
    assert.equal((await api("GET", "/v1/usage")).body.limit, 200);

    const co = await api("POST", "/v1/billing/checkout");
    assert.equal(co.status, 200); assert.equal(co.body.url, "https://checkout.stripe.test/c/cs_1");
    const coCall = stripeCalls.find((c) => c.url === "/v1/checkout/sessions");
    assert.equal(coCall.auth, "Bearer sk_test_mock");
    for (const part of ["mode=subscription", `client_reference_id=${accId}`, "line_items[0][price]=price_test_1", "line_items[0][quantity]=1", "success_url=https://example.test/?billing=success"])
      assert.ok(coCall.body.includes(part), "checkout request has " + part);
    assert.equal((await api("POST", "/v1/billing/portal")).status, 409, "portal needs a customer first");

    // webhook security
    const evObj = { client_reference_id: accId, mode: "subscription", payment_status: "paid", customer: "cus_1", subscription: "sub_1" };
    assert.equal((await stripeEvent("checkout.session.completed", evObj, { sig: "t=1,v1=bad" })).status, 400, "bad signature rejected");
    const raw = JSON.stringify({ id: "evt_x", type: "checkout.session.completed", data: { object: evObj } });
    const oldSig = stripeSig(raw, WH_SECRET, Math.floor(Date.now() / 1000) - 3600);
    const stale = await fetch(BASE + "/stripe/webhook", { method: "POST", headers: { "stripe-signature": oldSig }, body: raw });
    assert.equal(stale.status, 400, "correctly signed but old (replayed) event rejected");
    assert.equal((await stripeEvent("checkout.session.completed", evObj, { sig: stripeSig("tampered") })).status, 400, "signature for a different body rejected");
    assert.equal((await api("GET", "/v1/usage")).body.plan, "free", "rejected events changed nothing");

    // upgrade, payment status changes, downgrade
    assert.equal((await stripeEvent("checkout.session.completed", { ...evObj, payment_status: "unpaid" })).status, 200);
    assert.equal((await api("GET", "/v1/usage")).body.plan, "free", "unpaid checkout does not upgrade");
    assert.equal((await stripeEvent("checkout.session.completed", evObj)).status, 200);
    const pro = await api("GET", "/v1/usage");
    assert.equal(pro.body.plan, "pro"); assert.equal(pro.body.limit, 20000);
    assert.equal((await api("POST", "/v1/billing/checkout")).status, 409, "already pro");
    const portal = await api("POST", "/v1/billing/portal");
    assert.equal(portal.status, 200); assert.equal(portal.body.url, "https://billing.stripe.test/p/bps_1");
    assert.ok(stripeCalls.find((c) => c.url === "/v1/billing_portal/sessions").body.includes("customer=cus_1"));
    await stripeEvent("customer.subscription.updated", { id: "sub_1", customer: "cus_1", status: "past_due" });
    assert.equal((await api("GET", "/v1/usage")).body.plan, "pro", "past_due keeps Pro while Stripe retries");
    await stripeEvent("customer.subscription.updated", { id: "sub_1", customer: "cus_1", status: "unpaid" });
    assert.equal((await api("GET", "/v1/usage")).body.plan, "free", "unpaid downgrades");
    await stripeEvent("customer.subscription.updated", { id: "sub_1", customer: "cus_1", status: "active" });
    assert.equal((await api("GET", "/v1/usage")).body.plan, "pro", "active upgrades again");
    await stripeEvent("customer.subscription.deleted", { id: "sub_1", customer: "cus_1", status: "canceled" });
    const freed = await api("GET", "/v1/usage");
    assert.equal(freed.body.plan, "free"); assert.equal(freed.body.subscription_status, "canceled");
    assert.equal((await stripeEvent("customer.subscription.updated", { id: "sub_9", customer: "cus_unknown", status: "active" })).status, 200, "unknown customer is ignored");

    // account deletion cancels the subscription first
    await stripeEvent("checkout.session.completed", evObj);
    assert.equal((await api("DELETE", "/v1/account")).status, 400, "deletion needs confirmation");
    assert.equal((await api("GET", "/v1/usage")).status, 200, "still exists");
    const delAcct = await api("DELETE", "/v1/account", { confirm: true });
    assert.equal(delAcct.status, 200); assert.equal(delAcct.body.deleted, true);
    assert.ok(stripeCalls.some((c) => c.method === "DELETE" && c.url === "/v1/subscriptions/sub_1"), "subscription cancelled at Stripe");
    assert.equal((await api("GET", "/v1/usage")).status, 401, "key stops working after deletion");

    // an already-cancelled subscription (404 at Stripe) must not block deletion
    const a3 = await api("POST", "/v1/accounts"); key = a3.body.api_key;
    await stripeEvent("checkout.session.completed", { ...evObj, client_reference_id: a3.body.account_id, customer: "cus_3", subscription: "sub_3" });
    stripeFail404 = true;
    assert.equal((await api("DELETE", "/v1/account", { confirm: true })).status, 200, "404 from Stripe does not block deletion");
    stripeFail404 = false;

    console.log("All checks passed");
  } catch (e) { console.error("FAILED:", e.message); process.exitCode = 1; }
  finally { srv.kill(); receiver.close(); mockStripe.close(); }
})();
