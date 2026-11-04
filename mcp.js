"use strict";
// MCP server (Model Context Protocol, Streamable HTTP, stateless JSON responses) for the Zanboxx sandbox.
// It lets an AI assistant drive the sandbox with tools. Every tool calls the public REST API over loopback with the
// caller's own API key, so validation, rate limits, quotas and plan rules are exactly the same as for direct calls.
// Test cards only: the guard below refuses card numbers that look real.
const crypto = require("crypto");
const SCH = require("./schemes");

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_OUT = 40000;
const TEST_NUMBERS = new Set(SCH.TEST_CARDS.map((c) => c.number));

const GLOSSARY = {
  "SBX-2000": "Approved.", "SBX-2002": "Approved without liability shift (3-D Secure was unavailable).", "SBX-2010": "Processing; the final state follows.",
  "SBX-2020": "Waiting for 3-D Secure. Complete the challenge with complete_3ds_challenge.",
  "SBX-4030": "3-D Secure authentication failed. The customer did not pass the challenge.", "SBX-4032": "3-D Secure rejected by the issuer. Do not retry this card.",
  "SBX-4220": "Parent transaction did not succeed.", "SBX-4221": "Parent transaction is already voided.", "SBX-4222": "capture-authorization needs an authorization as parent.",
  "SBX-4223": "Amount exceeds the uncaptured balance.", "SBX-4224": "A refund needs a purchase, debit or capture as parent.", "SBX-4225": "Amount exceeds the refundable balance (money held by a dispute cannot be refunded).",
  "SBX-4226": "Refunds and voids cannot be voided.", "SBX-4227": "Authorization already captured; refund the capture.", "SBX-4228": "Already refunded; it can no longer be voided.",
  "SBX-4229": "Parent transaction used a different payment method.", "SBX-4230": "Disputes are for card payments only.", "SBX-4231": "Only a successful purchase or capture can be disputed.",
  "SBX-4232": "Dispute amount exceeds the disputable balance.", "SBX-4233": "Transaction is disputed; it can no longer be voided.", "SBX-4234": "Already cleared in a settlement; refund instead of voiding.",
  "SBX-4240": "Agreement is not active; no more merchant-initiated payments.", "SBX-4242": "All instalments have been collected.",
  "SBX-5000": "Gateway error injected by your failure script.", "SBX-5040": "Gateway timeout; outcome unknown. Wait for the webhook or poll before retrying.",
  "3DS Y": "Authenticated. Liability shifts to the issuer.", "3DS A": "Attempt recorded. Liability usually shifts.", "3DS N": "Authentication denied.",
  "3DS U": "Authentication unavailable. No liability shift.", "3DS R": "Rejected by the issuer. Do not retry.", "3DS C": "Challenge required.",
};

const S = (description, extra = {}) => ({ type: "string", description, ...extra });
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const ID = (what, prefix) => S(`The ${what} id, starting with ${prefix}`);
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, WR = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const TOOLS = [
  { name: "create_payment", title: "Create a test payment", annotations: WR,
    description: "Creates a sandbox transaction. For cards use ONLY the Zanboxx test cards (see list_test_cards); the card number decides the outcome. Real card numbers are refused. Follow-up types (capture-authorization, refund, void) need parent_transaction_id.",
    inputSchema: obj({
      method: S("Payment method", { enum: ["card", "sepa", "ideal", "paypal"] }), transaction_type: S("e.g. purchase, authorization, capture-authorization, refund, void, debit"),
      amount: { type: "number", description: "Amount in major units, e.g. 12.50" }, currency: S("ISO code, e.g. EUR"),
      card_number: S("A Zanboxx test card number"), card_cvv: S("Visa/Mastercard 3 digits, Amex 4 digits"), scenario: S("Force an outcome instead of using the card number"),
      parent_transaction_id: ID("parent transaction", "tx_"), request_id: S("Idempotency key (generated if omitted)"),
      initiator: S("customer (default) or merchant", { enum: ["customer", "merchant"] }), agreement_id: ID("card-on-file agreement", "agr_"),
      store_credential: { type: "object", description: "Store the card for later merchant-initiated payments: {type: subscription|instalment|unscheduled, instalments?: 2-60}" },
    }, ["method", "transaction_type"]),
    run: async (a, api) => {
      const b = { ...a };
      if (b.card_number !== undefined) {
        const n = String(b.card_number).replace(/[\s-]/g, "");
        if (!TEST_NUMBERS.has(n) && SCH.luhn(n) && SCH.detect(n)) return { refuse: "That card number looks real. Zanboxx is a sandbox for test cards only. Never enter real card data. Use list_test_cards for numbers that work." };
      }
      b.request_id = b.request_id || "mcp_" + crypto.randomBytes(8).toString("hex");
      return api("POST", "/v1/payments", b);
    } },
  { name: "get_payment", title: "Get a payment", annotations: RO, description: "Fetches one transaction by id, including status, authentication and dispute info.", inputSchema: obj({ transaction_id: ID("transaction", "tx_") }, ["transaction_id"]),
    run: (a, api) => api("GET", `/v1/payments/${enc(a.transaction_id)}`) },
  { name: "list_payments", title: "List payments", annotations: RO, description: "Lists recent transactions, newest first.", inputSchema: obj({ limit: { type: "integer", minimum: 1, maximum: 100 }, state: S("Filter by transaction_state, e.g. success, failed, pending") }),
    run: (a, api) => api("GET", "/v1/payments" + qs(a, ["limit", "state"])) },
  { name: "complete_3ds_challenge", title: "Finish a 3-D Secure challenge", annotations: WR, description: "Completes the challenge for a payment that is waiting for 3-D Secure (status SBX-2020).",
    inputSchema: obj({ transaction_id: ID("transaction", "tx_"), result: S("Challenge outcome", { enum: ["approve", "fail"] }) }, ["transaction_id", "result"]),
    run: (a, api) => api("POST", `/v1/payments/${enc(a.transaction_id)}/3ds`, { result: a.result }) },
  { name: "get_3ds_log", title: "Get the 3-D Secure message log", annotations: RO, description: "Returns the annotated 3-D Secure message flow (AReq, ARes, challenge) for a payment, for learning and debugging.", inputSchema: obj({ transaction_id: ID("transaction", "tx_") }, ["transaction_id"]),
    run: (a, api) => api("GET", `/v1/payments/${enc(a.transaction_id)}/3ds-log`) },
  { name: "get_failure_script", title: "Get the failure script", annotations: RO, description: "Shows the active failure-injection rules.", inputSchema: obj({}), run: (a, api) => api("GET", "/v1/script") },
  { name: "set_failure_script", title: "Set the failure script", annotations: WR, description: "Replaces the failure-injection rules (Pro or trial). Example: {rules:[{when:{every:3},then:{outcome:'decline'}}]}.",
    inputSchema: obj({ rules: { type: "array", items: { type: "object" }, description: "Rules with when (nth, every, amount_gte, amount_lte, currency, scheme, initiator) and then (outcome, http_error, latency_ms)" } }, ["rules"]),
    run: (a, api) => api("PUT", "/v1/script", { rules: a.rules }) },
  { name: "clear_failure_script", title: "Clear the failure script", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }, description: "Removes all failure-injection rules.", inputSchema: obj({}), run: (a, api) => api("DELETE", "/v1/script") },
  { name: "list_webhook_deliveries", title: "List webhook deliveries", annotations: RO, description: "Recent webhook deliveries with attempts and status.", inputSchema: obj({}), run: (a, api) => api("GET", "/v1/webhook/deliveries") },
  { name: "replay_webhook_delivery", title: "Replay a webhook delivery", annotations: WR, description: "Sends a stored webhook event to your endpoint again (Pro or trial).", inputSchema: obj({ delivery_id: ID("delivery", "dlv_") }, ["delivery_id"]),
    run: (a, api) => api("POST", `/v1/webhook/deliveries/${enc(a.delivery_id)}/replay`, {}) },
  { name: "create_dispute", title: "Raise a test dispute", annotations: WR, description: "Plays the cardholder's bank and raises a chargeback on a successful card purchase.",
    inputSchema: obj({ transaction_id: ID("transaction", "tx_"), reason: S("Category", { enum: ["fraud", "not_received", "not_as_described", "duplicate"] }), reason_code: S("Scheme reason code, e.g. 10.4 (Visa), 4837 (Mastercard), F29 (Amex)"),
      amount: { type: "number" }, outcome: S("auto, win or lose", { enum: ["auto", "win", "lose"] }), response_window_seconds: { type: "integer", minimum: 1, maximum: 604800 } }, ["transaction_id"]),
    run: (a, api) => { const { transaction_id, ...b } = a; return api("POST", `/v1/payments/${enc(transaction_id)}/dispute`, b); } },
  { name: "list_disputes", title: "List disputes", annotations: RO, description: "Lists disputes, newest first.", inputSchema: obj({ state: S("needs_response, under_review, won or lost"), limit: { type: "integer", minimum: 1, maximum: 100 } }),
    run: (a, api) => api("GET", "/v1/disputes" + qs(a, ["limit", "state"])) },
  { name: "get_dispute", title: "Get a dispute", annotations: RO, description: "One dispute with its required evidence, deadline and history.", inputSchema: obj({ dispute_id: ID("dispute", "dp_") }, ["dispute_id"]),
    run: (a, api) => api("GET", `/v1/disputes/${enc(a.dispute_id)}`) },
  { name: "submit_dispute_evidence", title: "Submit dispute evidence", annotations: WR, description: "Sends evidence once; fields depend on the dispute category (see evidence_requirements in get_dispute).",
    inputSchema: obj({ dispute_id: ID("dispute", "dp_"), evidence: { type: "object", description: "Evidence fields as text, e.g. {customer_ip, customer_email}" } }, ["dispute_id", "evidence"]),
    run: (a, api) => api("POST", `/v1/disputes/${enc(a.dispute_id)}/evidence`, { evidence: a.evidence }) },
  { name: "accept_dispute", title: "Accept a dispute", annotations: WR, description: "Gives up the dispute; the money stays with the cardholder.", inputSchema: obj({ dispute_id: ID("dispute", "dp_") }, ["dispute_id"]),
    run: (a, api) => api("POST", `/v1/disputes/${enc(a.dispute_id)}/accept`, {}) },
  { name: "list_agreements", title: "List card-on-file agreements", annotations: RO, description: "Stored-card agreements for merchant-initiated payments.", inputSchema: obj({ state: S("active or cancelled"), limit: { type: "integer", minimum: 1, maximum: 100 } }),
    run: (a, api) => api("GET", "/v1/agreements" + qs(a, ["limit", "state"])) },
  { name: "cancel_agreement", title: "Cancel an agreement", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }, description: "Cancels a card-on-file agreement; later merchant-initiated payments fail.", inputSchema: obj({ agreement_id: ID("agreement", "agr_") }, ["agreement_id"]),
    run: (a, api) => api("POST", `/v1/agreements/${enc(a.agreement_id)}/cancel`, {}) },
  { name: "close_settlement_day", title: "Close a settlement day", annotations: WR, description: "Batches the day's cleared transactions into a settlement with fictional fees and generates the simulated scheme files.", inputSchema: obj({ date: S("UTC date YYYY-MM-DD, default today") }),
    run: (a, api) => api("POST", "/v1/settlements", a.date ? { date: a.date } : {}) },
  { name: "get_settlement", title: "Get a settlement", annotations: RO, description: "Without settlement_id lists all settlements; with it returns the batch, its records and files.", inputSchema: obj({ settlement_id: ID("settlement", "stl_") }),
    run: (a, api) => api("GET", a.settlement_id ? `/v1/settlements/${enc(a.settlement_id)}` : "/v1/settlements") },
  { name: "reconcile_ledger", title: "Reconcile your ledger", annotations: WR, description: "Compares your own ledger lines with a settlement and reports missing, extra and mismatched items.",
    inputSchema: obj({ settlement_id: ID("settlement", "stl_"), ledger: { type: "array", items: { type: "object" }, description: "Your ledger lines, same shape the REST API expects" } }, ["settlement_id", "ledger"]),
    run: (a, api) => api("POST", `/v1/settlements/${enc(a.settlement_id)}/reconcile`, { ledger: a.ledger }) },
  { name: "get_usage", title: "Get usage and plan", annotations: RO, description: "Plan, monthly payment quota and rate limit.", inputSchema: obj({}), run: (a, api) => api("GET", "/v1/usage") },
  { name: "list_test_cards", title: "List test cards", annotations: RO, description: "Test card numbers per scheme (Visa, Mastercard, Amex) and what each one triggers.", inputSchema: obj({ scheme: S("visa, mastercard or amex", { enum: ["visa", "mastercard", "amex"] }) }),
    run: async (a) => ({ data: SCH.TEST_CARDS.filter((c) => !a.scheme || c.scheme === a.scheme), note: "Sandbox only. CVV: 3 digits (Amex 4). Any future expiry." }) },
  { name: "explain_status_code", title: "Explain a status or response code", annotations: RO, description: "Explains a Zanboxx status code (SBX-xxxx), a 3-D Secure status, or a scheme response code such as 05, 51 or 116.", inputSchema: obj({ code: S("e.g. SBX-4225, 3DS N, 51") }, ["code"]),
    run: async (a) => {
      const c = String(a.code || "").trim(), key = c.toUpperCase().replace(/^3DS[\s:_-]*/, "3DS ");
      if (GLOSSARY[key]) return { code: key, meaning: GLOSSARY[key] };
      const hits = Object.values(SCH.SCHEMES).filter((s) => Object.values(s.responses).some((r) => r.code === c)).map((s) => ({ scheme: s.name, ...Object.values(s.responses).find((r) => r.code === c) }));
      return hits.length ? { code: c, schemes: hits } : { code: c, meaning: "Unknown code. Known: " + Object.keys(GLOSSARY).join(", ") + " and the scheme response codes from list_test_cards." };
    } },
];
const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
const enc = encodeURIComponent;
const qs = (a, keys) => { const p = new URLSearchParams(); for (const k of keys) if (a[k] !== undefined) p.set(k, a[k]); const s = p.toString(); return s ? "?" + s : ""; };
const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } });

// deps: { port(): number, readRaw(req,max), send(res,status,obj,headers), allowedOrigins: string[], authenticate(req): void (throws) }
module.exports = function createMcp({ port, allowedOrigins = [], version = "1.0.0" }) {
  async function callApi(key, method, path, body) {
    const r = await fetch(`http://127.0.0.1:${port()}${path}`, {
      method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "user-agent": "zanboxx-mcp" }, body: body === undefined || method === "GET" ? undefined : JSON.stringify(body),
    });
    const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
    return { ok: r.ok, status: r.status, body: j };
  }
  const clip = (s) => s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n… truncated (${s.length - MAX_OUT} more characters). Narrow the request with limit or a filter.` : s;

  async function callTool(key, name, args) {
    const t = BY_NAME[name];
    if (!t) return null;
    if (args === undefined) args = {};
    if (!args || typeof args !== "object" || Array.isArray(args)) return { isError: true, content: [{ type: "text", text: "arguments must be an object" }] };
    const missing = (t.inputSchema.required || []).filter((k) => args[k] === undefined);
    if (missing.length) return { isError: true, content: [{ type: "text", text: `Missing required argument${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}` }] };
    const unknown = Object.keys(args).filter((k) => !t.inputSchema.properties[k]);
    if (unknown.length) return { isError: true, content: [{ type: "text", text: `Unknown argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Allowed: ${Object.keys(t.inputSchema.properties).join(", ") || "none"}` }] };
    const res = await t.run(args, async (m, p, b) => callApi(key, m, p, b));
    if (res && res.refuse) return { isError: true, content: [{ type: "text", text: res.refuse }] };
    const out = res && "ok" in res && "status" in res && "body" in res ? res : { ok: true, body: res };
    return { isError: !out.ok, content: [{ type: "text", text: clip(JSON.stringify(out.ok ? out.body : { http_status: out.status, ...out.body }, null, 2)) }] };
  }

  async function handleMessage(msg, key) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcErr(msg && msg.id, -32600, "Invalid JSON-RPC request");
    const { id, method, params } = msg, isNote = id === undefined;
    if (isNote) return null; // notifications (initialized, cancelled, ...) need no reply
    switch (method) {
      case "initialize": {
        const want = params && params.protocolVersion;
        return { jsonrpc: "2.0", id, result: {
          protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[0], capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "zanboxx", title: "Zanboxx payment sandbox", version },
          instructions: "Zanboxx is a payment-gateway SANDBOX. Use test cards only (list_test_cards); never real card data. Money is fictional. Typical flow: create_payment, then get_payment; for 3-D Secure cards call complete_3ds_challenge; create_dispute, close_settlement_day and reconcile_ledger teach the back-office side.",
        } };
      }
      case "ping": return { jsonrpc: "2.0", id, result: {} };
      case "tools/list": return { jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) } };
      case "tools/call": {
        if (!params || typeof params.name !== "string") return rpcErr(id, -32602, "params.name is required");
        let r;
        try { r = await callTool(key, params.name, params.arguments); }
        catch (e) { r = { isError: true, content: [{ type: "text", text: "Tool failed: " + String(e.message || e).slice(0, 300) }] }; }
        return r ? { jsonrpc: "2.0", id, result: r } : rpcErr(id, -32602, `Unknown tool: ${params.name}`);
      }
      default: return rpcErr(id, -32601, `Method not found: ${method}`);
    }
  }

  const accepted = (res) => { res.writeHead(202, { "content-length": 0 }); res.end(); };
  // Handles one HTTP request to /mcp. `key` is the already-validated API key.
  async function handle(req, res, { readRaw, send, key }) {
    const body = await readRaw(req, 200000);
    let parsed;
    try { parsed = JSON.parse(body); } catch { return send(res, 400, rpcErr(null, -32700, "Parse error")); }
    if (Array.isArray(parsed)) {
      if (!parsed.length || parsed.length > 20) return send(res, 400, rpcErr(null, -32600, "Batch must hold 1 to 20 messages"));
      const out = (await Promise.all(parsed.map((m) => handleMessage(m, key)))).filter(Boolean);
      return out.length ? send(res, 200, out) : accepted(res);
    }
    const out = await handleMessage(parsed, key);
    return out ? send(res, 200, out) : accepted(res);
  }
  const originOk = (req) => { const o = req.headers.origin; if (!o) return true; if (allowedOrigins.includes("*")) return true; return allowedOrigins.includes(o); };
  return { handle, originOk, TOOLS, GLOSSARY, handleMessage };
};
