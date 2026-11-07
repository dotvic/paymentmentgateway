"use strict";
// POS acquiring and certification lab. A practice run of getting a terminal certified with an acquirer:
// scope the project, get a test account and keys, configure the terminal, run scripted test cases that compare the card-terminal log
// with the network message, then submit for approval. Everything is simulated: made-up keys, made-up rules, test cards only.
// The structure follows the general way acquirers and card schemes certify terminals; the rules and messages here are simplified and invented.
module.exports = function ({ html, ctx, UI, esc }) {
  const crypto = require("crypto"), SCH = require("../schemes");
  const { send, bad, readBody, rnd, save } = ctx;

  const TERMINALS = { pos: "Countertop or handheld POS", mpos: "Mobile POS (phone or tablet reader)", atm: "ATM", cat: "Unattended, cardholder-activated terminal" };
  const CAPS = { chip: "Chip (contact)", contactless: "Contactless", stripe: "Magnetic stripe", fallback: "Stripe fallback after a chip failure", online_pin: "Online PIN", offline_pin: "Offline PIN", signature: "Signature", cashback: "Purchase with cashback", refund: "Refunds", trm: "Terminal risk management" };
  const COUNTRIES = { PL: { cur: "985", name: "Poland" }, DE: { cur: "978", name: "Germany" }, FR: { cur: "978", name: "France" }, NL: { cur: "978", name: "Netherlands" }, GB: { cur: "826", name: "United Kingdom" }, US: { cur: "840", name: "United States" }, AE: { cur: "784", name: "United Arab Emirates" }, SG: { cur: "702", name: "Singapore" } };
  const CAT = { pos: "0", mpos: "9", atm: "0", cat: "1" };   // invented profile: the level the terminal must report for its type
  const HOST_SUPPORTS = ["purchase", "refund", "reversal"];   // what the lab's acquirer host already processes; anything else needs a host certification first
  const MAX_RUNS = 400;

  const stats = (acc) => (acc.acq = acc.acq || { project: null, account: null, config: null, keys: {}, results: {}, loa: [], practice: 0, change_correct: [], submitted: 0 });
  const hex = (n) => crypto.randomBytes(n).toString("hex");
  const kcv = (keyHex) => crypto.createCipheriv("aes-128-ecb", Buffer.from(keyHex, "hex"), null).setAutoPadding(false).update(Buffer.alloc(16)).toString("hex").slice(0, 6).toUpperCase();
  const xor = (a, b) => Buffer.from(a, "hex").map((v, i) => v ^ Buffer.from(b, "hex")[i]).toString("hex");
  const pad = (n, w) => String(n).padStart(w, "0");
  const cents = (n) => Math.round(Number(n) * 100);

  const DEFAULT_CONFIG = () => ({ mcc: "5411", currency: "978", cat_level: "0", send_emv: true, mac_enabled: false, reversal_on_timeout: false, floor_limit: 2500, cashback_enabled: false, key_env: "test" });

  // ----- scope: which certification steps and test cases apply -----
  const CASES = [
    { id: "chip_online", stage: "l3", name: "Chip purchase, approved online", needs: (p) => p.caps.includes("chip"), txn: "purchase", entry: "chip", cvm: "none", amount: 1500 },
    { id: "contactless", stage: "l3", name: "Contactless purchase, approved online", needs: (p) => p.caps.includes("contactless"), txn: "purchase", entry: "contactless", cvm: "none", amount: 1200 },
    { id: "stripe", stage: "l3", name: "Magnetic-stripe purchase", needs: (p) => p.caps.includes("stripe"), txn: "purchase", entry: "stripe", cvm: "signature", amount: 2000 },
    { id: "fallback", stage: "l3", name: "Stripe fallback after a chip failure", needs: (p) => p.caps.includes("fallback") && p.caps.includes("chip") && p.caps.includes("stripe"), txn: "purchase", entry: "fallback", cvm: "signature", amount: 1800 },
    { id: "online_pin", stage: "l3", name: "Purchase verified with online PIN", needs: (p) => p.caps.includes("online_pin"), txn: "purchase", entry: "chip", cvm: "online_pin", amount: 3000 },
    { id: "offline_pin", stage: "l3", name: "Purchase verified with offline PIN", needs: (p) => p.caps.includes("offline_pin") && p.caps.includes("chip"), txn: "purchase", entry: "chip", cvm: "offline_pin", amount: 2200 },
    { id: "signature", stage: "l3", name: "Purchase verified with signature", needs: (p) => p.caps.includes("signature"), txn: "purchase", entry: "chip", cvm: "signature", amount: 1700 },
    { id: "refund", stage: "l3", name: "Refund", needs: (p) => p.caps.includes("refund"), txn: "refund", entry: "chip", cvm: "none", amount: 900 },
    { id: "reversal", stage: "l3", name: "Reversal after a timeout", needs: () => true, txn: "purchase", entry: "chip", cvm: "none", amount: 1000, timeout: true },
    { id: "decline", stage: "l3", name: "Issuer decline is handled correctly", needs: () => true, txn: "purchase", entry: "chip", cvm: "none", amount: 1100, decline: true },
    { id: "trm", stage: "l3", name: "Amount above the floor limit goes online", needs: (p) => p.caps.includes("trm"), txn: "purchase", entry: "chip", cvm: "none", amount: 2600, trm: true },
    { id: "mpos_cat", stage: "l3", name: "Mobile POS reports its terminal level", needs: (p) => p.terminal_type === "mpos", txn: "purchase", entry: "contactless", cvm: "none", amount: 800 },
    { id: "transit_cvm", stage: "l3", name: "Transit merchants: offline verification supported", needs: (p) => ["4111", "4112"].includes(p.mcc), txn: "purchase", entry: "chip", cvm: "offline_pin", amount: 400, scope: true },
    { id: "host_cashback", stage: "host", name: "Host mapping: purchase with cashback", needs: (p) => p.caps.includes("cashback"), txn: "cashback", entry: "chip", cvm: "online_pin", amount: 4000, cashback: 1000 },
    { id: "host_withdrawal", stage: "host", name: "Host mapping: ATM cash withdrawal", needs: (p) => p.terminal_type === "atm", txn: "withdrawal", entry: "chip", cvm: "online_pin", amount: 5000 },
  ];
  const caseById = (id) => CASES.find((c) => c.id === id);
  const txnOf = (c) => (c.txn === "cashback" ? "cashback" : c.txn);

  function scopeOf(p) {
    const cases = CASES.filter((c) => c.needs(p));
    const hostReasons = [];
    if (p.caps.includes("cashback") && !HOST_SUPPORTS.includes("cashback")) hostReasons.push("Purchase with cashback is a transaction type this acquirer host does not process yet");
    if (p.terminal_type === "atm" && !HOST_SUPPORTS.includes("withdrawal")) hostReasons.push("ATM withdrawals are a new terminal and transaction type for this host");
    const gaps = [];
    if (["4111", "4112"].includes(p.mcc) && !(p.caps.includes("offline_pin") && p.caps.includes("signature"))) gaps.push("Transit merchants (MCC 4111 and 4112) need both offline PIN and signature support in this lab's rules");
    return {
      host_certification: { required: hostReasons.length > 0, reasons: hostReasons },
      l1_l2: { required: true, note: "Level 1 (hardware and communication) and Level 2 (payment kernel software) approvals come first, from the card standards body's accredited labs. Level 3 can only be requested for a terminal that already has them." },
      l3: { required: true, per: "scheme and terminal model", runs: p.schemes.length },
      cases: cases.map((c) => ({ id: c.id, stage: c.stage, name: c.name })),
      gaps,
    };
  }

  const cfgHash = (acc) => { const s = stats(acc), p = s.project; if (!p) return null; return crypto.createHash("sha256").update(JSON.stringify([p.terminal_type, p.model, [...p.caps].sort(), [...p.schemes].sort(), p.mcc, p.country, s.config || {}])).digest("hex").slice(0, 12); };
  const passed = (acc, id) => { const s = stats(acc), r = s.results[id]; return !!(r && r.passed && r.config_hash === cfgHash(acc)); };

  // ----- terminal simulation -----
  const testPan = (scheme) => (SCH.TEST_CARDS.find((c) => c.scheme === scheme && c.outcome === "approve") || { number: "4111111111111111" }).number;
  const PROC = { purchase: "000000", cashback: "090000", refund: "200000", withdrawal: "010000" };
  const ENTRY = { chip: "051", contactless: "072", stripe: "902", fallback: "801" };
  const TXN_TYPE = { purchase: "00", cashback: "09", refund: "20", withdrawal: "01" };
  const activeKey = (acc, env) => { const k = stats(acc).keys[env]; return k && k.state === "active" ? k.key : null; };
  const macOf = (key, msg) => { const o = {}; for (const k of Object.keys(msg).sort()) if (k !== "de64") o[k] = msg[k]; return crypto.createHmac("sha256", key || "00".repeat(16)).update(JSON.stringify(o)).digest("hex").slice(0, 16).toUpperCase(); };

  function buildRun(acc, c, scheme, defect) {
    const s = stats(acc), p = s.project, cfg = { ...DEFAULT_CONFIG(), ...(s.config || {}) }, pan = testPan(scheme);
    const total = c.amount, other = c.cashback || 0, authorised = total;           // 9F02 carries the full amount, 9F03 the cashback part
    const cardLog = {
      pan, tag_9f02_amount_authorised: pad(authorised, 12), tag_9f03_amount_other: pad(other, 12), tag_9c_transaction_type: TXN_TYPE[c.txn], tag_5f2a_currency: COUNTRIES[p.country].cur,
      entry: c.entry, cvm: c.cvm, tag_9f26_cryptogram: c.entry === "stripe" || c.entry === "fallback" ? null : hex(8).toUpperCase(),
      first_generate_ac: c.entry === "stripe" || c.entry === "fallback" ? "n/a (no chip)" : "ARQC (go online)",
    };
    const declined = !!c.decline;
    const stan = pad(Math.floor(Math.random() * 999999), 6);
    const msg = { mti: "0200", de2: pan, de3: PROC[c.txn], de4: pad(authorised, 12), de11: stan, de18: cfg.mcc, de22: ENTRY[c.entry], de25: "00", de41: (s.account || {}).tid, de42: (s.account || {}).mid, de49: cfg.currency, de61_cat_level: cfg.cat_level };
    if (c.txn === "cashback" && cfg.cashback_enabled) msg.de54_additional_amount = pad(other, 12);
    if (c.cvm === "online_pin") msg.de52_pin_block = hex(8).toUpperCase();
    if (cardLog.tag_9f26_cryptogram && cfg.send_emv) msg.de55_emv_data = "9F26" + cardLog.tag_9f26_cryptogram + "9F02" + cardLog.tag_9f02_amount_authorised;
    const terminalSkipsCashback = c.txn === "cashback" && !cfg.cashback_enabled;
    const key = activeKey(acc, cfg.key_env === "prod" ? "prod" : "test");
    if (defect === "entry_mode") msg.de22 = "012";
    if (defect === "emv_missing") delete msg.de55_emv_data;
    if (defect === "amount") msg.de4 = pad(authorised + 100, 12);
    if (defect === "mcc") msg.de18 = "5999";
    if (defect === "tid") msg.de41 = "00000000";
    if (defect === "currency") msg.de49 = p.country === "US" ? "978" : "840";
    if (defect === "pin") delete msg.de52_pin_block;
    if (cfg.mac_enabled) msg.de64 = macOf(key, msg);
    if (defect === "mac" && msg.de64) msg.de64 = "DEADBEEF" + msg.de64.slice(8);
    const reversalSent = c.timeout ? !!cfg.reversal_on_timeout && defect !== "no_reversal" : null;
    return { cardLog, msg, cfg, declined, terminalSkipsCashback, reversalSent, key };
  }

  function validate(acc, c, run) {
    const s = stats(acc), p = s.project, { cardLog, msg, cfg, declined } = run, out = [];
    const chk = (name, ok, expected, actual, hint) => out.push({ name, ok: !!ok, expected, actual: actual === undefined ? "(missing)" : actual, hint: ok ? "" : hint });
    chk("Terminal and merchant IDs match your test account", msg.de41 === s.account.tid && msg.de42 === s.account.mid, `${s.account.tid} / ${s.account.mid}`, `${msg.de41} / ${msg.de42}`, "DE41 is the terminal ID and DE42 the merchant ID. They must be the ones issued for this test account.");
    chk("Amount in the message equals the amount on the card", msg.de4 === cardLog.tag_9f02_amount_authorised, cardLog.tag_9f02_amount_authorised, msg.de4, "DE4 must carry the same amount the card approved (tag 9F02). Fees or rounding added by the terminal break the cryptogram check at the issuer.");
    chk("Processing code matches the transaction type", msg.de3 === PROC[c.txn], PROC[c.txn], msg.de3, "DE3 tells the host what kind of transaction this is (purchase, cashback, refund, withdrawal). It must agree with tag 9C on the card.");
    chk("POS entry mode matches how the card was read", msg.de22 === ENTRY[c.entry], ENTRY[c.entry], msg.de22, "DE22 says how the card data was captured (chip, contactless, stripe, fallback). A wrong value changes liability and fraud rules.");
    if (c.entry === "stripe" || c.entry === "fallback") chk("No chip data on a stripe transaction", msg.de55_emv_data === undefined, "no DE55", msg.de55_emv_data ? "DE55 present" : "no DE55", "Stripe transactions carry no chip data.");
    else chk("Chip data (DE55) is sent and carries the card's cryptogram", !!msg.de55_emv_data && msg.de55_emv_data.includes(cardLog.tag_9f26_cryptogram), "DE55 with tag 9F26", msg.de55_emv_data ? "present" : "missing", "The issuer needs the chip data to verify the cryptogram. Turn on 'send chip data' in the terminal profile.");
    chk("Merchant category matches the project", msg.de18 === p.mcc, p.mcc, msg.de18, "DE18 must be the merchant category you declared in scoping. Set it in the terminal profile.");
    chk("Currency matches the country of deployment", msg.de49 === COUNTRIES[p.country].cur, COUNTRIES[p.country].cur, msg.de49, `Use the numeric currency for ${COUNTRIES[p.country].name} in the terminal profile.`);
    chk("Terminal level (CAT) is right for the terminal type", msg.de61_cat_level === CAT[p.terminal_type], CAT[p.terminal_type], msg.de61_cat_level, "Each terminal type reports a level in the point-of-service data. A mobile POS must not look like a countertop terminal.");
    chk("PIN block is sent only for online PIN", c.cvm === "online_pin" ? !!msg.de52_pin_block : !msg.de52_pin_block, c.cvm === "online_pin" ? "DE52 present" : "no DE52", msg.de52_pin_block ? "DE52 present" : "no DE52", "An online PIN must travel encrypted in DE52, and a PIN block must not be sent when another method verified the cardholder.");
    const key = run.key, expectedMac = key ? macOf(key, msg) : null;
    chk("Message authentication code (MAC) is valid", cfg.mac_enabled && !!key && msg.de64 === expectedMac, "valid MAC from the loaded key", !cfg.mac_enabled ? "no MAC sent" : !key ? `no ${cfg.key_env} key loaded` : msg.de64 === expectedMac ? "valid" : "does not verify", !cfg.mac_enabled ? "This acquirer requires a MAC on every message. Turn MAC on in the terminal profile." : !key ? `No active ${cfg.key_env} key. Do the key ceremony for that environment first, and make sure the profile uses the environment you are testing.` : "The MAC does not verify, so the host cannot trust the message was not altered. Check that both sides hold the same key.");
    if (c.txn === "cashback") { chk("Cashback amount is carried separately (DE54) and in tag 9F03", !run.terminalSkipsCashback && msg.de54_additional_amount === cardLog.tag_9f03_amount_other, cardLog.tag_9f03_amount_other, msg.de54_additional_amount, "Enable cashback in the terminal profile. The total goes in DE4, the cashback part in DE54."); }
    if (c.txn === "withdrawal") chk("Withdrawal needs an online PIN", !!msg.de52_pin_block, "DE52 present", msg.de52_pin_block ? "present" : "missing", "Cash withdrawals always verify the PIN online.");
    if (c.timeout) chk("Terminal sends a reversal after the host does not answer", !!run.reversalSent, "0400 reversal sent", run.reversalSent ? "reversal sent" : "none sent", "When no answer arrives the money may have been held. The terminal must send a reversal. Turn on 'reverse on timeout' in the terminal profile.");
    if (c.trm) chk("Floor limit forces this amount online", cfg.floor_limit === 0, "floor limit 0", String(cfg.floor_limit), "This acquirer profile wants every chip payment authorised online, so the floor limit must be 0.");
    if (declined) chk("Terminal ends a declined payment with AAC (no approval)", true, "second GENERATE AC = AAC", "AAC");
    if (c.scope) chk("Terminal supports offline PIN and signature", p.caps.includes("offline_pin") && p.caps.includes("signature"), "both supported", `${p.caps.includes("offline_pin") ? "offline PIN" : "no offline PIN"} / ${p.caps.includes("signature") ? "signature" : "no signature"}`, "For this merchant category the terminal has to support both. Change the capabilities in scoping.");
    return out;
  }

  function execute(acc, c, scheme, defect) {
    const run = buildRun(acc, c, scheme, defect), checks = validate(acc, c, run), ok = checks.every((x) => x.ok);
    const log = { entry_time: new Date().toISOString(), scheme };
    return { case_id: c.id, name: c.name, scheme, defect: defect || null, passed: ok, checks, card_terminal_log: run.cardLog, network_message: run.msg, host_response: { mti: "0210", de39: run.declined ? "05" : "00", meaning: run.declined ? "do not honour (issuer decline)" : "approved" }, ...log };
  }

  // ----- recertification trainer -----
  const CHANGES = [
    { id: "ch1", text: "You launch your terminal with a card scheme you have never run before.", host: true, l3: true, l1l2: false, why: "A new scheme means a new interface between your acquirer host and that scheme (host certification), and the terminal must be certified with that scheme (Level 3). The kernel and hardware are unchanged, so no new Level 1 or 2 approval." },
    { id: "ch2", text: "You add refunds to the terminal app. The acquirer host already processes refunds.", host: false, l3: true, l1l2: false, why: "Adding a function that changes the transaction flow needs Level 3 again. The host already supports refunds and the kernel did not change." },
    { id: "ch3", text: "You upgrade the payment kernel (the Level 2 software) on the terminal.", host: false, l3: true, l1l2: true, why: "A changed kernel needs a new Level 2 approval, and a deployment built on it needs Level 3 again." },
    { id: "ch4", text: "You change the wording and logo on the receipt. Nothing else changes.", host: false, l3: false, l1l2: false, why: "Cosmetic changes outside the payment flow do not alter the message or the EMV flow, so no certification is repeated." },
    { id: "ch5", text: "Your acquirer starts accepting purchase with cashback, which it never processed before, and you will sell it.", host: true, l3: true, l1l2: false, why: "A transaction type the host has never carried needs host certification, and the terminal needs Level 3 to prove it sends it correctly." },
    { id: "ch6", text: "A payment facilitator now routes your terminals through its own host before the acquirer.", host: false, l3: true, l1l2: false, why: "The connection between terminal and acquirer changes, which is what Level 3 tests. The acquirer-to-scheme interface is the same." },
    { id: "ch7", text: "You ship the same app on a different hardware model.", host: false, l3: true, l1l2: true, why: "New hardware needs its own Level 1 and Level 2 approvals, and Level 3 is per terminal model." },
    { id: "ch8", text: "The acquirer changes how its host maps terminal fields into the scheme message.", host: true, l3: true, l1l2: false, why: "That mapping is what host certification validates, and it also changes what terminals must send, so Level 3 is repeated." },
  ];

  function timeline(q) {
    const n = (k, d, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(+q[k]) && q[k] !== "" && q[k] !== undefined ? Math.floor(+q[k]) : d));
    const schemes = n("schemes", 2, 1, 7), models = n("models", 1, 1, 10), iterations = n("iterations", 1, 1, 5), impl = n("impl_weeks", 8, 1, 52), host = q.host === true || q.host === "true";
    const l3Min = schemes * models * (2 * iterations + 1), l3Max = schemes * models * (2 * iterations + 2);
    const phases = [
      { name: "Scoping", weeks: [1, 2] }, { name: "Implementation and setup (once)", weeks: [impl, impl] }, { name: "Integration testing and pre-certification", weeks: [4, 4] },
      ...(host ? [{ name: "Host certification (assumed)", weeks: [3, 4] }] : []),
      { name: `Level 3 certification: ${schemes} scheme(s) x ${models} model(s), ${iterations} iteration(s) each, plus review`, weeks: [l3Min, l3Max] },
    ];
    const lo = phases.reduce((a, x) => a + x.weeks[0], 0), hi = phases.reduce((a, x) => a + x.weeks[1], 0);
    return { inputs: { schemes, models, iterations, impl_weeks: impl, host }, phases, total_weeks: [lo, hi], note: "Illustrative planning figures: roughly two weeks per test iteration and one to two weeks of review, repeated for every scheme and every terminal model. Real projects depend on the acquirer, the scheme and your own implementation." };
  }

  // ----- state views -----
  function view(acc) {
    const s = stats(acc), p = s.project, hash = cfgHash(acc), scope = p ? scopeOf(p) : null;
    const keys = {}; for (const env of ["test", "prod"]) { const k = s.keys[env]; keys[env] = !k ? { state: "none" } : { state: k.state, kcv: k.kcv || null, loaded: k.loaded || {}, components: k.state === "issued" ? Object.fromEntries(Object.entries(k.comps).map(([part, c]) => [part, { check_value: c.kcv }])) : undefined }; }
    const caseState = scope ? scope.cases.map((c) => { const r = s.results[c.id]; return { ...c, passed: passed(acc, c.id), last_run: r ? { passed: r.passed, at: r.at, stale: r.config_hash !== hash } : null }; }) : [];
    const loaOk = s.loa.length > 0 && s.loa.every((l) => l.config_hash === hash);
    return {
      terminal_types: TERMINALS, capabilities: CAPS, countries: Object.fromEntries(Object.entries(COUNTRIES).map(([k, v]) => [k, v.name])), schemes: Object.keys(SCH.SCHEMES),
      project: p, scope, account: s.account, config: p ? { ...DEFAULT_CONFIG(), ...(s.config || {}) } : null, config_hash: hash, keys, cases: caseState, loa: s.loa, loa_valid: loaOk,
      readiness: p ? [
        { item: "Project scoped", done: true },
        { item: "Level 1 and 2 approvals declared", done: !!(p.l1 && p.l2) },
        { item: "Test account (merchant and terminal ID) issued", done: !!s.account },
        { item: "Test keys loaded (key ceremony)", done: keys.test.state === "active" },
        { item: "All test cases pass with the current profile", done: caseState.length > 0 && caseState.every((c) => c.passed) },
        { item: "Approval letters issued and still valid for this profile", done: loaOk },
        { item: "Production keys loaded (a separate ceremony)", done: keys.prod.state === "active" },
      ] : [],
      stats: { practice_runs: s.practice, change_scenarios_correct: s.change_correct.length, submissions: s.submitted },
    };
  }

  const bool = (v, name) => { if (typeof v !== "boolean") throw bad(400, "invalid_request", `${name} must be true or false`); return v; };

  function page() {
    const body = `<style>.q td,.q th{padding:5px 8px;border-bottom:1px solid var(--line,#ddd);text-align:left;vertical-align:top;font-size:14px}.q table{border-collapse:collapse;width:100%}.ok{color:#14803c}.no{color:#b42318}.q select,.q input[type=text],.q input[type=number]{width:auto;display:inline-block}.mono{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;white-space:pre-wrap;word-break:break-all}.cap{display:inline-block;margin:2px 10px 2px 0}</style>
<div class="crumbs"><a href="/labs">Payment Labs</a> / POS acquiring and certification</div><h1>POS acquiring and certification lab</h1>
<p class="lede">Before a terminal can take real payments through an acquirer, it is tested end to end. You are the integrator. Scope the project, get a test account and keys, set up the terminal, run the test cases, find the mismatches between what the card and terminal did and what the network saw, then submit for an approval letter. Everything here is simulated with made-up keys and simplified rules. Test cards only.</p>
<div class="panel q"><strong>The pieces</strong><p class="hint"><strong>Acquirer host certification</strong> checks the interface between the acquirer and each card scheme (the messages and their data elements). <strong>Level 1 and 2</strong> approve the terminal hardware and its payment kernel, once, by an accredited lab. <strong>Level 3</strong> checks one terminal deployment against one acquirer, per scheme and per terminal model, comparing the card-terminal log with the network log.</p></div>
<div class="panel q" id="p1"><strong>1. Scope the project</strong>
<p>Terminal type <select id="tt"></select> Model name <input type="text" id="md" size="14" value="Model A"> Country <select id="co"></select> Merchant category (MCC) <input type="text" id="mc" size="5" value="5411"></p>
<p id="caps"></p><p id="sch"></p><p><label><input type="checkbox" id="l1"> Level 1 approval letter in hand</label> <label><input type="checkbox" id="l2"> Level 2 approval letter in hand</label></p>
<p><button class="primary" type="button" id="save1">Save scope</button> <span id="m1" class="hint"></span></p><div id="scope" class="hint"></div></div>
<div class="panel q"><strong>2. Test account and keys</strong>
<p><button type="button" id="acct" class="small">Get test merchant and terminal ID</button> <span id="acctv" class="hint"></span></p>
<p class="hint">Online PIN and message authentication need shared keys. Two custodians each get one half (a <em>component</em>) with a check value, enter them separately, and the system combines them. Test and production use separate ceremonies. The lab keys are random and fictional.</p>
<p><select id="env"><option>test</option><option>prod</option></select> <button type="button" id="kstart" class="small">Start key ceremony</button> <span id="kinfo" class="hint"></span></p>
<p>Component <select id="part"><option value="a">A (custodian 1)</option><option value="b">B (custodian 2)</option></select> value <input type="text" id="kval" size="34" placeholder="32 hex characters"> check value <input type="text" id="kkcv" size="7"> <button type="button" id="kload" class="small">Load component</button></p><p id="kmsg" class="hint"></p></div>
<div class="panel q"><strong>3. Terminal profile</strong><p class="hint">The profile is how the terminal is set up. It starts with ordinary defaults that will not all pass. Any change here means the tests must be run again, because certification applies to one specific configuration.</p>
<p>MCC sent <input type="text" id="cm" size="5"> Currency (numeric) <input type="text" id="cc" size="5"> Terminal level <input type="text" id="cl" size="3"> Floor limit (cents) <input type="number" id="fl" style="width:90px"></p>
<p><label class="cap"><input type="checkbox" id="se"> send chip data</label><label class="cap"><input type="checkbox" id="me"> add a MAC to messages</label><label class="cap"><input type="checkbox" id="rv"> reverse on timeout</label><label class="cap"><input type="checkbox" id="cb"> cashback enabled</label> Key environment <select id="ke"><option>test</option><option>prod</option></select></p>
<p><button class="primary" type="button" id="save3">Save profile</button> <span id="m3" class="hint"></span></p></div>
<div class="panel q"><strong>4. Run the test cases</strong><p>Scheme <select id="rs"></select> Practice defect <select id="df"><option value="">none (a real attempt)</option><option value="entry_mode">wrong POS entry mode</option><option value="emv_missing">chip data missing</option><option value="amount">amount differs from the card</option><option value="mcc">wrong merchant category</option><option value="tid">wrong terminal ID</option><option value="currency">wrong currency</option><option value="mac">corrupt MAC</option><option value="pin">PIN block missing</option><option value="no_reversal">no reversal after timeout</option></select> <button class="primary" type="button" id="runall">Run all</button></p>
<div id="cases"></div><div id="detail" class="q"></div></div>
<div class="panel q"><strong>5. Submit for approval</strong><p><button class="primary" type="button" id="sub">Submit results</button> <span id="m5" class="hint"></span></p><div id="ready"></div><div id="loa"></div></div>
<div class="panel q"><strong>6. When must you certify again?</strong><p class="hint">For each change, say which certifications must be repeated.</p><div id="chg"></div></div>
<div class="panel q"><strong>7. How long will it take?</strong><p>Schemes <input type="number" id="ts" value="2" style="width:60px"> Terminal models <input type="number" id="tm" value="1" style="width:60px"> Test iterations <input type="number" id="ti" value="1" style="width:60px"> Implementation weeks <input type="number" id="tw" value="8" style="width:70px"> <label><input type="checkbox" id="th"> host certification needed</label> <button type="button" class="small" id="tgo">Estimate</button></p><div id="tl" class="hint"></div></div>
<p class="hint">Related: <a href="/knowledge/pos-acquiring-and-certification">POS acquiring and certification guide</a>, <a href="/academy/pos-acquiring">POS acquiring course</a>, <a href="/labs">card-present POS and ATM labs</a>.</p>`;
    const script = `var S=null;function $(i){return document.getElementById(i);}
function opts(o,sel){return Object.keys(o).map(function(k){return '<option value="'+Z.esc(k)+'"'+(k===sel?' selected':'')+'>'+Z.esc(o[k])+'</option>';}).join('');}
async function load(){if(!(await Z.ensureKey()))return;var r=await Z.api("GET","/v1/acquiring");if(r.status!==200)return;S=r.body;draw();}
function draw(){var p=S.project||{};$("tt").innerHTML=opts(S.terminal_types,p.terminal_type);$("co").innerHTML=opts(S.countries,p.country||"PL");
$("caps").innerHTML=Object.keys(S.capabilities).map(function(k){return '<label class="cap"><input type="checkbox" data-cap="'+k+'"'+((p.caps||["chip","contactless","online_pin","refund"]).indexOf(k)>=0?' checked':'')+'> '+Z.esc(S.capabilities[k])+'</label>';}).join("");
$("sch").innerHTML="Schemes: "+S.schemes.map(function(k){return '<label class="cap"><input type="checkbox" data-sch="'+k+'"'+((p.schemes||[S.schemes[0]]).indexOf(k)>=0?' checked':'')+'> '+Z.esc(k)+'</label>';}).join("");
if(p.model){$("md").value=p.model;$("mc").value=p.mcc;$("l1").checked=!!p.l1;$("l2").checked=!!p.l2;}
var sc=S.scope;$("scope").innerHTML=sc?'<p><strong>Host certification:</strong> '+(sc.host_certification.required?'required. '+Z.esc(sc.host_certification.reasons.join('; ')):'not needed.')+'</p><p><strong>Level 1 and 2:</strong> '+Z.esc(sc.l1_l2.note)+'</p><p><strong>Level 3:</strong> '+sc.l3.runs+' run(s), one per scheme for this terminal model. '+sc.cases.length+' test cases apply.</p>'+(sc.gaps.length?'<p class="no">'+Z.esc(sc.gaps.join(' '))+'</p>':''):'';
$("acctv").textContent=S.account?"MID "+S.account.mid+" · TID "+S.account.tid:"";
["test","prod"].forEach(function(e){});var k=S.keys[$("env").value]||{state:"none"};$("kinfo").innerHTML=k.state==="active"?"Key active, check value "+Z.esc(k.kcv):k.state==="issued"&&k.components?"Components issued. Check values: A "+Z.esc(k.components.a.check_value)+", B "+Z.esc(k.components.b.check_value):"No ceremony yet.";
var c=S.config;if(c){$("cm").value=c.mcc;$("cc").value=c.currency;$("cl").value=c.cat_level;$("fl").value=c.floor_limit;$("se").checked=c.send_emv;$("me").checked=c.mac_enabled;$("rv").checked=c.reversal_on_timeout;$("cb").checked=c.cashback_enabled;$("ke").value=c.key_env;}
$("rs").innerHTML=(p.schemes||[]).map(function(k){return "<option>"+Z.esc(k)+"</option>";}).join("");
$("cases").innerHTML='<table><tr><th>Stage</th><th>Test case</th><th>Result</th><th></th></tr>'+S.cases.map(function(x){return '<tr><td>'+Z.esc(x.stage==="host"?"host":"L3")+'</td><td>'+Z.esc(x.name)+'</td><td>'+(x.passed?'<span class="ok">passed</span>':x.last_run?(x.last_run.stale?'<span class="hint">stale (profile changed)</span>':'<span class="no">failed</span>'):'<span class="hint">not run</span>')+'</td><td><button type="button" class="small" data-run="'+x.id+'">Run</button></td></tr>';}).join("")+'</table>';
document.querySelectorAll("[data-run]").forEach(function(b){b.onclick=function(){run(b.getAttribute("data-run"));};});
$("ready").innerHTML=S.readiness.length?'<ul>'+S.readiness.map(function(x){return '<li class="'+(x.done?'ok':'')+'">'+(x.done?'done: ':'to do: ')+Z.esc(x.item)+'</li>';}).join("")+'</ul>':"";
$("loa").innerHTML=S.loa.length?'<p><strong>Approval letters</strong> '+(S.loa_valid?'':'<span class="no">(no longer valid: the profile changed, certify again)</span>')+'</p><ul>'+S.loa.map(function(l){return '<li>'+Z.esc(l.id)+' · '+Z.esc(l.scheme)+' · '+Z.esc(l.model)+' · profile '+Z.esc(l.config_hash)+'</li>';}).join("")+'</ul>':"";}
$("save1").onclick=async function(){var caps=[].slice.call(document.querySelectorAll("[data-cap]:checked")).map(function(e){return e.getAttribute("data-cap");}),sch=[].slice.call(document.querySelectorAll("[data-sch]:checked")).map(function(e){return e.getAttribute("data-sch");});
var r=await Z.api("PUT","/v1/acquiring/project",{terminal_type:$("tt").value,model:$("md").value,country:$("co").value,mcc:$("mc").value,caps:caps,schemes:sch,l1:$("l1").checked,l2:$("l2").checked});$("m1").textContent=r.status===200?"Saved.":Z.msg(r);await load();};
$("acct").onclick=async function(){var r=await Z.api("POST","/v1/acquiring/account");if(r.status!==200&&r.status!==201)$("kmsg").textContent=Z.msg(r);await load();};
$("env").onchange=draw;
$("kstart").onclick=async function(){var r=await Z.api("POST","/v1/acquiring/keys/"+$("env").value+"/start");if(r.status===200){$("kmsg").innerHTML="Two components issued. In real life each custodian receives only one. Component A: <span class='mono'>"+Z.esc(r.body.components.a.value)+"</span> check "+Z.esc(r.body.components.a.check_value)+" · Component B: <span class='mono'>"+Z.esc(r.body.components.b.value)+"</span> check "+Z.esc(r.body.components.b.check_value);}else $("kmsg").textContent=Z.msg(r);await load();};
$("kload").onclick=async function(){var r=await Z.api("POST","/v1/acquiring/keys/"+$("env").value+"/load",{part:$("part").value,value:$("kval").value,check_value:$("kkcv").value});$("kmsg").textContent=r.status===200?(r.body.state==="active"?"Both components loaded. Key active, check value "+r.body.check_value+".":"Component "+$("part").value.toUpperCase()+" accepted. Load the other one."):Z.msg(r);await load();};
$("save3").onclick=async function(){var r=await Z.api("PUT","/v1/acquiring/config",{mcc:$("cm").value,currency:$("cc").value,cat_level:$("cl").value,floor_limit:+$("fl").value,send_emv:$("se").checked,mac_enabled:$("me").checked,reversal_on_timeout:$("rv").checked,cashback_enabled:$("cb").checked,key_env:$("ke").value});$("m3").textContent=r.status===200?"Saved. Earlier results are now stale.":Z.msg(r);await load();};
function showRun(x){var h='<h3>'+Z.esc(x.name)+' · '+(x.passed?'<span class="ok">passed</span>':'<span class="no">failed</span>')+(x.defect?' <span class="hint">(practice: '+Z.esc(x.defect)+' injected, not counted)</span>':'')+'</h3><table><tr><th></th><th>Check</th><th>Expected</th><th>Actual</th></tr>'+x.checks.map(function(c){return '<tr><td class="'+(c.ok?'ok':'no')+'">'+(c.ok?'pass':'FAIL')+'</td><td>'+Z.esc(c.name)+(c.ok?'':'<br><span class="hint">'+Z.esc(c.hint)+'</span>')+'</td><td class="mono">'+Z.esc(c.expected)+'</td><td class="mono">'+Z.esc(c.actual)+'</td></tr>';}).join("")+'</table><p class="hint">Card-terminal log</p><div class="mono">'+Z.esc(JSON.stringify(x.card_terminal_log,null,1))+'</div><p class="hint">Network message (terminal to host) and host reply</p><div class="mono">'+Z.esc(JSON.stringify(x.network_message,null,1))+'\\n'+Z.esc(JSON.stringify(x.host_response))+'</div>';$("detail").innerHTML=h;}
async function run(id){var r=await Z.api("POST","/v1/acquiring/tests/"+id+"/run",{scheme:$("rs").value,defect:$("df").value||undefined});if(r.status===200){showRun(r.body.run);}else $("detail").innerHTML='<p class="no">'+Z.esc(Z.msg(r))+'</p>';await load();}
$("runall").onclick=async function(){var r=await Z.api("POST","/v1/acquiring/tests/run-all",{scheme:$("rs").value});if(r.status===200){$("detail").innerHTML='<p>'+r.body.passed+' of '+r.body.total+' passed. Open a case with Run to see why one failed.</p>';}else $("detail").innerHTML='<p class="no">'+Z.esc(Z.msg(r))+'</p>';await load();};
$("sub").onclick=async function(){var r=await Z.api("POST","/v1/acquiring/submit");$("m5").textContent=r.status===200?"Approved (simulated review). Letters issued.":Z.msg(r);await load();};
async function chg(){var r=await Z.api("GET","/v1/acquiring/changes");if(r.status!==200)return;$("chg").innerHTML=r.body.data.map(function(c){return '<div style="margin:8px 0"><div>'+Z.esc(c.text)+(c.answered?' <span class="ok">(answered correctly)</span>':'')+'</div><label class="cap"><input type="checkbox" id="'+c.id+'h"> host certification</label><label class="cap"><input type="checkbox" id="'+c.id+'k"> Level 1/2 again</label><label class="cap"><input type="checkbox" id="'+c.id+'l"> Level 3 again</label><button type="button" class="small" data-ch="'+c.id+'">Check</button><div class="hint" id="'+c.id+'r"></div></div>';}).join("");
document.querySelectorAll("[data-ch]").forEach(function(b){b.onclick=async function(){var id=b.getAttribute("data-ch");var r=await Z.api("POST","/v1/acquiring/changes/"+id+"/answer",{host:$(id+"h").checked,l1l2:$(id+"k").checked,l3:$(id+"l").checked});$(id+"r").textContent=r.status===200?(r.body.correct?"Correct. ":"Not quite. ")+r.body.why:Z.msg(r);};});}
$("tgo").onclick=async function(){var r=await Z.api("GET","/v1/acquiring/timeline?schemes="+$("ts").value+"&models="+$("tm").value+"&iterations="+$("ti").value+"&impl_weeks="+$("tw").value+"&host="+$("th").checked);if(r.status!==200){$("tl").textContent=Z.msg(r);return;}var b=r.body;$("tl").innerHTML='<ul>'+b.phases.map(function(x){return '<li>'+Z.esc(x.name)+': '+(x.weeks[0]===x.weeks[1]?x.weeks[0]:x.weeks[0]+' to '+x.weeks[1])+' weeks</li>';}).join("")+'</ul><p><strong>Total: '+b.total_weeks[0]+' to '+b.total_weeks[1]+' weeks.</strong> '+Z.esc(b.note)+'</p>';};
load();chg();`;
    return UI.shell({ title: "POS acquiring and certification lab – Zanboxx", description: "Practise getting a payment terminal certified with an acquirer: scope, keys, test cases, log checks and approval.", active: "labs", body, script });
  }

  return {
    async handle(req, res, path, m) {
      if (m === "GET" && path === "/labs/acquiring") { html(res, 200, page()); return true; }
      if (!path.startsWith("/v1/acquiring")) return false;
      const acc = ctx.authed(req), s = stats(acc), url = new URL(req.url, "http://x"); let mt;
      const needProject = () => { if (!s.project) throw bad(409, "no_project", "Scope your project first (step 1)."); return s.project; };
      if (m === "GET" && path === "/v1/acquiring") { send(res, 200, view(acc)); return true; }
      if (m === "GET" && path === "/v1/acquiring/timeline") { send(res, 200, timeline(Object.fromEntries(url.searchParams))); return true; }
      if (m === "PUT" && path === "/v1/acquiring/project") {
        const b = (await readBody(req)) || {};
        if (!TERMINALS[b.terminal_type]) throw bad(400, "invalid_request", "terminal_type must be one of " + Object.keys(TERMINALS).join(", "));
        if (!COUNTRIES[b.country]) throw bad(400, "invalid_request", "country must be one of " + Object.keys(COUNTRIES).join(", "));
        if (!/^\d{4}$/.test(String(b.mcc))) throw bad(400, "invalid_request", "mcc must be four digits");
        const model = String(b.model || "").trim(); if (!/^[A-Za-z0-9 ._-]{1,40}$/.test(model)) throw bad(400, "invalid_request", "model must be 1 to 40 letters, digits, spaces, . _ -");
        if (!Array.isArray(b.caps) || b.caps.some((c) => !CAPS[c])) throw bad(400, "invalid_request", "caps must be a list of: " + Object.keys(CAPS).join(", "));
        if (!Array.isArray(b.schemes) || !b.schemes.length || b.schemes.some((x) => !SCH.SCHEMES[x])) throw bad(400, "invalid_request", "schemes must be a non-empty list of: " + Object.keys(SCH.SCHEMES).join(", "));
        const caps = [...new Set(b.caps)], schemes = [...new Set(b.schemes)];
        if (!caps.some((c) => ["chip", "contactless", "stripe"].includes(c))) throw bad(400, "invalid_request", "The terminal must read cards: choose chip, contactless or magnetic stripe");
        if (b.terminal_type === "atm" && !caps.includes("online_pin")) throw bad(400, "invalid_request", "An ATM needs online PIN");
        s.project = { terminal_type: b.terminal_type, model, country: b.country, mcc: String(b.mcc), caps, schemes, l1: b.l1 === true, l2: b.l2 === true };
        s.config = s.config || DEFAULT_CONFIG(); save(acc); send(res, 200, view(acc)); return true;
      }
      if (m === "PUT" && path === "/v1/acquiring/config") {
        needProject(); const b = (await readBody(req)) || {}, c = { ...DEFAULT_CONFIG(), ...(s.config || {}) };
        if (b.mcc !== undefined) { if (!/^\d{4}$/.test(String(b.mcc))) throw bad(400, "invalid_request", "mcc must be four digits"); c.mcc = String(b.mcc); }
        if (b.currency !== undefined) { if (!/^\d{3}$/.test(String(b.currency))) throw bad(400, "invalid_request", "currency must be a 3-digit numeric code"); c.currency = String(b.currency); }
        if (b.cat_level !== undefined) { if (!/^\d$/.test(String(b.cat_level))) throw bad(400, "invalid_request", "cat_level must be one digit"); c.cat_level = String(b.cat_level); }
        if (b.floor_limit !== undefined) { if (!Number.isInteger(b.floor_limit) || b.floor_limit < 0 || b.floor_limit > 100000) throw bad(400, "invalid_request", "floor_limit must be a whole number of cents from 0 to 100000"); c.floor_limit = b.floor_limit; }
        for (const k of ["send_emv", "mac_enabled", "reversal_on_timeout", "cashback_enabled"]) if (b[k] !== undefined) c[k] = bool(b[k], k);
        if (b.key_env !== undefined) { if (!["test", "prod"].includes(b.key_env)) throw bad(400, "invalid_request", "key_env must be test or prod"); c.key_env = b.key_env; }
        s.config = c; save(acc); send(res, 200, view(acc)); return true;
      }
      if (m === "POST" && path === "/v1/acquiring/account") {
        needProject(); const created = !s.account;
        if (!s.account) s.account = { mid: "9" + pad(crypto.randomBytes(6).readUIntBE(0, 6) % 1e14, 14), tid: pad(crypto.randomBytes(4).readUInt32BE() % 1e8, 8) };
        save(acc); send(res, created ? 201 : 200, { account: s.account }); return true;
      }
      if ((mt = path.match(/^\/v1\/acquiring\/keys\/(test|prod)\/(start|load)$/)) && m === "POST") {
        needProject(); const env = mt[1];
        if (mt[2] === "start") {
          const comps = { a: { value: hex(16) }, b: { value: hex(16) } }; for (const k of Object.keys(comps)) comps[k].kcv = kcv(comps[k].value);
          s.keys[env] = { state: "issued", comps, loaded: {} }; save(acc);
          send(res, 200, { env, components: { a: { value: comps.a.value, check_value: comps.a.kcv }, b: { value: comps.b.value, check_value: comps.b.kcv } }, note: "Lab keys only. In real life each custodian receives one component separately and nobody sees both." }); return true;
        }
        const k = s.keys[env]; if (!k || k.state !== "issued") throw bad(409, "no_ceremony", "Start a key ceremony for this environment first.");
        const b = (await readBody(req)) || {}, part = b.part, val = String(b.value || "").trim().toLowerCase(), given = String(b.check_value || "").trim().toUpperCase();
        if (!["a", "b"].includes(part)) throw bad(400, "invalid_request", "part must be a or b");
        if (!/^[0-9a-f]{32}$/.test(val)) throw bad(400, "invalid_request", "value must be 32 hex characters");
        if (kcv(val) !== given) throw bad(400, "check_value_mismatch", "The check value does not match the component you typed. There is probably a typo, so enter it again. This is what check values are for.");
        if (val !== k.comps[part].value) throw bad(400, "unknown_component", "That is a valid component but not the one issued for this part.");
        k.loaded[part] = true;
        if (k.loaded.a && k.loaded.b) { k.key = xor(k.comps.a.value, k.comps.b.value); k.kcv = kcv(k.key); k.state = "active"; k.comps = {}; }
        save(acc); send(res, 200, { env, state: k.state, check_value: k.kcv || null }); return true;
      }
      if (m === "POST" && /^\/v1\/acquiring\/tests\/(run-all|[a-z_]+\/run)$/.test(path)) {
        const p = needProject(); if (!s.account) throw bad(409, "no_account", "Get your test merchant and terminal ID first (step 2).");
        if (!p.l1 || !p.l2) throw bad(409, "no_l1_l2", "Level 3 can only be requested for a terminal that already has Level 1 and Level 2 approval. Declare both in step 1.");
        const b = (await readBody(req)) || {}, scheme = b.scheme === undefined ? p.schemes[0] : b.scheme;
        if (!p.schemes.includes(scheme)) throw bad(400, "invalid_request", "scheme must be one of your project's schemes");
        const scope = scopeOf(p), inScope = scope.cases.map((c) => caseById(c.id));
        const stageOk = () => inScope.filter((c) => c.stage === "host").every((c) => passed(acc, c.id));
        const record = (r) => { s.results[r.case_id] = { passed: r.passed, at: r.entry_time, config_hash: cfgHash(acc), scheme: r.scheme }; };
        if (path.endsWith("/run-all")) {
          let ok = 0; const order = [...inScope.filter((c) => c.stage === "host"), ...inScope.filter((c) => c.stage === "l3")];
          for (const c of order) { if (c.stage === "l3" && !stageOk()) break; const r = execute(acc, c, scheme); record(r); if (r.passed) ok++; }
          save(acc); send(res, 200, { total: inScope.length, passed: ok, results: inScope.map((c) => ({ id: c.id, passed: passed(acc, c.id) })) }); return true;
        }
        const c = caseById(mt = path.split("/")[4]); if (!c || !inScope.includes(c)) throw bad(404, "not_in_scope", "That test case does not apply to your scope.");
        if (c.stage === "l3" && !stageOk()) throw bad(409, "host_first", "Host certification must pass first: the host has to carry the new transaction type before terminal tests can mean anything.");
        const defect = b.defect === undefined || b.defect === "" ? null : String(b.defect);
        if (defect && !["entry_mode", "emv_missing", "amount", "mcc", "tid", "currency", "mac", "pin", "no_reversal"].includes(defect)) throw bad(400, "invalid_request", "unknown practice defect");
        const r = execute(acc, c, scheme, defect);
        if (defect) s.practice = Math.min(MAX_RUNS, s.practice + 1); else record(r);
        save(acc); send(res, 200, { run: r }); return true;
      }
      if (m === "POST" && path === "/v1/acquiring/submit") {
        const p = needProject(), scope = scopeOf(p);
        if (scope.gaps.length) throw bad(409, "scope_gap", scope.gaps.join(" "));
        const missing = scope.cases.filter((c) => !passed(acc, c.id)).map((c) => c.id);
        if (!p.l1 || !p.l2) throw bad(409, "no_l1_l2", "Level 1 and Level 2 approval letters are required.");
        if (missing.length) { const e = bad(409, "not_ready", "Not every applicable test case passes with the current profile: " + missing.join(", ")); e.details = { missing }; throw e; }
        const hash = cfgHash(acc); s.loa = p.schemes.map((sc) => ({ id: "loa_" + rnd(6), scheme: sc, model: p.model, config_hash: hash, issued_at: new Date().toISOString() }));
        s.submitted++; save(acc); send(res, 200, { loa: s.loa, note: "Simulated review. A real approval letter covers one scheme and one terminal model in one configuration." }); return true;
      }
      if (m === "GET" && path === "/v1/acquiring/changes") { send(res, 200, { data: CHANGES.map((c) => ({ id: c.id, text: c.text, answered: s.change_correct.includes(c.id) })) }); return true; }
      if ((mt = path.match(/^\/v1\/acquiring\/changes\/(ch\d)\/answer$/)) && m === "POST") {
        const c = CHANGES.find((x) => x.id === mt[1]); if (!c) throw bad(404, "not_found", "No such scenario");
        const b = (await readBody(req)) || {}, host = bool(b.host, "host"), l3 = bool(b.l3, "l3"), l1l2 = bool(b.l1l2, "l1l2");
        const correct = host === c.host && l3 === c.l3 && l1l2 === c.l1l2;
        if (correct && !s.change_correct.includes(c.id)) { s.change_correct.push(c.id); save(acc); }
        send(res, 200, { correct, expected: { host: c.host, l1l2: c.l1l2, l3: c.l3 }, why: c.why }); return true;
      }
      return false;
    },
    _timeline: timeline,
  };
};
