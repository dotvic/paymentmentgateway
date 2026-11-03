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

    console.log("All checks passed");
  } catch (e) { console.error("FAILED:", e.stack.split("\n").slice(0,3).join(" | ")); process.exitCode = 1; }
  finally { srv.kill(); receiver.close(); mockStripe.close(); mockMail.close(); if (global.__mockS3) global.__mockS3.close(); }
})();
