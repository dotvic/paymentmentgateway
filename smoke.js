"use strict";
// Run: npm test  (starts the server and a local webhook receiver, then exercises every flow)
const { spawn } = require("child_process"), http = require("http"), crypto = require("crypto"), assert = require("assert");
const PORT = 18080, HOOK = 18081, STRIPE_PORT = 18082, MAIL_PORT = 18083, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WH_SECRET = "whsec_test_secret";
const srv = spawn("node", ["server.js"], {
  env: {
    ...process.env, PORT, DATA_FILE: `/tmp/dryrun-test-${Date.now()}.json`, ALLOW_PRIVATE_WEBHOOKS: "1", RETRY_MS: "0,200", SETTLE_DELAY_MS: "300",
    SIGNUPS_PER_HOUR: "50", MAIL_IP_PER_HOUR: "100", EMAIL_API_KEY: "re_test", EMAIL_FROM: "Zanboxx <login@example.test>", EMAIL_API_BASE: `http://127.0.0.1:${MAIL_PORT}`,
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
// Mock email provider: collects every message so the test can read the links.
const mails = []; let mailFail = false;
const mockMail = http.createServer((req, res) => {
  let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => {
    if (mailFail) { res.writeHead(500); return res.end("{}"); }
    mails.push({ auth: req.headers.authorization, ...JSON.parse(d) }); res.setHeader("content-type", "application/json"); res.end("{\"id\":\"m1\"}");
  });
}).listen(MAIL_PORT);
const lastLink = (param) => { const m = mails[mails.length - 1].text.match(new RegExp("/\\?" + param + "=([a-f0-9]+)")); return m && m[1]; };
const hooks = []; let failFirst = true, secret = "";
const receiver = http.createServer((req, res) => {
  let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => {
    const [t, v] = req.headers["x-dryrun-signature"].split(",").map((s) => s.split("=")[1]);
    const ok = crypto.createHmac("sha256", secret).update(`${t}.${d}`).digest("hex") === v;
    hooks.push({ body: JSON.parse(d), ok, replay: req.headers["x-dryrun-replay"] === "true" });
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
    assert.equal(home.status, 200); assert.ok((await home.text()).includes("Zanboxx"), "landing page served");
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
    assert.deepEqual(cfg, { billing: true, email: true, pro_price: "EUR 19 per month" });
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

    // ---------- 3-D Secure lab: message logs for every outcome ----------
    const a4 = await api("POST", "/v1/accounts"); key = a4.body.api_key;
    await stripeEvent("checkout.session.completed", { client_reference_id: a4.body.account_id, mode: "subscription", payment_status: "paid", customer: "cus_4", subscription: "sub_4" });
    const tds = (n, extra = {}) => api("POST", "/v1/payments", card(n, extra));
    const getLog = (id) => api("GET", `/v1/payments/${id}/3ds-log`);
    const EXPECT = {
      "4000000000003000": ["Y", "05", true, "success", "SBX-2000"], "4000000000003253": ["A", "06", true, "success", "SBX-2000"],
      "4000000000003261": ["U", "07", false, "success", "SBX-2002"], "4000000000003238": ["N", "07", false, "failed", "SBX-4030"],
      "4000000000003279": ["R", "07", false, "failed", "SBX-4032"],
    };
    let firstLogged = null;
    for (const [num, [ts, eci, shift, state, code]] of Object.entries(EXPECT)) {
      const r = await tds(num);
      assert.equal(r.status, 201, num); assert.equal(r.body.transaction_state, state, num); assert.equal(r.body.status.code, code, num);
      assert.deepEqual(r.body.authentication, { protocol: "3ds2", trans_status: ts, eci, liability_shift: shift }, num);
      firstLogged = firstLogged || r.body.id;
      const lg = await getLog(r.body.id);
      assert.equal(lg.status, 200); assert.equal(lg.body.complete, true); assert.equal(lg.body.result.trans_status, ts);
      const names = lg.body.steps.map((s) => s.name);
      assert.ok(names.includes("AReq") && names.includes("ARes") && !names.includes("CReq"), "frictionless flow has no challenge: " + ts);
      assert.equal(lg.body.steps.find((s) => s.name === "ARes").payload.transStatus, ts);
      lg.body.steps.forEach((s, i) => { assert.equal(s.n, i + 1); assert.ok(s.explain && s.title && s.from && s.to, "step has explanation"); if (i) assert.ok(s.offset_ms >= lg.body.steps[i - 1].offset_ms, "offsets never go backwards"); });
      if (ts === "Y" || ts === "A") {
        const ares = lg.body.steps.find((s) => s.name === "ARes").payload;
        assert.equal(ares.eci, eci); assert.ok(ares.authenticationValue.length >= 20); assert.ok(names.includes("Authorization response"));
      } else if (ts === "U") {
        assert.equal(lg.body.steps.find((s) => s.name === "Authorization").payload.authenticationValue, null);
      } else {
        assert.ok(names.includes("Stop") && !names.includes("Authorization"), "no authorisation after " + ts);
        assert.ok(lg.body.steps.find((s) => s.name === "ARes").payload.transStatusReason, "reason code present");
      }
      assert.ok(!JSON.stringify(lg.body).includes(num), "full card number never appears in the log");
    }

    // challenge: approve
    const ch = await tds("4000000000003220");
    assert.equal(ch.status, 202); assert.equal(ch.body.three_ds.log_url, `/v1/payments/${ch.body.id}/3ds-log`);
    assert.deepEqual(ch.body.authentication, { protocol: "3ds2", trans_status: "C", eci: null, liability_shift: null });
    const wait = (await getLog(ch.body.id)).body;
    assert.equal(wait.complete, false); assert.equal(wait.awaiting, "cardholder"); assert.equal(wait.result, null);
    assert.equal(wait.steps[wait.steps.length - 1].name, "CRes"); assert.equal(wait.steps[wait.steps.length - 1].payload.challengeCompletionInd, "N");
    const done = await api("POST", `/v1/payments/${ch.body.id}/3ds`, { result: "approve" });
    assert.equal(done.body.transaction_state, "success");
    assert.deepEqual(done.body.authentication, { protocol: "3ds2", trans_status: "Y", eci: "05", liability_shift: true });
    const full = (await getLog(ch.body.id)).body, fn = full.steps.map((s) => s.name);
    assert.equal(full.complete, true); assert.equal(full.awaiting, null);
    assert.deepEqual(full.steps.slice(0, wait.steps.length), wait.steps, "earlier steps are unchanged when the challenge finishes");
    assert.equal(fn.filter((n) => n === "CReq").length, 2); assert.equal(fn.filter((n) => n === "CRes").length, 2);
    assert.ok(fn.includes("RReq") && fn.includes("RRes") && fn.includes("Authorization response"));
    assert.ok(full.steps.find((s) => s.name === "RReq").payload.authenticationValue, "RReq carries the authentication value");
    assert.equal((await api("POST", `/v1/payments/${ch.body.id}/3ds`, { result: "approve" })).status, 409, "challenge can only be completed once");

    // challenge: wrong code
    const ch2 = await tds("4000000000003220");
    const failed = await api("POST", `/v1/payments/${ch2.body.id}/3ds`, { result: "fail" });
    assert.equal(failed.body.transaction_state, "failed"); assert.equal(failed.body.status.code, "SBX-4030");
    assert.deepEqual(failed.body.authentication, { protocol: "3ds2", trans_status: "N", eci: "07", liability_shift: false });
    const full2 = (await getLog(ch2.body.id)).body, fn2 = full2.steps.map((s) => s.name);
    assert.ok(fn2.includes("Stop") && !fn2.includes("Authorization"));
    assert.equal(full2.steps.find((s) => s.name === "RReq").payload.authenticationValue, undefined, "no authentication value after a failed challenge");

    // guards
    const plain = await tds("4111111111111111");
    const noLog = await getLog(plain.body.id);
    assert.equal(noLog.status, 404); assert.equal(noLog.body.error.code, "no_log");
    assert.equal((await api("POST", "/v1/payments", { request_id: "x3ds", method: "card", transaction_type: "refund", amount: 1, parent_transaction_id: plain.body.id, scenario: "3ds" })).status, 400);
    assert.equal((await getLog("tx_0000000000000000")).status, 404);

    // only the latest 20 logs are kept
    let lastId;
    for (let i = 0; i < 22; i++) lastId = (await tds("4000000000003000")).body.id;
    const old = await getLog(firstLogged);
    assert.equal(old.status, 404); assert.ok(old.body.error.message.includes("no longer stored"));
    assert.equal((await getLog(lastId)).status, 200);

    // ---- email: verify, sign in with a link, rotate key ----
    const cfgE = await (await fetch(BASE + "/v1/config")).json(); assert.equal(cfgE.email, true);
    const ea = await api("POST", "/v1/accounts"); const oldKey = ea.body.api_key; key = oldKey;
    assert.equal((await api("POST", "/v1/account/email", { email: "not-an-email" })).body.error.code, "invalid_email");
    const sent = await api("POST", "/v1/account/email", { email: "  Learner@Example.TEST " }); assert.equal(sent.status, 200);
    await sleep(150);
    assert.equal(mails.length, 1); assert.equal(mails[0].to[0], "learner@example.test"); assert.equal(mails[0].auth, "Bearer re_test");
    assert.ok(mails[0].text.includes("https://example.test/?verify="), "verification link built from PUBLIC_URL");
    assert.equal((await api("GET", "/v1/usage")).body.email, null, "not shown until verified");
    // sign-in before verification sends nothing
    await api("POST", "/v1/login", { email: "learner@example.test" }); await sleep(100);
    assert.equal(mails.length, 1, "unverified address gets no sign-in mail");
    const vtok = lastLink("verify");
    assert.equal((await api("POST", "/v1/email/verify", { token: "0".repeat(48) })).body.error.code, "invalid_token");
    assert.equal((await api("POST", "/v1/email/verify", { token: vtok })).body.verified, true);
    assert.equal((await api("POST", "/v1/email/verify", { token: vtok })).status, 400, "verification link works once");
    assert.equal((await api("GET", "/v1/usage")).body.email, "learner@example.test");
    // another account cannot take the same address, and cannot tell why
    const eb = await api("POST", "/v1/accounts"); key = eb.body.api_key;
    const before = mails.length;
    const dupE = await api("POST", "/v1/account/email", { email: "learner@example.test" }); await sleep(100);
    assert.equal(dupE.status, 200); assert.equal(mails.length, before, "no mail for an address that is taken");
    // unknown address looks identical to a known one
    const unk = await api("POST", "/v1/login", { email: "nobody@example.test" }); await sleep(100);
    assert.equal(unk.status, 200); assert.equal(mails.length, before);
    // sign in with a link: new key, old key dies, link works once
    key = null;
    const li = await api("POST", "/v1/login", { email: "LEARNER@example.test" }); assert.equal(li.status, 200); await sleep(150);
    assert.equal(mails.length, before + 1); assert.ok(mails[mails.length - 1].text.includes("/?login="));
    const ltok = lastLink("login");
    const red = await api("POST", "/v1/login/redeem", { token: ltok });
    assert.equal(red.status, 200); assert.ok(/^sk_test_[a-f0-9]+$/.test(red.body.api_key)); assert.equal(red.body.account_id, ea.body.account_id);
    assert.equal((await api("POST", "/v1/login/redeem", { token: ltok })).status, 400, "sign-in link works once");
    key = oldKey; assert.equal((await api("GET", "/v1/usage")).status, 401, "old key revoked");
    key = red.body.api_key; assert.equal((await api("GET", "/v1/usage")).status, 200);
    assert.equal((await api("POST", "/v1/login/redeem", { token: vtok })).status, 400, "a verify token cannot sign in");
    // rotate key
    const rot = await api("POST", "/v1/account/rotate-key"); const keyBeforeRot = key; key = rot.body.api_key;
    assert.equal((await api("GET", "/v1/usage")).status, 200);
    key = keyBeforeRot; assert.equal((await api("GET", "/v1/usage")).status, 401);
    key = rot.body.api_key;
    // rate limit: a 4th sign-in request for the same address in an hour is refused
    key = null;
    await api("POST", "/v1/login", { email: "learner@example.test" }); await api("POST", "/v1/login", { email: "learner@example.test" });
    assert.equal((await api("POST", "/v1/login", { email: "learner@example.test" })).status, 429);
    // mail provider failure does not leak or crash
    mailFail = true; assert.equal((await api("POST", "/v1/login", { email: "someone-else@example.test" })).status, 200); mailFail = false;
    // remove email, then it can be used by another account; deleting the account frees it too
    key = rot.body.api_key;
    assert.equal((await api("DELETE", "/v1/account/email")).body.removed, true);
    assert.equal((await api("GET", "/v1/usage")).body.email, null);
    key = eb.body.api_key;
await api("POST", "/v1/account/email", { email: "learner@example.test" }); await sleep(150);
    assert.equal((await api("POST", "/v1/email/verify", { token: lastLink("verify") })).status, 200, "address freed after removal");

    // ---- Pro trial, failure scripting, webhook inspector and replay ----
    const verifyEmail = async (email) => { await api("POST", "/v1/account/email", { email }); await sleep(150); return api("POST", "/v1/email/verify", { token: lastLink("verify") }); };
    const free = await api("POST", "/v1/accounts"); key = free.body.api_key;
    let u = (await api("GET", "/v1/usage")).body;
    assert.equal(u.plan, "free"); assert.equal(u.trial_available, true); assert.equal(u.trial_days, 14);
    const noPro = await api("PUT", "/v1/script", { rules: [{ then: { outcome: "decline" } }] });
    assert.equal(noPro.status, 402); assert.equal(noPro.body.error.code, "pro_required");
    assert.equal((await api("GET", "/v1/script")).body.pro, false);
    // confirming an email starts the trial, once per address and once per account
    const v1 = await verifyEmail("trial1@example.test");
    assert.equal(v1.status, 200); assert.ok(Date.parse(v1.body.trial_ends) - Date.now() > 13.9 * 864e5);
    u = (await api("GET", "/v1/usage")).body;
    assert.equal(u.plan, "pro"); assert.equal(u.plan_source, "trial"); assert.equal(u.trial_days_left, 14); assert.equal(u.limit, 20000); assert.equal(u.trial_available, false);
    assert.equal((await verifyEmail("trial1b@example.test")).body.trial_ends, null, "same account never gets a second trial");
    await api("DELETE", "/v1/account/email");
    const other = await api("POST", "/v1/accounts"); const trialKey = key; key = other.body.api_key;
    assert.equal((await verifyEmail("trial1@example.test")).body.trial_ends, null, "same address never gets a second trial");
    assert.equal((await api("GET", "/v1/usage")).body.plan, "free");
    key = trialKey;

    // script validation
    const bads = [
      [{}, "invalid_script"], [{ rules: "x" }, "invalid_script"], [{ rules: [{ when: { nth: 0 }, then: { outcome: "decline" } }] }, "invalid_script"],
      [{ rules: [{ then: {} }] }, "invalid_script"], [{ rules: [{ then: { outcome: "boom" } }] }, "invalid_script"],
      [{ rules: [{ when: { colour: "red" }, then: { outcome: "decline" } }] }, "invalid_script"], [{ rules: [{ then: { latency_ms: 99999 } }] }, "invalid_script"],
      [{ rules: [{ then: { http_error: 418 } }] }, "invalid_script"], [{ rules: [{ then: { webhook: { duplicate: 9 } } }] }, "invalid_script"],
      [{ rules: Array(21).fill({ then: { outcome: "decline" } }) }, "invalid_script"],
    ];
    for (const [body, code] of bads) { const r = await api("PUT", "/v1/script", body); assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.body.error.code, code); }

    // outcomes: nth, every, amount, probability
    const wh2 = await api("PUT", "/v1/webhook", { url: `http://127.0.0.1:${HOOK}/hook` }); secret = wh2.body.secret;
    const pay = (extra = {}) => api("POST", "/v1/payments", card("4111111111111111", extra));
    assert.equal((await api("PUT", "/v1/script", { rules: [
      { name: "second fails", when: { nth: 2 }, then: { outcome: "nsf" } },
      { when: { every: 3 }, then: { outcome: "decline" } },
      { when: { amount_gte: 500 }, then: { outcome: "expired" } },
    ] })).status, 200);
    const seq = [];
    for (const amt of [10, 10, 10, 10, 10, 10, 600]) seq.push((await pay({ amount: amt })).body);
    assert.deepEqual(seq.map((p) => p.transaction_state), ["success", "failed", "failed", "success", "success", "failed", "failed"]);
    assert.deepEqual(seq.map((p) => p.script_rule || null), [null, 1, 2, null, null, 2, 3]);
    assert.equal(seq[1].status.code, "SBX-4051"); assert.equal(seq[6].status.code, "SBX-4054");
    assert.equal((await api("GET", "/v1/script")).body.requests_counted, 7);
    // a script outcome of 3ds only applies where 3DS is possible
    await api("PUT", "/v1/script", { rules: [{ then: { outcome: "3ds_Y" } }] });
    const sy = await pay(); assert.equal(sy.status, 201); assert.equal(sy.body.authentication.trans_status, "Y");
    const rf = await api("POST", "/v1/payments", { request_id: "rf1", method: "card", transaction_type: "refund", amount: 1, parent_transaction_id: sy.body.id });
    assert.equal(rf.status, 201); assert.equal(rf.body.transaction_state, "success", "3ds rule ignored for a refund");

    // injected HTTP errors do not create payments or use up quota
    await api("PUT", "/v1/script", { rules: [{ when: { nth: 1 }, then: { http_error: 503 } }] });
    const usedBefore = (await api("GET", "/v1/usage")).body.used, countBefore = (await api("GET", "/v1/payments?limit=100")).body.data.length;
    const inj = await pay({ request_id: "inj-1" });
    assert.equal(inj.status, 503); assert.equal(inj.body.error.script_rule, 1);
    assert.equal((await api("GET", "/v1/usage")).body.used, usedBefore); assert.equal((await api("GET", "/v1/payments?limit=100")).body.data.length, countBefore);
    const again = await pay({ request_id: "inj-1" }); assert.equal(again.status, 201, "same request_id works on retry");
    // latency
    await api("PUT", "/v1/script", { rules: [{ then: { latency_ms: 400 } }] });
    const t0 = Date.now(); const slow = await pay(); assert.equal(slow.status, 201); assert.ok(Date.now() - t0 >= 380, "latency applied");
    await api("PUT", "/v1/script", { rules: [{ when: { probability: 0 }, then: { outcome: "decline" } }, { when: { probability: 1 }, then: { outcome: "nsf" } }] });
    assert.equal((await pay()).body.status.code, "SBX-4051");

    // webhook behaviours
    const waitFor = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const r = fn(); if (r) return r; await sleep(50); } return null; };
    hooks.length = 0;
    await api("PUT", "/v1/script", { rules: [{ then: { outcome: "approve", webhook: { duplicate: 2 } } }] });
    const dp = await pay();
    await waitFor(() => hooks.filter((h) => h.body.data.id === dp.body.id).length >= 3);
    const dups = hooks.filter((h) => h.body.data.id === dp.body.id);
    assert.equal(dups.length, 3); assert.equal(new Set(dups.map((h) => h.body.id)).size, 1, "duplicates share one event id"); assert.ok(dups.every((h) => h.ok));
    hooks.length = 0;
    await api("PUT", "/v1/script", { rules: [{ then: { webhook: { bad_signature: true } } }] });
    const bp = await pay(); await waitFor(() => hooks.some((h) => h.body.data.id === bp.body.id));
    assert.equal(hooks.find((h) => h.body.data.id === bp.body.id).ok, false, "signature is deliberately wrong");
    hooks.length = 0;
    await api("PUT", "/v1/script", { rules: [{ then: { webhook: { drop: true } } }] });
    const dr = await pay(); await sleep(900);
    assert.equal(hooks.filter((h) => h.body.data.id === dr.body.id).length, 0, "dropped webhook never arrives");
    const dl0 = (await api("GET", "/v1/webhook/deliveries")).body.data[0];
    assert.ok(dl0.flags.includes("dropped") && dl0.delivered === false);
    hooks.length = 0;
    await api("PUT", "/v1/script", { rules: [{ then: { webhook: { delay_ms: 700 } } }] });
    const dd = await pay(); await sleep(600);
    assert.equal(hooks.filter((h) => h.body.data.id === dd.body.id).length, 0, "not yet delivered");
    assert.ok(await waitFor(() => hooks.some((h) => h.body.data.id === dd.body.id)), "delivered after the delay");
    await api("DELETE", "/v1/script"); assert.equal((await api("GET", "/v1/script")).body.rules.length, 0);

    // inspector and replay
    const good = await pay(); await waitFor(() => hooks.some((h) => h.body.data.id === good.body.id));
    const list = (await api("GET", "/v1/webhook/deliveries")).body.data;
    const row = list.find((d) => d.event_type === "payment.succeeded" && d.event_id === hooks.find((h) => h.body.data.id === good.body.id).body.id);
    assert.ok(row.id.startsWith("dlv_")); assert.equal(row.event, undefined, "list stays light"); assert.equal(row.delivered, true);
    const one = (await api("GET", `/v1/webhook/deliveries/${row.id}`)).body;
    assert.equal(one.event.data.id, good.body.id); assert.equal(one.attempts[0].status, 200); assert.ok(typeof one.attempts[0].ms === "number");
    assert.equal((await api("GET", "/v1/webhook/deliveries/dlv_000000")).status, 404);
    hooks.length = 0;
    const rp = await api("POST", `/v1/webhook/deliveries/${row.id}/replay`); assert.equal(rp.status, 202);
    const got = await waitFor(() => hooks[0]); assert.equal(got.body.id, one.event.id, "same event id"); assert.equal(got.replay, true); assert.ok(got.ok, "fresh valid signature");
    await sleep(200);
    const afterRp = (await api("GET", "/v1/webhook/deliveries")).body.data;
    assert.equal(afterRp[0].replay_of, row.id); assert.ok(afterRp[0].flags.includes("replay"));
    assert.equal((await api("POST", "/v1/webhook/deliveries/dlv_000000/replay")).status, 404);
    key = other.body.api_key;
    assert.equal((await api("POST", `/v1/webhook/deliveries/${row.id}/replay`)).body.error.code, "pro_required", "free plan cannot replay");

    // trial expiry: a second server with a very short trial
    {
      const P2 = 18084, BASE2 = `http://127.0.0.1:${P2}`;
      const srv2 = spawn("node", ["server.js"], { env: { ...process.env, PORT: P2, DATA_FILE: `/tmp/dryrun-test2-${Date.now()}.json`, TRIAL_DAYS: "0.00003", SIGNUPS_PER_HOUR: "50", MAIL_IP_PER_HOUR: "100", EMAIL_API_KEY: "re_test", EMAIL_FROM: "Z <a@example.test>", EMAIL_API_BASE: `http://127.0.0.1:${MAIL_PORT}`, PUBLIC_URL: "https://example.test" }, stdio: "ignore" });
      try {
        for (let i = 0; i < 50; i++) { try { await fetch(BASE2 + "/health"); break; } catch { await sleep(100); } }
        const call = async (method, path, body, k) => { const r = await fetch(BASE2 + path, { method, headers: { "content-type": "application/json", ...(k ? { authorization: `Bearer ${k}` } : {}) }, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
        const a2 = await call("POST", "/v1/accounts"); const k2 = a2.body.api_key;
        await call("POST", "/v1/account/email", { email: "short@example.test" }, k2); await sleep(200);
        const vv = await call("POST", "/v1/email/verify", { token: lastLink("verify") }); assert.ok(vv.body.trial_ends);
        assert.equal((await call("PUT", "/v1/script", { rules: [{ then: { outcome: "decline" } }] }, k2)).status, 200);
        await sleep(3200);
        const uu = (await call("GET", "/v1/usage", null, k2)).body;
        assert.equal(uu.plan, "free"); assert.equal(uu.plan_source, "free"); assert.equal(uu.script_active, false); assert.equal(uu.limit, 200);
        assert.equal((await call("PUT", "/v1/script", { rules: [{ then: { outcome: "decline" } }] }, k2)).status, 402);
        const np = await call("POST", "/v1/payments", card("4111111111111111"), k2);
        assert.equal(np.body.transaction_state, "success", "a stored script is not applied once the trial has ended");
      } finally { srv2.kill(); }
    }

    console.log("All checks passed");
  } catch (e) { console.error("FAILED:", e.stack.split("\n").slice(0,3).join(" | ")); process.exitCode = 1; }
  finally { srv.kill(); receiver.close(); mockStripe.close(); mockMail.close(); }
})();
