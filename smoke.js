"use strict";
// Run: npm test  (starts the server and a local webhook receiver, then exercises every flow)
const { spawn } = require("child_process"), http = require("http"), crypto = require("crypto"), assert = require("assert");
const PORT = 18080, HOOK = 18081, STRIPE_PORT = 18082, MAIL_PORT = 18083, AI_PORT = 18095, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WH_SECRET = "whsec_test_secret";
const srv = spawn("node", ["server.js"], {
  env: {
    ...process.env, PORT, DATA_FILE: `/tmp/dryrun-test-${Date.now()}.json`, ALLOW_PRIVATE_WEBHOOKS: "1", RETRY_MS: "0,200", SETTLE_DELAY_MS: "300", DISPUTE_REVIEW_DELAY_MS: "300",
    SIGNUPS_PER_HOUR: "50", MAIL_IP_PER_HOUR: "100", EMAIL_API_KEY: "re_test", EMAIL_FROM: "Zanboxx <login@example.test>", EMAIL_API_BASE: `http://127.0.0.1:${MAIL_PORT}`,
    STRIPE_SECRET_KEY: "sk_test_mock", STRIPE_PRICE_ID: "price_test_1", STRIPE_WEBHOOK_SECRET: WH_SECRET, ANTHROPIC_API_KEY: "sk-ant-mock", ANTHROPIC_API_BASE: `http://127.0.0.1:${AI_PORT}`, TUTOR_MODEL: "mock-model",
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

const aiCalls = [];
const mockAI = http.createServer((req, res) => {
  let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => {
    const body = JSON.parse(d || "{}"); aiCalls.push({ url: req.url, key: req.headers["x-api-key"], ver: req.headers["anthropic-version"], body });
    const last = body.messages[body.messages.length - 1].content;
    res.setHeader("content-type", "application/json");
    if (/UPSTREAM-FAIL/.test(last)) { res.statusCode = 529; return res.end(JSON.stringify({ error: { type: "overloaded_error" } })); }
    const text = /LEAK/.test(last) ? "Here you go: 4242 4242 4242 4242" : "Mock answer about " + (last.slice(0, 20));
    res.end(JSON.stringify({ content: [{ type: "text", text }] }));
  });
}).listen(AI_PORT);

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
    for (const [u, type] of [["/favicon.svg", "image/svg+xml"], ["/favicon.png", "image/png"], ["/favicon.ico", "image/png"], ["/apple-touch-icon.png", "image/png"]]) {
      const ic = await fetch(BASE + u); assert.equal(ic.status, 200, u); assert.equal(ic.headers.get("content-type"), type, u); assert.ok((await ic.arrayBuffer()).byteLength > 300, u);
    }
    assert.ok((await (await fetch(BASE + "/terms")).text()).includes('rel="icon"'), "legal pages link the icon");
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
      assert.deepEqual(r.body.authentication, { protocol: "3ds2", trans_status: ts, eci, liability_shift: shift, scheme: "visa" }, num);
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
    assert.deepEqual(ch.body.authentication, { protocol: "3ds2", trans_status: "C", eci: null, liability_shift: null, scheme: "visa" });
    const wait = (await getLog(ch.body.id)).body;
    assert.equal(wait.complete, false); assert.equal(wait.awaiting, "cardholder"); assert.equal(wait.result, null);
    assert.equal(wait.steps[wait.steps.length - 1].name, "CRes"); assert.equal(wait.steps[wait.steps.length - 1].payload.challengeCompletionInd, "N");
    const done = await api("POST", `/v1/payments/${ch.body.id}/3ds`, { result: "approve" });
    assert.equal(done.body.transaction_state, "success");
    assert.deepEqual(done.body.authentication, { protocol: "3ds2", trans_status: "Y", eci: "05", liability_shift: true, scheme: "visa" });
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
    assert.deepEqual(failed.body.authentication, { protocol: "3ds2", trans_status: "N", eci: "07", liability_shift: false, scheme: "visa" });
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

    // ---- card schemes: Visa, Mastercard, American Express ----
    const sch = await (await fetch(BASE + "/v1/schemes")).json();
    assert.deepEqual(sch.schemes.map((x) => x.id), ["visa", "mastercard", "amex"]);
    for (const x of sch.schemes) { assert.ok(x.test_cards.length >= 11, x.id); assert.ok(x.chargeback_reasons.length >= 3, x.id); }
    assert.deepEqual(sch.schemes.find((x) => x.id === "amex").number_lengths, [15]);
    const want = { visa: ["4111111111111111", "4000000000000002", "4000000000009995", "4000000000000069", "05", "51", "54"],
      mastercard: ["5555555555554444", "5200000000000007", "5200000000099959", "5200000000000692", "05", "51", "54"],
      amex: ["378282246310005", "370000000000002", "370000000099954", "370000000000697", "100", "116", "101"] };
    for (const [id, [ok, dec, nsf, exp, cDec, cNsf, cExp]] of Object.entries(want)) {
      const a1 = await api("POST", "/v1/payments", card(ok)); assert.equal(a1.status, 201, id); assert.equal(a1.body.transaction_state, "success", id); assert.equal(a1.body.scheme, id);
      const rfd = await api("POST", "/v1/payments", { request_id: "rf-" + id, method: "card", transaction_type: "refund", amount: 1, parent_transaction_id: a1.body.id });
      assert.equal(rfd.body.scheme, id, "follow-up keeps the scheme");
      for (const [num, code, sbx] of [[dec, cDec, "SBX-4002"], [nsf, cNsf, "SBX-4051"], [exp, cExp, "SBX-4054"]]) {
        const d = await api("POST", "/v1/payments", card(num));
        assert.equal(d.body.transaction_state, "failed", num); assert.equal(d.body.status.code, sbx, num);
        assert.equal(d.body.scheme_response.code, code, num); assert.equal(d.body.scheme_response.scheme, id); assert.ok(d.body.scheme_response.retry_advice);
      }
    }
    // format rules
    const bad400 = async (n, extra) => { const r = await api("POST", "/v1/payments", card(n, extra)); assert.equal(r.status, 400, n + JSON.stringify(extra || {})); return r.body.error.message; };
    assert.ok((await bad400("3782822463100050")).includes("American Express")); // 16 digits
    assert.ok((await bad400("37828224631000")).includes("American Express")); // 14 digits
    assert.ok((await bad400("5555555555")).includes("13 to 19"));
    assert.ok((await bad400("378282246310005", { card_cvv: "123" })).includes("4-digit CID"));
    assert.ok((await bad400("4111111111111111", { card_cvv: "1234" })).includes("3-digit CVV2"));
    assert.equal((await api("POST", "/v1/payments", card("378282246310005", { card_cvv: "1234" }))).status, 201);
    assert.equal((await api("POST", "/v1/payments", card("5555555555554444", { card_cvv: "123" }))).status, 201);
    const luhnBad = await api("POST", "/v1/payments", card("4000000000000001"));
    assert.equal(luhnBad.body.status.code, "SBX-4014"); assert.equal(luhnBad.body.scheme_response.code, "14");
    const unknown = await api("POST", "/v1/payments", card("6011111111111117"));
    assert.equal(unknown.body.transaction_state, "failed"); assert.equal(unknown.body.scheme, undefined);
    // 3-D Secure: branding and ECI follow the scheme
    const tdsOf = async (n) => { const r = await api("POST", "/v1/payments", card(n)); return { r, log: (await getLog(r.body.id)).body }; };
    const mY = await tdsOf("5200000000030004"); assert.equal(mY.r.body.authentication.eci, "02"); assert.equal(mY.r.body.authentication.scheme, "mastercard");
    assert.equal(mY.log.result.scheme_programme, "Mastercard Identity Check"); assert.equal(mY.log.result.authentication_value_name, "AAV (UCAF)");
    assert.equal((await tdsOf("5200000000032539")).r.body.authentication.eci, "01");
    assert.equal((await tdsOf("5200000000032380")).r.body.authentication.eci, "00");
    const aY = await tdsOf("370000000030009"); assert.equal(aY.r.body.authentication.eci, "05"); assert.equal(aY.log.result.scheme_programme, "American Express SafeKey");
    assert.equal((await tdsOf("370000000032534")).r.body.authentication.eci, "06");
    const aC = await api("POST", "/v1/payments", card("370000000032203")); assert.equal(aC.status, 202);
    assert.equal((await api("POST", `/v1/payments/${aC.body.id}/3ds`, { result: "approve" })).body.authentication.eci, "05");
    const mC = await api("POST", "/v1/payments", card("5200000000032208"));
    const mCd = await api("POST", `/v1/payments/${mC.body.id}/3ds`, { result: "approve" }); assert.equal(mCd.body.authentication.eci, "02");
    const aN = await tdsOf("370000000032385"); assert.equal(aN.r.body.transaction_state, "failed"); assert.equal(aN.r.body.scheme_response.code, "100");
    // 3DS-lab style call: scenario forced with a card of that scheme still carries the scheme through
    const forced = await api("POST", "/v1/payments", { request_id: "forced-mc", method: "card", transaction_type: "purchase", amount: 5, currency: "EUR", scenario: "3ds", card_number: "5200000000099959" });
    assert.equal(forced.status, 202); assert.equal(forced.body.scheme, "mastercard");

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
    // rules can target one card scheme
    assert.equal((await api("PUT", "/v1/script", { rules: [{ name: "amex down", when: { scheme: "amex" }, then: { outcome: "decline" } }] })).status, 200);
    assert.equal((await pay()).body.transaction_state, "success", "visa unaffected");
    const am = await api("POST", "/v1/payments", card("378282246310005")); assert.equal(am.body.transaction_state, "failed"); assert.equal(am.body.script_rule, 1); assert.equal(am.body.scheme_response.code, "100");
    assert.equal((await api("PUT", "/v1/script", { rules: [{ when: { scheme: "discover" }, then: { outcome: "decline" } }] })).status, 400);

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

    // ---- storage: SQLite, graceful shutdown, migration from the old JSON file, backups, restore ----
    {
      const fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib");
      // The mock S3 runs in this process, so command-line tools must run asynchronously or they would wait on a blocked event loop.
      const spawnSync = (cmd, args, o = {}) => new Promise((resolve) => {
        const c = spawn(cmd, args, { env: o.env }); let stdout = "", stderr = ""; c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d));
        const t = setTimeout(() => c.kill("SIGKILL"), o.timeout || 30000); c.on("exit", (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
      });
      const B = require("./backup"), { validateDbFile } = require("./store");
      // AWS's published SigV4 example: the signature must match exactly
      const vec = B.signV4({ method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), headers: { range: "bytes=0-9" }, payloadHash: crypto.createHash("sha256").update("").digest("hex"), region: "us-east-1", accessKey: "AKIAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", date: new Date("2013-05-24T00:00:00Z") });
      assert.ok(vec.authorization.endsWith("Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"), "SigV4 matches the AWS example");
      const enc = B.encrypt(Buffer.from("hello"), "pw");
      assert.equal(B.decrypt(enc, "pw").toString(), "hello");
      assert.throws(() => B.decrypt(enc, "wrong"), /wrong passphrase/);

      // a mock S3 that checks every signature
      const S3 = { objects: new Map(), fail: false, badSig: 0 }, S3_PORT = 18086, KEYID = "AKIATEST", SECRET = "s3secretvalue";
      const mockS3 = http.createServer((req, res) => {
        const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
          const body = Buffer.concat(chunks), url = new URL(`http://${req.headers.host}${req.url}`);
          const amz = req.headers["x-amz-date"], date = new Date(amz.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z"));
          const want = B.signV4({ method: req.method, url, payloadHash: req.headers["x-amz-content-sha256"], region: "auto", accessKey: KEYID, secretKey: SECRET, date }).authorization;
          if (want !== req.headers.authorization || crypto.createHash("sha256").update(body).digest("hex") !== req.headers["x-amz-content-sha256"]) { S3.badSig++; res.writeHead(403); return res.end("SignatureDoesNotMatch"); }
          if (S3.fail) { res.writeHead(500); return res.end("boom"); }
          const p = decodeURIComponent(url.pathname).replace(/^\/bkt\/?/, "");
          if (req.method === "PUT") { S3.objects.set(p, body); res.writeHead(200); return res.end(); }
          if (req.method === "GET" && !p) {
            res.writeHead(200); return res.end("<ListBucketResult>" + [...S3.objects].map(([k, v]) => `<Contents><Key>${k}</Key><LastModified>2026-11-01T10:00:00.000Z</LastModified><Size>${v.length}</Size></Contents>`).join("") + "</ListBucketResult>");
          }
          if (req.method === "GET" && S3.objects.has(p)) { res.writeHead(200); return res.end(S3.objects.get(p)); }
          res.writeHead(404); res.end("NoSuchKey");
        });
      }).listen(S3_PORT); global.__mockS3 = mockS3;

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zbx-")), PORT3 = 18085, B3 = `http://127.0.0.1:${PORT3}`;
      const env3 = { PORT: PORT3, DATA_FILE: path.join(dir, "data.json"), DB_FILE: path.join(dir, "z.db"), ADMIN_TOKEN: "admintoken123", BACKUP_EVERY_HOURS: "0", BACKUP_KEEP: "2",
        BACKUP_PASSPHRASE: "correct horse", AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${S3_PORT}`, BUCKET_NAME: "bkt", AWS_ACCESS_KEY_ID: KEYID, AWS_SECRET_ACCESS_KEY: SECRET, AWS_REGION: "auto", SIGNUPS_PER_HOUR: "50" };
      const start = async () => { const p = spawn("node", ["server.js"], { env: { ...process.env, ...env3 }, stdio: "ignore" }); for (let i = 0; i < 80; i++) { try { await fetch(B3 + "/health"); return p; } catch { await sleep(100); } } throw new Error("server did not start"); };
      const stop = (p) => new Promise((r) => { p.once("exit", (code) => r(code)); p.kill("SIGTERM"); });
      const call = async (method, p, body, k, extra = {}) => { const r = await fetch(B3 + p, { method, headers: { "content-type": "application/json", ...(k ? { authorization: `Bearer ${k}` } : {}), ...extra }, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

      // 1. migration from the old JSON file
      const legacyKey = "sk_test_" + "ab".repeat(24);
      fs.writeFileSync(env3.DATA_FILE, JSON.stringify({ accounts: { acct_old: { id: "acct_old", plan: "free", created_at: "2026-01-01T00:00:00Z", usage: { month: "", count: 0 }, payments: [], deliveries: [], webhook: null } }, keys: { [crypto.createHash("sha256").update(legacyKey).digest("hex")]: "acct_old" } }));
      let p3 = await start();
      assert.equal((await call("GET", "/v1/usage", null, legacyKey)).status, 200, "old account still works after migration");
      assert.ok(!fs.existsSync(env3.DATA_FILE) && fs.existsSync(env3.DATA_FILE + ".migrated"), "old JSON file kept under a new name");

      // 2. an immediate shutdown still saves the last request
      const na = await call("POST", "/v1/accounts"); const nk = na.body.api_key;
      const made = await call("POST", "/v1/payments", card("4111111111111111"), nk); assert.equal(made.status, 201);
      assert.equal(await stop(p3), 0, "clean exit on SIGTERM");
      p3 = await start();
      const list3 = await call("GET", "/v1/payments", null, nk);
      assert.equal(list3.body.data.length, 1, "payment survived a restart"); assert.equal(list3.body.data[0].id, made.body.id);
      assert.equal((await call("GET", "/v1/usage", null, legacyKey)).status, 200);

      // 3. admin endpoint is locked
      assert.equal((await call("GET", "/admin/status")).status, 401);
      assert.equal((await call("GET", "/admin/status", null, "nope")).status, 401);
      const st = await call("GET", "/admin/status", null, env3.ADMIN_TOKEN);
      assert.equal(st.status, 200); assert.equal(st.body.accounts, 2); assert.equal(st.body.backups.offsite, true); assert.equal(st.body.backups.encrypted, true);

      // 4. manual backup: local snapshot, encrypted off-site copy, retention
      const bk = await call("POST", "/admin/backup", null, env3.ADMIN_TOKEN);
      assert.equal(bk.status, 200); assert.equal(bk.body.ok, true);
      assert.equal(validateDbFile(bk.body.file).accounts, 2, "local snapshot is a valid database");
      assert.equal(S3.badSig, 0, "every upload was correctly signed");
      const [offKey, offBody] = [...S3.objects][0];
      assert.ok(/^zanboxx\/slot-\d\d\.db\.gz\.enc$/.test(offKey), offKey); assert.ok(offBody.subarray(0, 4).equals(Buffer.from("ZBX1")), "off-site copy is encrypted");
      assert.ok(!offBody.includes("SQLite format"), "no plain database inside");
      for (let i = 0; i < 3; i++) await call("POST", "/admin/backup", null, env3.ADMIN_TOKEN);
      assert.equal(fs.readdirSync(path.join(dir, "backups")).filter((f) => f.endsWith(".db")).length, 2, "only the newest 2 local snapshots are kept");
      // an off-site outage does not stop the local backup, and is reported
      S3.fail = true;
      const bad2 = await call("POST", "/admin/backup", null, env3.ADMIN_TOKEN);
      assert.equal(bad2.status, 200); assert.equal(bad2.body.ok, false); assert.ok(bad2.body.warning.includes("off-site")); assert.ok(fs.existsSync(bad2.body.file));
      assert.ok((await call("GET", "/admin/status", null, env3.ADMIN_TOKEN)).body.backups.last_error.includes("off-site"));
      S3.fail = false;
      assert.equal((await call("POST", "/admin/backup", null, env3.ADMIN_TOKEN)).body.ok, true);
      assert.equal((await call("GET", "/admin/status", null, env3.ADMIN_TOKEN)).body.backups.last_error, null, "error clears after a good backup");

      // 5. disaster and restore from the off-site copy
      assert.equal((await call("DELETE", "/v1/account", { confirm: true }, nk)).status, 200);
      assert.equal((await call("GET", "/v1/usage", null, nk)).status, 401);
      const cliEnv = { ...process.env, ...env3 };
      const lst = await spawnSync("node", ["backup.js", "list"], { env: cliEnv });
      assert.ok(lst.stdout.includes("zanboxx/slot-"), "list shows the off-site copy");
      const wrong = await spawnSync("node", ["backup.js", "restore", offKey], { env: { ...cliEnv, BACKUP_PASSPHRASE: "wrong" } });
      assert.notEqual(wrong.status, 0); assert.ok(wrong.stderr.includes("wrong passphrase")); assert.ok(!fs.existsSync(path.join(dir, "restore.db")), "nothing staged on failure");
      const good = await spawnSync("node", ["backup.js", "restore", offKey], { env: cliEnv });
      assert.equal(good.status, 0, good.stderr + good.stdout); assert.ok(fs.existsSync(path.join(dir, "restore.db")));
      await stop(p3); p3 = await start();
      assert.ok(!fs.existsSync(path.join(dir, "restore.db")), "restore file consumed");
      assert.ok(fs.readdirSync(dir).some((f) => f.includes(".before-restore-")), "previous database kept aside");
      assert.equal((await call("GET", "/v1/usage", null, nk)).status, 200, "deleted account is back after restore");
      assert.equal((await call("GET", "/v1/payments", null, nk)).body.data.length, 1);
      assert.equal((await call("GET", "/v1/usage", null, legacyKey)).status, 200);
      const keptFile = path.join(dir, "backups", fs.readdirSync(path.join(dir, "backups")).filter((f) => f.endsWith(".db")).sort().pop());
      assert.equal((await spawnSync("node", ["backup.js", "verify", keptFile], { env: cliEnv })).status, 0);
      await stop(p3);

      // 6. a damaged database file is refused, not silently replaced
      fs.writeFileSync(env3.DB_FILE, "this is not a database, it is long enough to look like one ".repeat(200));
      for (const e of ["-wal", "-shm"]) try { fs.unlinkSync(env3.DB_FILE + e); } catch {}
      const dead = await spawnSync("node", ["server.js"], { env: { ...process.env, ...env3 }, timeout: 10000 });
      assert.notEqual(dead.status, 0, "server refuses to start on a damaged database");
      mockS3.close(); fs.rmSync(dir, { recursive: true, force: true });
    }

    // ---- disputes (chargebacks) ----
    {
      const da = await api("POST", "/v1/accounts"); key = da.body.api_key;
      await api("POST", "/v1/account/email", { email: "disputes@example.test" }); await sleep(150); assert.ok((await api("POST", "/v1/email/verify", { token: lastLink("verify") })).body.trial_ends); // trial = Pro rate limit
      const wd = await api("PUT", "/v1/webhook", { url: `http://127.0.0.1:${HOOK}/hook` }); secret = wd.body.secret; hooks.length = 0;
      const waitD = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const r = await fn(); if (r) return r; await sleep(60); } return null; };
      const evOf = (type, id) => hooks.find((h) => h.body.type === type && h.body.data.id === id);
      const ok = async (n, extra) => (await api("POST", "/v1/payments", card(n, { amount: 100, ...extra }))).body;
      const dispute = (txid, body) => api("POST", `/v1/payments/${txid}/dispute`, body || {});
      const state = async (id) => (await api("GET", `/v1/disputes/${id}`)).body;

      // creation: scheme reason codes, money held back, refund guard
      const v = await ok("4111111111111111");
      const d1 = await dispute(v.id, { reason_code: "13.1", amount: 60 }); assert.equal(d1.status, 201, JSON.stringify(d1.body));
      assert.equal(d1.body.state, "needs_response"); assert.equal(d1.body.scheme, "visa"); assert.equal(d1.body.reason.code, "13.1"); assert.equal(d1.body.reason.category, "not_received");
      assert.deepEqual(d1.body.evidence_requirements.required, ["tracking_number", "proof_of_delivery"]); assert.ok(Date.parse(d1.body.due_by) > Date.now() + 6 * 864e5);
      assert.equal(d1.body.history[0].event, "created"); assert.equal(d1.body.review_at, undefined);
      const pv = (await api("GET", `/v1/payments/${v.id}`)).body; assert.equal(pv.dispute_id, d1.body.id); assert.equal(pv.disputed_amount, 60); assert.equal(pv.dispute_state, "needs_response");
      assert.equal((await dispute(v.id)).status, 409, "one dispute per payment");
      const rf = (amt) => api("POST", "/v1/payments", { request_id: "dr" + Math.random(), method: "card", transaction_type: "refund", amount: amt, parent_transaction_id: v.id });
      assert.equal((await rf(50)).status, 422, "only 40 is refundable while 60 is held back");
      assert.equal((await rf(40)).status, 201);
      assert.equal((await api("POST", "/v1/payments", { request_id: "dv1", method: "card", transaction_type: "void", parent_transaction_id: v.id })).status, 422);
      await waitD(() => evOf("dispute.created", d1.body.id)); assert.ok(evOf("dispute.created", d1.body.id).ok, "signed dispute.created webhook");
      // validation
      for (const [body, why] of [[{ reason_code: "4837" }, "wrong scheme code"], [{ reason: "boring" }, "unknown category"], [{ amount: 0 }, "zero"], [{ outcome: "maybe" }, "outcome"], [{ response_window_seconds: 0 }, "window"], [{ response_window_seconds: 9e9 }, "window max"]]) {
        const t = await ok("4111111111111111"); const r = await dispute(t.id, body); assert.equal(r.status, 400, why);
      }
      const big = await ok("4111111111111111"); assert.equal((await dispute(big.id, { amount: 100.01 })).status, 422);
      const failed = await ok("4000000000000002"); assert.equal((await dispute(failed.id)).status, 422, "failed payments cannot be disputed");
      const auth = await ok("4111111111111111", { transaction_type: "authorization" }); assert.equal((await dispute(auth.id)).status, 422, "authorizations cannot be disputed");
      const pp = (await api("POST", "/v1/payments", { request_id: "ppd", method: "paypal", transaction_type: "debit", amount: 5, currency: "EUR" })).body; assert.equal((await dispute(pp.id)).status, 422);
      assert.equal((await dispute("tx_ffffffff")).status, 404);
      // evidence: validation, then a win with complete evidence
      const e1 = (b) => api("POST", `/v1/disputes/${d1.body.id}/evidence`, b);
      assert.equal((await e1({ colour: "red" })).status, 400); assert.equal((await e1({})).status, 400); assert.equal((await e1({ tracking_number: "x".repeat(2001) })).status, 400);
      const sub = await e1({ tracking_number: "1Z999AA10123456784", proof_of_delivery: "Signed by J. Doe, 4 Nov" });
      assert.equal(sub.status, 200); assert.equal(sub.body.state, "under_review"); assert.equal(sub.body.evidence.tracking_number, "1Z999AA10123456784");
      assert.equal((await e1({ tracking_number: "again" })).status, 409, "evidence only once"); assert.equal((await api("POST", `/v1/disputes/${d1.body.id}/accept`)).status, 409);
      await waitD(async () => (await state(d1.body.id)).state === "won");
      const w = await state(d1.body.id); assert.equal(w.resolution.cause, "evidence_accepted"); assert.equal(w.history.map((h) => h.event).join(), "created,evidence_submitted,won");
      assert.equal((await api("GET", `/v1/payments/${v.id}`)).body.disputed_amount, 0, "won: money returned");
      await waitD(() => evOf("dispute.updated", d1.body.id) && evOf("dispute.won", d1.body.id));
      assert.equal(evOf("dispute.won", d1.body.id).body.data.state, "won");
      // weak evidence loses and says why
      const m = await ok("5555555555554444"); const d2 = (await dispute(m.id, { reason: "fraud" })).body; assert.equal(d2.reason.code, "4837"); assert.equal(d2.scheme, "mastercard");
      await api("POST", `/v1/disputes/${d2.id}/evidence`, { customer_ip: "203.0.113.9" });
      await waitD(async () => (await state(d2.id)).state === "lost"); const l2 = await state(d2.id); assert.equal(l2.resolution.cause, "evidence_insufficient"); assert.ok(l2.resolution.note.includes("customer_email"));
      assert.equal((await api("GET", `/v1/payments/${m.id}`)).body.disputed_amount, 100, "lost: money stays withdrawn");
      await waitD(() => evOf("dispute.lost", d2.id));
      // accept
      const a = await ok("378282246310005"); const d3 = (await dispute(a.id, { reason_code: "P08" })).body; assert.equal(d3.reason.category, "duplicate");
      const acc3 = await api("POST", `/v1/disputes/${d3.id}/accept`); assert.equal(acc3.status, 200); assert.equal(acc3.body.state, "lost"); assert.equal(acc3.body.resolution.cause, "accepted");
      assert.equal((await api("POST", `/v1/disputes/${d3.id}/accept`)).status, 409);
      await waitD(() => evOf("dispute.lost", d3.id));
      // deadline passes
      const dl = await ok("4111111111111111"); const d4 = (await dispute(dl.id, { response_window_seconds: 1 })).body;
      await sleep(1300); const l4 = await state(d4.id); assert.equal(l4.state, "lost"); assert.equal(l4.resolution.cause, "no_response");
      assert.equal((await api("POST", `/v1/disputes/${d4.id}/evidence`, { customer_ip: "1.1.1.1" })).status, 409, "too late");
      // forced outcomes
      const f1 = await ok("4111111111111111"); const d5 = (await dispute(f1.id, { outcome: "win" })).body;
      await api("POST", `/v1/disputes/${d5.id}/evidence`, { customer_ip: "x" });
      await waitD(async () => (await state(d5.id)).state === "won"); assert.equal((await state(d5.id)).resolution.cause, "simulated_win");
      const f2 = await ok("4111111111111111"); const d6 = (await dispute(f2.id, { outcome: "lose" })).body;
      await api("POST", `/v1/disputes/${d6.id}/evidence`, { customer_ip: "1.1.1.1", customer_email: "a@b.test" });
      await waitD(async () => (await state(d6.id)).state === "lost"); assert.equal((await state(d6.id)).resolution.cause, "simulated_loss");
      // 3-D Secure liability shift: a fraud dispute on an authenticated payment is reversed without evidence
      const sh = await ok("4000000000003000"); const d7 = (await dispute(sh.id, { reason: "fraud" })).body;
      assert.equal(d7.liability_shifted, true); assert.equal(d7.state, "under_review");
      assert.equal((await api("POST", `/v1/disputes/${d7.id}/evidence`, { customer_ip: "1.1.1.1" })).status, 409);
      await waitD(async () => (await state(d7.id)).state === "won"); assert.equal((await state(d7.id)).resolution.cause, "liability_shift");
      const ns = await ok("4000000000003261"); assert.equal((await dispute(ns.id, { reason: "fraud" })).body.liability_shifted, false, "no shift when 3DS was unavailable");
      const sn = await ok("4000000000003000"); assert.equal((await dispute(sn.id, { reason: "not_received" })).body.liability_shifted, false, "3DS only covers fraud");
      // lists and housekeeping
      const all = (await api("GET", "/v1/disputes")).body.data; assert.ok(all.length >= 9);
      assert.ok((await api("GET", "/v1/disputes?state=won")).body.data.every((x) => x.state === "won"));
      assert.equal((await api("GET", "/v1/disputes/dp_ffffffff")).status, 404);
      assert.equal((await api("POST", "/v1/disputes/dp_ffffffff/evidence", { customer_ip: "1" })).status, 404);
      const cats = await (await fetch(BASE + "/v1/schemes")).json(); assert.deepEqual(Object.keys(cats.dispute_categories), ["fraud", "not_received", "not_as_described", "duplicate"]);
      assert.equal((await api("DELETE", "/v1/payments")).status, 200); assert.equal((await api("GET", "/v1/disputes")).body.data.length, 0);
    }

    // ---- merchant-initiated transactions (MIT) and card-on-file agreements ----
    {
      hooks.length = 0;
      const rid = () => "mit_" + Math.random().toString(36).slice(2);
      const setup = (n, store, extra) => api("POST", "/v1/payments", card(n, { store_credential: store, ...extra }));
      const mitPay = (agr, extra) => api("POST", "/v1/payments", { request_id: rid(), method: "card", transaction_type: "purchase", amount: 9.99, currency: "EUR", initiator: "merchant", agreement_id: agr, ...extra });
      const getAgr = async (id) => (await api("GET", `/v1/agreements/${id}`)).body;
      const waitM = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const r = fn(); if (r) return r; await sleep(50); } return null; };

      // first payment stores the card
      const s1 = await setup("4111111111111111", { type: "recurring" }); assert.equal(s1.status, 201, JSON.stringify(s1.body));
      assert.equal(s1.body.initiator, "customer"); assert.ok(s1.body.agreement_id.startsWith("agr_")); assert.match(s1.body.network_transaction_id, /^\d{15}$/);
      const ag = await getAgr(s1.body.agreement_id);
      assert.equal(ag.state, "active"); assert.equal(ag.type, "recurring"); assert.equal(ag.scheme, "visa"); assert.equal(ag.card_last4, "1111"); assert.equal(ag.initial_payment_id, s1.body.id);
      assert.equal(ag.network_transaction_id, s1.body.network_transaction_id); assert.equal(ag.sca.performed, false); assert.equal(ag.instalments, null); assert.equal(ag.charges, 0);
      assert.ok(JSON.stringify(ag).indexOf("4111111111111111") < 0, "the card number is never stored on the agreement");
      await waitM(() => hooks.find((h) => h.body.type === "agreement.created" && h.body.data.id === ag.id)); assert.ok(hooks.find((h) => h.body.type === "agreement.created" && h.body.data.id === ag.id).ok);
      // charge it later without the customer
      const m1 = await mitPay(ag.id); assert.equal(m1.status, 201, JSON.stringify(m1.body));
      assert.equal(m1.body.transaction_state, "success"); assert.equal(m1.body.initiator, "merchant"); assert.equal(m1.body.mit_type, "recurring"); assert.equal(m1.body.scheme, "visa"); assert.equal(m1.body.card_last4, "1111");
      assert.equal(m1.body.original_network_transaction_id, ag.network_transaction_id); assert.match(m1.body.network_transaction_id, /^\d{15}$/); assert.notEqual(m1.body.network_transaction_id, ag.network_transaction_id);
      assert.equal(m1.body.warnings.length, 1, "EUR without 3DS on the first payment warns"); assert.equal(m1.body.authentication, undefined, "no 3-D Secure for MIT");
      assert.equal((await mitPay(ag.id, { currency: "USD" })).body.warnings, undefined);
      const ag2 = await getAgr(ag.id); assert.equal(ag2.charges, 2); assert.equal(ag2.last_result.state, "success");
      // validation
      for (const [extra, why] of [[{ card_number: "4111111111111111" }, "card number"], [{ card_cvv: "123" }, "cvv"], [{ agreement_id: undefined }, "no agreement"], [{ mit_type: "instalment" }, "wrong type"],
        [{ scenario: "3ds" }, "3ds"], [{ initiator: "bank" }, "initiator"], [{ method: "paypal", transaction_type: "debit" }, "paypal"], [{ transaction_type: "refund", parent_transaction_id: s1.body.id }, "refund"],
        [{ store_credential: { type: "recurring" } }, "store on MIT"]]) {
        const r = await mitPay(ag.id, extra); assert.equal(r.status, 400, why + " " + JSON.stringify(r.body));
      }
      assert.equal((await mitPay("agr_ffffffff")).status, 404);
      for (const [st, why] of [[{ type: "weekly" }, "type"], [{ type: "instalment" }, "no count"], [{ type: "instalment", instalments: 1 }, "count 1"], [{ type: "recurring", instalments: 3 }, "count on recurring"], ["recurring", "not an object"]]) {
        assert.equal((await setup("4111111111111111", st)).status, 400, why);
      }
      assert.equal((await api("POST", "/v1/payments", { request_id: rid(), method: "paypal", transaction_type: "debit", amount: 1, currency: "EUR", store_credential: { type: "recurring" } })).status, 400);
      // declines carry the scheme's retry advice
      const advice = async (n, outcome) => { const st = await setup(n, { type: "unscheduled" }); const r = await mitPay(st.body.agreement_id, { scenario: outcome }); assert.equal(r.body.transaction_state, "failed", n + outcome); return { r: r.body, a: await getAgr(st.body.agreement_id) }; };
      for (const [n, id, want] of [["4111111111111111", "visa", { decline: ["do_not_retry", "Category 1"], nsf: ["retry_later", "Category 2"], expired: ["update_credentials", "Category 3"] }],
        ["5555555555554444", "mastercard", { decline: ["do_not_retry", "MAC 03"], nsf: ["retry_later", "MAC 02"], expired: ["update_credentials", "MAC 01"] }],
        ["378282246310005", "amex", { decline: ["do_not_retry", "Do not retry"], nsf: ["retry_later", "Retry later"], expired: ["update_credentials", "New details needed"] }]]) {
        for (const [outcome, [action, code]] of Object.entries(want)) {
          const { r, a } = await advice(n, outcome); assert.equal(r.scheme, id); assert.equal(r.scheme_response.merchant_advice.action, action, id + outcome); assert.equal(r.scheme_response.merchant_advice.code, code, id + outcome);
          assert.equal(a.last_result.state, "failed"); assert.equal(a.last_result.scheme_response.merchant_advice.action, action); assert.equal(a.state, "active"); assert.equal(a.charges, 0);
        }
      }
      const cust = await api("POST", "/v1/payments", card("4000000000000002")); assert.equal(cust.body.scheme_response.merchant_advice, undefined, "advice is for MIT only");
      // a failed first payment stores nothing
      const before = (await api("GET", "/v1/agreements?limit=100")).body.data.length;
      const bad1 = await setup("4000000000000002", { type: "recurring" }); assert.equal(bad1.body.transaction_state, "failed"); assert.equal(bad1.body.agreement_id, undefined);
      assert.equal((await api("GET", "/v1/agreements?limit=100")).body.data.length, before);
      // 3-D Secure on the first payment: frictionless and challenge
      const s3 = await setup("4000000000003000", { type: "recurring" }); const a3 = await getAgr(s3.body.agreement_id);
      assert.equal(a3.sca.performed, true); assert.equal(a3.sca.eci, "05"); assert.equal((await mitPay(a3.id)).body.warnings, undefined, "authenticated first payment: no warning");
      const ch = await setup("4000000000003220", { type: "recurring" }); assert.equal(ch.status, 202); assert.equal(ch.body.agreement_id, undefined);
      assert.equal((await api("GET", "/v1/agreements?limit=100")).body.data.length, before + 1, "no agreement until the challenge succeeds");
      const chd = await api("POST", `/v1/payments/${ch.body.id}/3ds`, { result: "approve" }); assert.ok(chd.body.agreement_id); assert.equal((await getAgr(chd.body.agreement_id)).sca.performed, true);
      const chf = await setup("4000000000003220", { type: "recurring" }); await api("POST", `/v1/payments/${chf.body.id}/3ds`, { result: "fail" });
      assert.equal((await api("GET", "/v1/agreements?limit=100")).body.data.length, before + 2, "a failed challenge stores nothing");
      // instalments: the first payment is number 1
      const si = await setup("5555555555554444", { type: "instalment", instalments: 3 }); const ai = await getAgr(si.body.agreement_id);
      assert.deepEqual(ai.instalments, { total: 3, used: 1 }); assert.equal((await mitPay(ai.id, { mit_type: "unscheduled" })).status, 400);
      assert.equal((await mitPay(ai.id)).body.transaction_state, "success"); assert.deepEqual((await getAgr(ai.id)).instalments, { total: 3, used: 2 });
      assert.equal((await mitPay(ai.id, { scenario: "decline" })).body.transaction_state, "failed"); assert.equal((await getAgr(ai.id)).instalments.used, 2, "a failed charge does not use an instalment");
      assert.equal((await mitPay(ai.id)).body.transaction_state, "success");
      const done = await getAgr(ai.id); assert.equal(done.state, "completed"); assert.equal(done.charges, 2);
      assert.equal((await mitPay(ai.id)).status, 422); await waitM(() => hooks.find((h) => h.body.type === "agreement.completed" && h.body.data.id === ai.id));
      // cancelling
      const cx = await api("POST", `/v1/agreements/${ag.id}/cancel`); assert.equal(cx.status, 200); assert.equal(cx.body.state, "cancelled"); assert.ok(cx.body.cancelled_at);
      const afterCancel = await mitPay(ag.id); assert.equal(afterCancel.status, 422); assert.equal(afterCancel.body.error.code, "SBX-4240");
      assert.equal((await api("POST", `/v1/agreements/${ag.id}/cancel`)).status, 409); assert.equal((await api("POST", "/v1/agreements/agr_ffffffff/cancel")).status, 404);
      await waitM(() => hooks.find((h) => h.body.type === "agreement.cancelled" && h.body.data.id === ag.id));
      assert.ok((await api("GET", "/v1/agreements?state=cancelled")).body.data.every((x) => x.state === "cancelled"));
      // the failure script can target merchant-initiated payments
      assert.equal((await api("PUT", "/v1/script", { rules: [{ when: { initiator: "merchant" }, then: { outcome: "nsf" } }] })).status, 200);
      const live = await setup("4111111111111111", { type: "recurring" }); assert.equal(live.body.transaction_state, "success", "customer payments unaffected");
      const sm = await mitPay(live.body.agreement_id); assert.equal(sm.body.status.code, "SBX-4051"); assert.equal(sm.body.script_rule, 1);
      assert.equal((await api("PUT", "/v1/script", { rules: [{ when: { initiator: "robot" }, then: { outcome: "nsf" } }] })).status, 400);
      await api("DELETE", "/v1/script");
      // a MIT payment can be disputed, and the scheme comes along
      const mp = await mitPay(live.body.agreement_id); const dsp = await api("POST", `/v1/payments/${mp.body.id}/dispute`, { reason: "fraud" });
      assert.equal(dsp.status, 201); assert.equal(dsp.body.scheme, "visa"); assert.equal(dsp.body.liability_shifted, false);
      // docs endpoint and housekeeping
      const sj = await (await fetch(BASE + "/v1/schemes")).json(); assert.equal(sj.schemes[1].merchant_initiated.retry_advice.decline.code, "MAC 03");
      assert.equal((await api("GET", "/v1/agreements/agr_ffffffff")).status, 404);
      assert.equal((await api("DELETE", "/v1/payments")).status, 200); assert.equal((await api("GET", "/v1/agreements")).body.data.length, 0);
    }

    // ---- clearing, settlement, payouts and reconciliation ----
    {
      const sa = await api("POST", "/v1/accounts"); key = sa.body.api_key;
      await api("POST", "/v1/account/email", { email: "settle@example.test" }); await sleep(150); assert.ok((await api("POST", "/v1/email/verify", { token: lastLink("verify") })).body.trial_ends);
      const ws = await api("PUT", "/v1/webhook", { url: `http://127.0.0.1:${HOOK}/hook` }); secret = ws.body.secret; hooks.length = 0;
      const waitS = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const r = await fn(); if (r) return r; await sleep(60); } return null; };
      const pay = async (n, extra) => (await api("POST", "/v1/payments", card(n, { amount: 100, ...extra }))).body;
      const raw = async (path) => { const r = await fetch(BASE + path, { headers: { authorization: "Bearer " + key } }); return { status: r.status, type: r.headers.get("content-type"), text: await r.text() }; };

      const v1 = await pay("4111111111111111", { amount: 100 }), v2 = await pay("4111111111111111", { amount: 50 });
      const rf = (await api("POST", "/v1/payments", { request_id: "stl-rf", method: "card", transaction_type: "refund", amount: 20, parent_transaction_id: v2.id })).body;
      const m1 = await pay("5555555555554444", { amount: 80, currency: "USD" });
      const a1 = await pay("378282246310005", { amount: 40 });
      const a2 = await pay("378282246310005", { amount: 30, transaction_type: "authorization" });
      const a3 = await pay("378282246310005", { amount: 60, transaction_type: "authorization" });
      const cap = (await api("POST", "/v1/payments", { request_id: "stl-cap", method: "card", transaction_type: "capture-authorization", amount: 60, parent_transaction_id: a3.id })).body;
      const failedP = await pay("4000000000000002"); assert.equal(failedP.transaction_state, "failed");
      const voided = await pay("4111111111111111", { amount: 15 }); await api("POST", "/v1/payments", { request_id: "stl-void", method: "card", transaction_type: "void", parent_transaction_id: voided.id });
      await api("POST", "/v1/payments", { request_id: "stl-pp", method: "paypal", transaction_type: "debit", amount: 9, currency: "EUR" });
      const stp = await pay("4111111111111111", { amount: 10, store_credential: { type: "unscheduled" } });
      const mitp = (await api("POST", "/v1/payments", { request_id: "stl-mit", method: "card", transaction_type: "purchase", amount: 5, currency: "EUR", initiator: "merchant", agreement_id: stp.agreement_id })).body;
      const dA = (await api("POST", `/v1/payments/${v1.id}/dispute`, { reason_code: "10.4", outcome: "win" })).body;
      await api("POST", `/v1/disputes/${dA.id}/evidence`, { customer_ip: "1.1.1.1" });
      const dB = (await api("POST", `/v1/payments/${m1.id}/dispute`, { reason: "fraud", outcome: "lose" })).body;
      await api("POST", `/v1/disputes/${dB.id}/evidence`, { customer_ip: "1.1.1.1" });
      await waitS(async () => (await api("GET", `/v1/disputes/${dA.id}`)).body.state === "won" && (await api("GET", `/v1/disputes/${dB.id}`)).body.state === "lost");

      // fee schedule and validation
      const fees = (await api("GET", "/v1/settlements/fees")).body; assert.equal(fees.visa.percent, 1.4); assert.equal(fees.chargeback_fixed, 15);
      assert.equal((await api("POST", "/v1/settlements", { date: "2999-01-01" })).status, 400, "future");
      for (const d of ["nonsense", "2026-02-30", 20261103]) assert.equal((await api("POST", "/v1/settlements", { date: d })).status, 400, String(d));
      assert.equal((await api("POST", "/v1/settlements", { date: "2000-01-01" })).status, 409, "nothing was cleared that long ago");

      // closing the day
      const st = await api("POST", "/v1/settlements", {}); assert.equal(st.status, 201, JSON.stringify(st.body));
      const b1 = (await api("GET", `/v1/settlements/${st.body.id}`)).body;
      assert.equal(b1.record_count, 11); const ids = (k) => b1.records.filter((r) => r.kind === k).map((r) => r.payment_id).sort();
      assert.deepEqual(ids("presentment"), [v1.id, v2.id, m1.id, a1.id, cap.id, stp.id, mitp.id].sort());
      assert.deepEqual(ids("refund"), [rf.id]); assert.deepEqual(ids("chargeback"), [v1.id, m1.id].sort()); assert.deepEqual(ids("chargeback_reversal"), [v1.id]);
      for (const nope of [a2.id, a3.id, failedP.id, voided.id]) assert.ok(!b1.records.some((r) => r.payment_id === nope), nope + " is not cleared");
      const mr = b1.records.find((r) => r.payment_id === mitp.id); assert.equal(mr.mit, true); assert.equal(mr.ntid, mitp.network_transaction_id); assert.equal(mr.agreement_id, stp.agreement_id);
      assert.equal(b1.records.find((r) => r.kind === "chargeback" && r.payment_id === v1.id).reason_code, "10.4");
      const tot = (sch, cur) => b1.totals.find((t) => t.scheme === sch && t.currency === cur);
      assert.deepEqual(b1.totals.map((t) => t.scheme + t.currency), ["visaEUR", "mastercardUSD", "amexEUR"]);
      let t = tot("visa", "EUR"); assert.deepEqual([t.presentments.count, t.presentments.amount, t.refunds.amount, t.chargebacks.amount, t.chargeback_reversals.amount, t.fees, t.net], [4, 165, 20, 100, 100, 17.71, 127.29]);
      t = tot("mastercard", "USD"); assert.deepEqual([t.presentments.amount, t.chargebacks.amount, t.fees, t.net], [80, 80, 16.3, -16.3]);
      t = tot("amex", "EUR"); assert.deepEqual([t.presentments.count, t.presentments.amount, t.fees, t.net], [2, 100, 2.5, 97.5]);
      assert.deepEqual(b1.payouts.map((p) => [p.currency, p.amount, p.direction]), [["EUR", 224.79, "to_merchant"], ["USD", -16.3, "from_merchant"]]);
      assert.equal(b1.payout_date, new Date(Date.parse(b1.cutoff) + 2 * 864e5).toISOString().slice(0, 10), "payout two days after the cutoff");
      assert.equal((await api("GET", `/v1/payments/${v1.id}`)).body.settled_in, st.body.id);
      assert.equal((await api("POST", "/v1/payments", { request_id: "stl-late-void", method: "card", transaction_type: "void", parent_transaction_id: a1.id })).body.error.code, "SBX-4234", "a cleared payment can no longer be voided");
      await waitS(() => hooks.find((h) => h.body.type === "settlement.created" && h.body.data.id === st.body.id)); assert.ok(hooks.find((h) => h.body.type === "settlement.created").ok);
      assert.equal((await api("POST", "/v1/settlements", {})).status, 409, "nothing left to clear");

      // files
      const fl = (await api("GET", `/v1/settlements/${st.body.id}/files`)).body.data; const ymdS = b1.cutoff.replace(/-/g, "");
      assert.deepEqual(fl.map((f) => f.name), [`zbx-visa-clearing-${ymdS}.dat`, `zbx-mastercard-clearing-${ymdS}.txt`, `zbx-amex-clearing-${ymdS}.csv`, `zbx-settlement-${ymdS}.csv`, `zbx-interchange-${ymdS}.csv`, `zbx-payout-${ymdS}.csv`]);

      // interchange report: fee split by scheme, card type and region
      const ic = (await api("GET", `/v1/settlements/${st.body.id}/interchange`)).body;
      assert.equal(ic.batch_id, st.body.id); assert.ok(ic.groups.length >= 3);
      for (const g of ic.groups) {
        assert.ok(["consumer_debit", "consumer_credit", "commercial"].includes(g.card_type) && ["domestic", "eea", "international"].includes(g.card_region));
        if (g.scheme === "amex") { assert.equal(g.interchange, 0); assert.equal(g.scheme_fees, 0); assert.equal(g.acquirer_margin, g.blended_total); assert.equal(g.difference, 0); }
        else assert.ok(Math.abs(g.interchange + g.scheme_fees + g.acquirer_margin - g.blended_total) < 0.011, "parts add up to the blended fee");
      }
      const presFees = b1.totals.reduce((a, x) => a + x.fees, 0), icFees = ic.totals.reduce((a, x) => a + x.blended_total, 0);
      assert.ok(icFees > 0 && icFees <= presFees + 0.011, "report covers presentment fees");
      assert.ok(ic.totals.every((x) => x.blended_effective_rate_percent > 0) && ic.schedule.percent.domestic.consumer_debit === 0.2);
      const icCsv = await raw(`/v1/settlements/${st.body.id}/files/zbx-interchange-${ymdS}.csv`); assert.equal(icCsv.status, 200); assert.ok(icCsv.text.split("\n")[0].startsWith("batch_id,settlement_date,scheme,card_type"));
      assert.equal((await api("GET", "/v1/settlements/stl_00000000/interchange")).status, 404);
      const vf = await raw(`/v1/settlements/${st.body.id}/files/${fl[0].name}`); assert.equal(vf.status, 200); assert.ok(vf.type.startsWith("text/plain"));
      const vl = vf.text.trimEnd().split("\n"); assert.equal(vl[0], "H" + st.body.id.padEnd(12) + ymdS); assert.equal(vl.length, 1 + 7 + 1);
      const dl = vl.slice(1, -1); assert.ok(dl.every((l) => l.length === 95 && l[0] === "D"), "detail lines are 95 characters");
      assert.deepEqual(dl.map((l) => l.slice(1, 3)).sort(), ["CB", "CR", "PS", "PS", "PS", "PS", "RF"]);
      assert.equal(vl.at(-1), "T" + "00000007" + "00000000038500"); assert.equal(dl.reduce((a, l) => a + Number(l.slice(56, 68)), 0), 38500);
      const cbLine = dl.find((l) => l.startsWith("DCB")); assert.equal(cbLine.slice(3, 22).trim(), v1.id); assert.equal(cbLine.slice(22, 41).trim(), dA.id); assert.equal(cbLine.slice(68, 71), "EUR"); assert.equal(cbLine.slice(75, 81).trim(), "10.4");
      const mf = (await raw(`/v1/settlements/${st.body.id}/files/${fl[1].name}`)).text.trimEnd().split("\n"); assert.equal(mf[0], `HDR|${st.body.id}|${b1.cutoff}|MASTERCARD`);
      assert.equal(mf.length, 4); assert.equal(mf.at(-1), "TRL|2|160.00"); assert.ok(mf[1].startsWith("TXN|PRESENTMENT|" + m1.id + "||")); assert.equal(mf[1].split("|").length, 10);
      const af = (await raw(`/v1/settlements/${st.body.id}/files/${fl[2].name}`)); assert.ok(af.type.startsWith("text/csv")); const al = af.text.trimEnd().split("\n");
      assert.equal(al[0], `HEADER,${st.body.id},${b1.cutoff},AMEX`); assert.ok(al[1].startsWith("record_type,kind,transaction_id")); assert.equal(al.length, 5); assert.equal(al.at(-1), "TRAILER,2,100.00");
      const sr = (await raw(`/v1/settlements/${st.body.id}/files/${fl[3].name}`)).text.trimEnd().split("\n"); assert.equal(sr.length, 4);
      assert.equal(sr[1], `${st.body.id},${b1.cutoff},visa,EUR,4,165.00,1,20.00,1,100.00,1,100.00,17.71,127.29`); assert.equal(sr[2].split(",").at(-1), "-16.30");
      const pf = (await raw(`/v1/settlements/${st.body.id}/files/${fl[5].name}`)).text.trimEnd().split("\n"); assert.equal(pf.length, 3); assert.ok(pf[1].endsWith(`,EUR,224.79,to_merchant,${b1.payout_date}`));
      assert.equal((await raw(`/v1/settlements/${st.body.id}/files/nope.csv`)).status, 404); assert.equal((await api("GET", "/v1/settlements/stl_ffffffff")).status, 404);

      // reconciliation: a ledger with deliberate mistakes
      const ledger = ["transaction_id,amount,currency", `${v1.id},100.00,EUR`, `${v1.id},100.00,EUR`, `${v2.id},55.00,EUR`, `${a1.id},40.00,USD`, `${m1.id},80.00,USD`, "tx_deadbeef,12.00,EUR"].join("\n");
      const rc = (await api("POST", `/v1/settlements/${st.body.id}/reconcile`, { csv: ledger })).body;
      assert.deepEqual(rc.summary, { matched: 2, amount_mismatch: 1, currency_mismatch: 1, missing_in_clearing: 1, missing_in_ledger: 4, duplicate_in_ledger: 1 }); assert.equal(rc.ok, false);
      const st_ = (id) => rc.items.find((i) => i.transaction_id === id && i.status !== "duplicate_in_ledger").status;
      assert.equal(st_(v2.id), "amount_mismatch"); assert.equal(st_(a1.id), "currency_mismatch"); assert.equal(st_("tx_deadbeef"), "missing_in_clearing"); assert.equal(st_(cap.id), "missing_in_ledger"); assert.equal(st_(rf.id), "missing_in_ledger");
      assert.equal(rc.adjustments.length, 3); assert.ok(rc.adjustments.some((x) => x.kind === "chargeback" && x.reason_code === "10.4")); assert.ok(rc.note.includes("fictional"));
      const semi = (await api("POST", `/v1/settlements/${st.body.id}/reconcile`, { csv: `id;amount\n${v1.id};100,00\n${m1.id};80,00` })).body; assert.equal(semi.summary.matched, 2, "semicolon CSV with decimal commas");
      for (const body of [{}, { csv: "only a header" }, { csv: "foo,bar\n1,2" }, { ledger: [] }, { ledger: "x" }]) assert.equal((await api("POST", `/v1/settlements/${st.body.id}/reconcile`, body)).status, 400, JSON.stringify(body));
      assert.equal((await api("POST", "/v1/settlements/stl_ffffffff/reconcile", { csv: ledger })).status, 404);

      // late events go into the next batch, and nothing is cleared twice
      const late = await pay("4111111111111111", { amount: 7 });
      const st2 = await api("POST", "/v1/settlements", {}); assert.equal(st2.status, 201); const b2 = (await api("GET", `/v1/settlements/${st2.body.id}`)).body;
      assert.deepEqual(b2.records.map((r) => [r.kind, r.payment_id]), [["presentment", late.id]]); assert.equal(b2.payouts[0].amount, 6.8); // 7.00 minus a fee of 0.20 (1.4% = 0.098, plus 0.10, rounded)
      assert.equal((await api("GET", "/v1/settlements")).body.data.length, 2); assert.equal((await api("GET", "/v1/settlements")).body.data[0].records, undefined);
      const perfect = (await api("POST", `/v1/settlements/${st2.body.id}/reconcile`, { ledger: [{ transaction_id: late.id, amount: 7, currency: "EUR" }] })).body; assert.equal(perfect.ok, true); assert.equal(perfect.summary.matched, 1);

      // daily export of every transaction
      const today = new Date().toISOString().slice(0, 10); const ex = await raw(`/v1/reports/transactions?date=${today}`);
      assert.equal(ex.status, 200); assert.ok(ex.type.startsWith("text/csv")); const el = ex.text.trimEnd().split("\n"); assert.ok(el[0].startsWith("transaction_id,request_id,parent_transaction_id,method"));
      const all = (await api("GET", "/v1/payments?limit=100")).body.data; assert.equal(el.length - 1, all.filter((p) => p.created_at.slice(0, 10) === today).length);
      assert.ok(el.some((l) => l.includes(",paypal,"))); assert.ok(el.some((l) => l.startsWith(v1.id) && l.endsWith(`,${dA.id},won,${st.body.id}`)), "dispute and settlement show on the row");
      assert.equal((await raw("/v1/reports/transactions?date=2001-01-01")).text.trimEnd().split("\n").length, 1); assert.equal((await raw("/v1/reports/transactions?date=bogus")).status, 400);
      assert.equal((await api("DELETE", "/v1/payments")).status, 200); assert.equal((await api("GET", "/v1/settlements")).body.data.length, 0);
    }

    // ---- card type and region for the interchange report ----
    {
      const cA = (await api("POST", "/v1/payments", { request_id: "ct-" + Math.random(), method: "card", transaction_type: "purchase", amount: 5, currency: "EUR", card_number: "4111111111111111", card_cvv: "123", card_type: "commercial", card_region: "international" })).body;
      assert.equal(cA.card_type, "commercial"); assert.equal(cA.card_region, "international");
      const cB = (await api("POST", "/v1/payments", { request_id: "ct2-" + Math.random(), method: "card", transaction_type: "purchase", amount: 5, currency: "EUR", card_number: "4111111111111111", card_cvv: "123" })).body;
      const cB2 = (await api("POST", "/v1/payments", { request_id: "ct3-" + Math.random(), method: "card", transaction_type: "purchase", amount: 5, currency: "EUR", card_number: "4111111111111111", card_cvv: "123" })).body;
      assert.equal(cB.card_type, cB2.card_type, "same number, same profile");
      assert.equal((await api("POST", "/v1/payments", { request_id: "ct4-" + Math.random(), method: "card", transaction_type: "purchase", amount: 5, currency: "EUR", card_number: "4111111111111111", card_cvv: "123", card_type: "gold" })).status, 400);
      assert.equal((await api("POST", "/v1/payments", { request_id: "ct5-" + Math.random(), method: "card", transaction_type: "refund", amount: 1, currency: "EUR", parent_transaction_id: cA.id, card_type: "commercial" })).status, 400);
      assert.equal((await api("POST", "/v1/payments", { request_id: "ct6-" + Math.random(), method: "card", transaction_type: "refund", amount: 1, currency: "EUR", parent_transaction_id: cA.id })).body.card_type, "commercial", "refund keeps parent's card type");
    }

    // ---- card-present: POS and ATM, chip, magstripe, EMV crypto ----
    {
      const cpost = (b) => api("POST", "/v1/card-present", b);
      const cat = (await api("GET", "/v1/card-present")).body; assert.equal(cat.transaction_types.length, 16); assert.equal(cat.test_cards.length, 33); assert.ok(cat.entry_modes.length === 5);
      const V = "4111111111111111";
      // chip sale: real ARQC verified, ARPC returned, appears as a normal payment
      const s1 = await cpost({ transaction_type: "sale", amount: 12.5, card_number: V }); assert.equal(s1.status, 201); assert.equal(s1.body.approved, true); assert.equal(s1.body.response_code, "00");
      assert.match(s1.body.emv.arqc, /^[0-9A-F]{16}$/); assert.match(s1.body.emv.arpc, /^[0-9A-F]{16}$/); assert.equal(s1.body.emv.cid.type, "ARQC"); assert.equal(s1.body.emv.atc, "0001");
      assert.equal(s1.body.transaction_type, "purchase"); assert.equal(s1.body.cp.channel, "pos"); assert.equal(s1.body.cp.pos_entry_mode, "052");
      assert.ok(s1.body.flow.some((f) => /Issuer checks the ARQC/.test(f.title) && f.ok));
      assert.equal((await api("GET", `/v1/payments/${s1.body.id}`)).body.cp.entry_mode, "chip");
      assert.ok((await api("GET", `/v1/payments/${s1.body.id}/card-present-log`)).body.flow.length >= 4);
      assert.equal((await cpost({ transaction_type: "sale", amount: 1, card_number: V })).body.emv.atc, "0002", "counter increases");
      // independent check of the crypto: recompute the ARQC with the toolkit
      const EMV = require("./emv"); const e1 = s1.body.emv;
      assert.equal(EMV.hex(EMV.generateArqc(V, "00", { amount: 12.5, other: 0, country: "0276", tvr: e1.tvr, currency: "EUR", date: new Date().toISOString().slice(2, 10).replace(/-/g, ""), type: "00", un: e1.un, aip: e1.aip, atc: e1.atc, iad: "0110A00003220000" })), e1.arqc);
      assert.equal(EMV.hex(EMV.generateArpc(V, "00", e1.atc, e1.arqc, "00")), e1.arpc);
      // tampering is caught
      for (const t of ["arqc", "amount_after_signing", "unpredictable_number", "atc_replay"]) { const r = await cpost({ transaction_type: "sale", amount: 5, card_number: V, tamper: t }); assert.equal(r.body.approved, false, t); assert.equal(r.body.response_code, "82", t); assert.equal(r.body.transaction_state, "failed"); }
      // user-supplied EMV data is verified
      const own = await cpost({ transaction_type: "sale", amount: 7, card_number: V, emv: { atc: "0100", un: "01020304", arqc: "0000000000000000" } }); assert.equal(own.body.approved, false); assert.ok(own.body.emv.expected_arqc.length === 16);
      const own2 = await cpost({ transaction_type: "sale", amount: 7, card_number: V, emv: { atc: "0100", un: "01020304", arqc: own.body.emv.expected_arqc } }); assert.equal(own2.body.approved, true, JSON.stringify(own2.body.flow.slice(-2)));
      // magstripe: chip card swiped is refused, fallback works, wrong CVV1 fails, signature CVM
      assert.equal((await cpost({ transaction_type: "sale", amount: 3, card_number: V, entry_mode: "magstripe" })).body.response_code, "62");
      const fb = await cpost({ transaction_type: "sale", amount: 3, card_number: V, entry_mode: "fallback" }); assert.equal(fb.body.approved, true); assert.equal(fb.body.cp.pos_entry_mode, "802"); assert.equal(fb.body.cvm, "signature");
      assert.equal((await cpost({ transaction_type: "sale", amount: 3, card_number: V, entry_mode: "fallback", tamper: "wrong_cvv" })).body.response_code, "82");
      const MAG = require("./mag"), tr = MAG.buildTracks(V, { serviceCode: "101" });
      const stripe = await cpost({ transaction_type: "sale", amount: 3, track2: tr.track2, service_code: "101", entry_mode: "magstripe" }); assert.equal(stripe.body.approved, true, JSON.stringify(stripe.body.flow));
      assert.equal((await cpost({ transaction_type: "sale", amount: 3, track2: tr.track2.replace(tr.cvv1 + "?", "000?"), service_code: "101", entry_mode: "magstripe" })).body.response_code, "82", "bad CVV1 on the stripe");
      assert.equal((await cpost({ transaction_type: "sale", amount: 3, track2: ";4242424242424242=30122011234?", entry_mode: "magstripe" })).status, 422, "real-looking card refused");
      assert.equal((await cpost({ transaction_type: "sale", amount: 3, card_number: "4242424242424242" })).status, 422);
      // manual entry checks CVV2
      const cv2 = MAG.cvv(V, "3012", "000"); assert.equal((await cpost({ transaction_type: "sale", amount: 3, card_number: V, entry_mode: "manual", card_cvv: cv2 })).body.approved, true); assert.equal((await cpost({ transaction_type: "sale", amount: 3, card_number: V, entry_mode: "manual", card_cvv: "999" })).body.response_code, "N7");
      // contactless limit and online PIN above the floor
      assert.equal((await cpost({ transaction_type: "sale", amount: 150, card_number: V, entry_mode: "contactless" })).body.response_code, "1A");
      const cl = await cpost({ transaction_type: "sale", amount: 80, card_number: V, entry_mode: "contactless", pin: "1234" }); assert.equal(cl.body.approved, true); assert.equal(cl.body.cvm, "online_pin"); assert.ok(cl.body.emv.tvr_flags.includes("Online PIN entered"));
      assert.equal((await cpost({ transaction_type: "sale", amount: 80, card_number: V, entry_mode: "contactless", device: "mobile" })).body.cvm, "cdcvm");
      // POS: pre-auth, incremental, completion, void, reversal, refund, cashback, cash advance, quasi-cash, AFT, OCT
      const M = "5555555555554444";
      const au = await cpost({ transaction_type: "auth", amount: 100, card_number: M }); assert.equal(au.body.transaction_type, "authorization");
      const inc = await cpost({ transaction_type: "incremental_auth", amount: 50, parent_transaction_id: au.body.id }); assert.equal(inc.body.approved, true); assert.equal(inc.body.payment.amount, 150); assert.equal(inc.body.payment.increments.length, 1);
      const co = await cpost({ transaction_type: "completion", amount: 150, parent_transaction_id: au.body.id }); assert.equal(co.body.approved, true); assert.equal(co.body.transaction_type, "capture-authorization");
      assert.equal((await cpost({ transaction_type: "incremental_auth", amount: 5, parent_transaction_id: au.body.id })).status, 422, "no increment after capture");
      const sv = await cpost({ transaction_type: "sale", amount: 20, card_number: M }); const vd = await cpost({ transaction_type: "void", parent_transaction_id: sv.body.id }); assert.equal(vd.body.approved, true); assert.equal(vd.body.cp.transaction_type, "void");
      const s3 = await cpost({ transaction_type: "sale", amount: 30, card_number: M }); const rv = await cpost({ transaction_type: "reversal", parent_transaction_id: s3.body.id, reversal_reason: "device_failure" }); assert.equal(rv.body.approved, true, JSON.stringify(rv.body).slice(0, 300)); assert.equal(rv.body.cp.reversal_reason, "device_failure");
      const s4 = await cpost({ transaction_type: "sale", amount: 40, card_number: M }); const rf = await cpost({ transaction_type: "refund", amount: 15, parent_transaction_id: s4.body.id }); assert.equal(rf.body.approved, true); assert.equal(rf.body.transaction_type, "refund");
      assert.equal((await cpost({ transaction_type: "cashback", amount: 40, cashback_amount: 20, card_number: M })).status, 400, "cashback needs PIN");
      const cb = await cpost({ transaction_type: "cashback", amount: 40, cashback_amount: 20, card_number: M, pin: "1234" }); assert.equal(cb.body.approved, true); assert.equal(cb.body.cp.cashback_amount, 20); assert.equal(cb.body.emv.valid, true);
      assert.equal((await cpost({ transaction_type: "cashback", amount: 10, cashback_amount: 20, card_number: M, pin: "1234" })).status, 400);
      assert.equal((await cpost({ transaction_type: "cash_advance", amount: 200, card_number: M, pin: "1234" })).body.cp.mcc, "6010");
      assert.equal((await cpost({ transaction_type: "quasi_cash", amount: 90, card_number: M })).body.cp.mcc, "6051");
      assert.equal((await cpost({ transaction_type: "aft", amount: 25, card_number: M })).body.cp.business_application_id, "AA");
      const oc = await cpost({ transaction_type: "oct", amount: 25, card_number: M }); assert.equal(oc.body.approved, true); assert.equal(oc.body.transaction_type, "refund"); assert.equal(oc.body.oct, true);
      // decline outcomes follow the test card after the security checks pass
      assert.equal((await cpost({ transaction_type: "sale", amount: 9, card_number: "4000000000009995" })).body.response_code, "51");
      assert.equal((await cpost({ transaction_type: "sale", amount: 9, card_number: "4000000000000002" })).body.response_code, "05");
      assert.equal((await cpost({ transaction_type: "sale", amount: 9, card_number: "4000000000000069" })).body.response_code, "54");
      assert.equal((await cpost({ transaction_type: "sale", amount: 9, card_number: "4000000000003220" })).body.approved, true, "3DS cards are plain cards at a terminal");
      // ATM: PIN rules, limits, balance, statement, PIN change, try counter
      const atm = (b) => cpost({ channel: "atm", card_number: V, ...b });
      assert.equal((await atm({ transaction_type: "withdrawal", amount: 100 })).status, 400, "ATM needs PIN");
      assert.equal((await atm({ transaction_type: "withdrawal", amount: 105, pin: "1234" })).status, 422, "notes of 10");
      const w1 = await atm({ transaction_type: "withdrawal", amount: 300, pin: "1234" }); assert.equal(w1.body.approved, true); assert.equal(w1.body.cp.mcc, "6011");
      assert.equal((await atm({ transaction_type: "withdrawal", amount: 300, pin: "1234" })).body.response_code, "61", "daily limit");
      const bal = await atm({ transaction_type: "balance_inquiry", pin: "1234" }); assert.equal(bal.body.balance.available, 1700); assert.equal(bal.body.id, undefined, "no payment for a balance inquiry");
      const ms = await atm({ transaction_type: "mini_statement", pin: "1234" }); assert.equal(ms.body.statement.length, 1); assert.equal(ms.body.statement[0].amount, -300);
      assert.equal((await atm({ transaction_type: "balance_inquiry", pin: "1234", amount: 5 })).status, 400);
      assert.equal((await atm({ transaction_type: "pin_change", pin: "1234", new_pin: "1111" })).body.approved, false, "weak PIN");
      assert.equal((await atm({ transaction_type: "pin_change", pin: "1234", new_pin: "7391" })).body.approved, true);
      assert.equal((await atm({ transaction_type: "balance_inquiry", pin: "1234" })).body.response_code, "55", "old PIN no longer works");
      assert.equal((await atm({ transaction_type: "balance_inquiry", pin: "7391" })).body.approved, true);
      const blockHex = MAG.buildPinBlock("7391", V).encrypted; assert.equal((await atm({ transaction_type: "balance_inquiry", pin_block: blockHex })).body.approved, true, "encrypted PIN block");
      assert.equal((await atm({ transaction_type: "balance_inquiry", pin_block: MAG.buildPinBlock("7391", "5555555555554444").encrypted })).body.approved, false, "block made for another card");
      for (let i = 0; i < 3; i++) await atm({ transaction_type: "balance_inquiry", pin: "0000" });
      assert.equal((await atm({ transaction_type: "balance_inquiry", pin: "7391" })).body.response_code, "75", "blocked after 3 wrong PINs");
      assert.equal((await api("POST", "/v1/card-present/reset-pin-tries", { card_number: V })).status, 200); assert.equal((await atm({ transaction_type: "balance_inquiry", pin: "1234" })).body.approved, true, "reset restores test PIN");
      assert.equal((await atm({ transaction_type: "sale", amount: 5 })).status, 422, "sale is not an ATM transaction"); assert.equal((await cpost({ transaction_type: "withdrawal", amount: 10, card_number: V, pin: "1234" })).status, 422, "withdrawal is not a POS transaction");
      assert.equal((await atm({ transaction_type: "withdrawal", amount: 20, pin: "1234", entry_mode: "contactless" })).status, 422);
      assert.equal((await cpost({ transaction_type: "sale", amount: 5, card_number: V, bogus: 1 })).status, 400);
      // the lab's payments settle like any other
      const stl = await api("POST", "/v1/settlements", {}); assert.equal(stl.status, 201, JSON.stringify(stl.body).slice(0, 200));
    }

    // ---- AI tutor (mock model) ----
    {
      const keep = key; const ta = await api("POST", "/v1/accounts"); key = ta.body.api_key;
      const st0 = (await api("GET", "/v1/tutor")).body; assert.equal(st0.enabled, true); assert.equal(st0.limit_per_day, 10); assert.equal(st0.remaining_today, 10);
      const tp = (await api("POST", "/v1/payments", card("4000000000003220", { card_cvv: "123" }))).body; assert.equal(tp.status.code, "SBX-2020");
      const ans = await api("POST", "/v1/tutor", { question: "Why is this payment still pending?", transaction_id: tp.id });
      assert.equal(ans.status, 200, JSON.stringify(ans.body)); assert.ok(ans.body.answer.startsWith("Mock answer")); assert.equal(ans.body.remaining_today, 9);
      const call = aiCalls[aiCalls.length - 1];
      assert.equal(call.url, "/v1/messages"); assert.equal(call.key, "sk-ant-mock"); assert.equal(call.ver, "2023-06-01"); assert.equal(call.body.model, "mock-model");
      assert.ok(call.body.system.includes("SBX-2020") && call.body.system.includes(tp.id) && call.body.system.includes("<user_data>"), "context and glossary reach the model");
      assert.ok(!call.body.system.includes("4000000000003220"), "no card number in the context");
      const before = aiCalls.length;
      const real = await api("POST", "/v1/tutor", { question: "Is 4242 4242 4242 4242 valid?" }); assert.equal(real.status, 422); assert.equal(real.body.error.code, "real_card_data"); assert.equal(aiCalls.length, before, "refused before any model call");
      assert.equal((await api("POST", "/v1/tutor", { question: "Is 4111 1111 1111 1111 a test card?" })).status, 200, "test cards are fine");
      assert.equal((await api("POST", "/v1/tutor", { question: "" })).status, 400); assert.equal((await api("POST", "/v1/tutor", { question: "x".repeat(801) })).status, 400);
      assert.equal((await api("POST", "/v1/tutor", { question: "hi", history: [{ role: "system", content: "x" }] })).status, 400);
      assert.equal((await api("POST", "/v1/tutor", { question: "hi", transaction_id: "tx_ffffffffffffffff" })).status, 404);
      assert.equal((await api("POST", "/v1/tutor", { question: "LEAK please" })).body.answer.startsWith("I can't show that"), true, "answers are scanned too");
      const rem = (await api("GET", "/v1/tutor")).body.remaining_today;
      assert.equal((await api("POST", "/v1/tutor", { question: "UPSTREAM-FAIL" })).status, 502); assert.equal((await api("GET", "/v1/tutor")).body.remaining_today, rem, "failed calls are not counted");
      for (let i = 0; i < rem; i++) assert.equal((await api("POST", "/v1/tutor", { question: "q" + i, history: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] })).status, 200);
      const cap = await api("POST", "/v1/tutor", { question: "one more" }); assert.equal(cap.status, 429); assert.equal(cap.body.error.code, "tutor_limit");
      key = null; assert.equal((await api("GET", "/v1/tutor")).status, 401); key = keep;
    }

    // ---- MCP server ----
    {
      const rpc = async (msg, hdrs = {}, k = key) => { const r = await fetch(BASE + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(k ? { authorization: `Bearer ${k}` } : {}), ...hdrs }, body: JSON.stringify(msg) }); const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null, headers: r.headers }; };
      const tool = async (name, args) => { const r = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }); assert.equal(r.status, 200, name); const c = r.body.result; return { isError: c.isError, text: c.content[0].text, json: (() => { try { return JSON.parse(c.content[0].text); } catch { return null; } })() }; };
      const noauth = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, {}, null); assert.equal(noauth.status, 401); assert.ok(noauth.headers.get("www-authenticate").startsWith("Bearer"));
      assert.equal((await fetch(BASE + "/mcp")).status, 405); assert.equal((await fetch(BASE + "/mcp", { method: "DELETE" })).status, 405);
      assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example" })).status, 403, "origin check");
      const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
      assert.equal(init.body.result.protocolVersion, "2025-03-26"); assert.equal(init.body.result.serverInfo.name, "zanboxx"); assert.ok(init.body.result.capabilities.tools);
      assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } })).body.result.protocolVersion, "2025-06-18");
      const note = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }); assert.equal(note.status, 202); assert.equal(note.body, null);
      const list = (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).body.result.tools; assert.ok(list.length >= 20); assert.ok(list.every((t) => t.name && t.description && t.inputSchema.type === "object"));
      assert.ok(!list.some((t) => /rotate|delete_account|billing/.test(t.name)), "dangerous tools not exposed");
      assert.equal((await rpc({ jsonrpc: "2.0", id: 3, method: "nope" })).body.error.code, -32601);
      assert.equal((await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope" } })).body.error.code, -32602);
      assert.equal((await rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }])).body.length, 1, "batch");
      const bad1 = await fetch(BASE + "/mcp", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: "{oops" }); assert.equal(bad1.status, 400);
      const real = await tool("create_payment", { method: "card", transaction_type: "purchase", amount: 5, currency: "EUR", card_number: "4242424242424242", card_cvv: "123" });
      assert.ok(real.isError && /looks real/.test(real.text), "real card guard");
      const pay = await tool("create_payment", { method: "card", transaction_type: "purchase", amount: 12.5, currency: "EUR", card_number: "4111111111111111", card_cvv: "123" });
      assert.ok(!pay.isError); assert.equal(pay.json.transaction_state, "success");
      assert.equal((await tool("get_payment", { transaction_id: pay.json.id })).json.id, pay.json.id);
      assert.ok((await tool("list_payments", { limit: 5 })).json.data.length >= 1);
      const missing = await tool("get_payment", {}); assert.ok(missing.isError && /Missing required/.test(missing.text));
      assert.ok((await tool("get_payment", { transaction_id: "tx_ffffffffffffffff" })).isError, "API errors surface as isError");
      assert.ok((await tool("get_payment", { transaction_id: pay.json.id, bogus: 1 })).isError, "unknown args");
      const c3 = await tool("create_payment", { method: "card", transaction_type: "purchase", amount: 9, currency: "EUR", card_number: "4000000000003220", card_cvv: "123" });
      assert.equal(c3.json.status.code, "SBX-2020");
      assert.equal((await tool("complete_3ds_challenge", { transaction_id: c3.json.id, result: "approve" })).json.transaction_state, "success");
      { const lg = await tool("get_3ds_log", { transaction_id: c3.json.id }); assert.ok(lg.text.includes("3-D Secure") && !lg.isError, lg.text.slice(0, 300)); }
      const dsp = await tool("create_dispute", { transaction_id: pay.json.id, reason: "duplicate", outcome: "win" }); assert.equal(dsp.json.state, "needs_response");
      assert.equal((await tool("submit_dispute_evidence", { dispute_id: dsp.json.id, evidence: { original_transaction_reference: "tx_1", explanation: "Two separate orders" } })).json.state, "under_review");
      assert.equal((await tool("get_dispute", { dispute_id: dsp.json.id })).json.id, dsp.json.id); assert.ok((await tool("list_disputes", {})).json.data.length >= 1);
      const stl = await tool("close_settlement_day", {}); assert.ok(!stl.isError, stl.text); assert.ok((await tool("get_settlement", { settlement_id: stl.json.id })).json.id === stl.json.id);
      assert.ok((await tool("get_settlement", {})).json.data.length >= 1);
      assert.ok((await tool("get_usage", {})).json); assert.ok((await tool("list_agreements", {})).json.data);
      const cards = await tool("list_test_cards", { scheme: "amex" }); assert.ok(cards.json.data.length === 11 && cards.json.data.every((c) => c.scheme === "amex"));
      assert.match((await tool("explain_status_code", { code: "SBX-4225" })).text, /refundable/); assert.match((await tool("explain_status_code", { code: "116" })).text, /Amex|American/);
      assert.ok((await tool("get_failure_script", {})).json); assert.ok(!(await tool("clear_failure_script", {})).isError);
      assert.ok((await tool("list_webhook_deliveries", {})).json.data);
    }

    console.log("All checks passed");
  } catch (e) { console.error("FAILED:", e.stack.split("\n").slice(0,3).join(" | ")); process.exitCode = 1; }
  finally { srv.kill(); receiver.close(); mockAI.close(); mockStripe.close(); mockMail.close(); if (global.__mockS3) global.__mockS3.close(); }
})();
