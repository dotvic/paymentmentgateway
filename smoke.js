"use strict";
// Run: npm test  (starts the server and a local webhook receiver, then exercises every flow)
const { spawn } = require("child_process"), http = require("http"), crypto = require("crypto"), assert = require("assert");
const PORT = 18080, HOOK = 18081, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = spawn("node", ["server.js"], {
  env: { ...process.env, PORT, DATA_FILE: `/tmp/dryrun-test-${Date.now()}.json`, ALLOW_PRIVATE_WEBHOOKS: "1", RETRY_MS: "0,200", SETTLE_DELAY_MS: "300" },
  stdio: "inherit",
});
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
    console.log("All checks passed");
  } catch (e) { console.error("FAILED:", e.message); process.exitCode = 1; }
  finally { srv.kill(); receiver.close(); }
})();
