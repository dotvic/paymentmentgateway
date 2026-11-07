"use strict";
// Terminal messaging lab: play a payment terminal talking to a simulated acquirer host (sale, timeout and reversal, void,
// offline advice, tip adjustment, batch close and upload), and run the chip action-code decision. Our own generic message
// layout, simulated, test data only. Amounts are in minor units (cents).
const emv = require("../emv");

module.exports = function ({ html, ctx, UI, esc }) {
  const { send, bad, readBody, save } = ctx;
  const FLOOR_LIMIT = 5000, TERMINAL_ID = "TERM0001", MERCHANT_ID = "MERCH0000000001";
  const MTI_D1 = { 0: "ISO 8583:1987 layout", 1: "ISO 8583:1993 layout", 2: "ISO 8583:2003 layout", 8: "National use", 9: "Private use" };
  const MTI_D2 = { 1: "Authorisation", 2: "Financial", 3: "File action", 4: "Reversal or chargeback", 5: "Reconciliation", 6: "Administrative", 7: "Fee collection", 8: "Network management" };
  const MTI_D3 = { 0: "Request", 1: "Request response", 2: "Advice", 3: "Advice response", 4: "Notification", 5: "Notification acknowledgement" };
  const MTI_D4 = { 0: "Acquirer", 1: "Acquirer repeat", 2: "Issuer", 3: "Issuer repeat", 4: "Other" };
  const RESPONSE = { "00": "Approved", "05": "Do not honour", "25": "Unable to locate the original", "51": "Insufficient funds", "94": "Duplicate transmission", "95": "Batch totals do not match, upload the batch" };
  const KNOWN = ["0200", "0220", "0320", "0400", "0500", "0800"];

  const st = (acc) => (acc.term = acc.term || { host: {}, order: [], seen: {}, local: [], batch: { n: 1, mismatch: false, closed: [] }, pending: null, log: [], did: {}, next_stan: 100001, rrn: 1 });
  const nowParts = () => { const d = new Date(); return { time: d.toISOString().slice(11, 19).replace(/:/g, ""), date: d.toISOString().slice(5, 10).replace("-", "") }; };
  const open = (t) => t.order.map((s) => t.host[s]).filter((x) => x.batch === t.batch.n);
  const sum = (list) => {
    const o = { sales_count: 0, sales_amount: 0, refund_count: 0, refund_amount: 0 };
    for (const x of list) { if (x.state !== "approved") continue; if (x.type === "refund") { o.refund_count++; o.refund_amount += x.amount; } else { o.sales_count++; o.sales_amount += x.amount; } }
    return o;
  };
  const termTotals = (t) => { const o = sum(open(t).filter((x) => !x.lost)); for (const l of t.local) if (!l.sent) { o.sales_count++; o.sales_amount += l.amount; } return o; };
  const log = (t, dir, msg) => { t.log.push({ dir, at: new Date().toISOString().slice(11, 19), ...msg }); if (t.log.length > 40) t.log.shift(); };
  const amountOk = (v) => Number.isInteger(v) && v > 0 && v < 100000000;
  const stanOk = (v) => typeof v === "string" && /^\d{6}$/.test(v);
  const reply = (t, req, rsp) => { const r = { terminal_id: TERMINAL_ID, merchant_id: MERCHANT_ID, ...nowParts(), ...rsp }; r.response_text = RESPONSE[r.response_code]; log(t, "host", { mti: r.mti, response_code: r.response_code, stan: r.stan }); return r; };
  const nextStan = (t) => { while (t.seen[String(t.next_stan)]) t.next_stan++; return t.next_stan; };
  const view = (t) => ({
    terminal: { id: TERMINAL_ID, merchant_id: MERCHANT_ID, floor_limit: FLOOR_LIMIT },
    batch: { number: t.batch.n, awaiting_upload: t.batch.mismatch, transactions: open(t).map((x) => ({ stan: x.stan, rrn: x.rrn, type: x.type, amount: x.amount, state: x.state, time: x.time, known_to_terminal: !x.lost })), unsent_offline: t.local.filter((l) => !l.sent), terminal_totals: termTotals(t) },
    pending_reversal: t.pending, next_stan: String(nextStan(t)), closed_batches: t.batch.closed, log: t.log.slice(-25), did: t.did,
  });

  function mtiInfo(m) {
    if (!/^\d{4}$/.test(m)) throw bad(400, "invalid_request", "mti must be four digits");
    const d = m.split("").map(Number);
    return { mti: m, digits: [{ position: 1, digit: d[0], meaning: MTI_D1[d[0]] || "Reserved" }, { position: 2, digit: d[1], meaning: MTI_D2[d[1]] || "Reserved" }, { position: 3, digit: d[2], meaning: MTI_D3[d[2]] || "Instruction or reserved" }, { position: 4, digit: d[3], meaning: MTI_D4[d[3]] || "Reserved" }], summary: `${MTI_D3[d[2]] || "Message"} in the ${(MTI_D2[d[1]] || "unknown").toLowerCase()} class, started by: ${(MTI_D4[d[3]] || "unknown").toLowerCase()}` };
  }

  // Terminal action analysis then the card's first answer. All values are hex strings of 5 bytes.
  function actionAnalysis(b) {
    const h = (k) => { const v = String(b[k] || "").toUpperCase(); if (!/^[0-9A-F]{10}$/.test(v)) throw bad(400, "invalid_request", k + " must be 10 hex characters (5 bytes)"); return Buffer.from(v, "hex"); };
    const tvr = h("tvr"), tac = { denial: h("tac_denial"), online: h("tac_online"), default: h("tac_default") }, iac = { denial: h("iac_denial"), online: h("iac_online"), default: h("iac_default") };
    const hit = (a, c) => a.some((x, i) => (x & (c[i])) !== 0);
    const or = (a, c) => Buffer.from(a.map((x, i) => x | c[i]));
    const canOnline = b.can_go_online !== false;
    const denial = hit(tvr, or(tac.denial, iac.denial)), online = hit(tvr, or(tac.online, iac.online)), dflt = hit(tvr, or(tac.default, iac.default));
    let ask, why;
    if (denial) { ask = "AAC"; why = "A TVR bit set matches the denial codes (terminal or issuer), so the terminal asks the card for a decline."; }
    else if (canOnline) { if (online) { ask = "ARQC"; why = "No denial bit matched, but an online bit did, so the terminal asks to go online."; } else { ask = "TC"; why = "Nothing matched denial or online, so the terminal asks for an offline approval."; } }
    else if (dflt) { ask = "AAC"; why = "The terminal cannot go online and a default bit matched, so it asks for a decline."; }
    else { ask = "TC"; why = "The terminal cannot go online and no default bit matched, so it asks for an offline approval."; }
    const out = { terminal_asks: ask, why, tvr_flags: emv.decodeTvr(tvr.toString("hex")), checks: { denial, online, default: dflt } };
    if (b.card_response) {
      const rank = { TC: 0, ARQC: 1, AAC: 2 }, r = String(b.card_response).toUpperCase();
      if (!(r in rank)) throw bad(400, "invalid_request", "card_response must be TC, ARQC or AAC");
      const valid = rank[r] >= rank[ask];
      out.card_response = r; out.card_response_valid = valid;
      out.card_note = valid ? (r === ask ? "The card agrees with the terminal." : "The card moved the decision toward decline. That is allowed: the card can be more cautious than the terminal.") : "Not allowed. The card may only keep the terminal's request or move toward decline (TC to ARQC to AAC). It can never approve more than the terminal asked for.";
    }
    return out;
  }

  function page() {
    const body = `<style>.k select,.k input,.k textarea{width:auto;display:inline-block}textarea{width:100%!important;font-family:ui-monospace,monospace;min-height:130px}.log{max-height:220px;overflow:auto;font-family:ui-monospace,monospace;font-size:13px}.row{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}</style><div class="crumbs"><a href="/labs">Payment Labs</a> / Terminal messaging</div><h1>Terminal messaging</h1>
<p class="lede">A terminal and its acquirer host talk in short, strict messages. Here you play the terminal: send a sale, lose the answer, send the reversal, void, tip, close the batch and fix a mismatch. The host is simulated and checks your fields the way a real one would. Amounts are in cents. Test data only.</p>
<div class="panel k"><strong>1. Read a message type</strong><p>Four digits, four meanings. <input id="mt" size="6" value="0210"> <button type="button" id="mb" class="small">Decode</button></p><div id="mo" class="hint"></div></div>
<div class="panel k"><strong>2. Send messages to the host</strong>
<div class="row" id="pre"></div><textarea id="msg" spellcheck="false"></textarea><p><button type="button" id="send">Send</button> <button type="button" id="off" class="small">Approve a small sale offline (terminal only)</button> <span id="sm" class="hint"></span></p>
<div id="rsp" class="panel"></div><strong>Terminal batch</strong><div id="bt"></div><strong>Message log</strong><div id="lg" class="log"></div></div>
<div class="panel k"><strong>3. The chip decision: terminal action codes and the card's answer</strong><p class="hint">The terminal compares the TVR with the terminal's and the issuer's action codes, then asks the card for a cryptogram. Values are 5 bytes in hex.</p>
<p>TVR <input id="tvr" size="12" value="0000008000"> online-capable <input type="checkbox" id="onl" checked></p>
<p>Terminal action codes: denial <input id="td" size="12" value="0000000000"> online <input id="to" size="12" value="0000008000"> default <input id="tf" size="12" value="0000008000"></p>
<p>Issuer action codes: denial <input id="id" size="12" value="0000000000"> online <input id="io" size="12" value="0000000000"> default <input id="if" size="12" value="0000000000"></p>
<p>Card answers <select id="cr"><option value="">(not yet)</option><option>TC</option><option>ARQC</option><option>AAC</option></select> <button type="button" id="ab" class="small">Run decision</button></p><div id="ao" class="hint"></div></div>
<h2>What to notice</h2><ul><li>If a response is lost, the terminal does not know whether the host approved. It must send a reversal and finish it before any other message.</li><li>A void repeats the original's amount, trace number, time and reference. One field off and the host cannot find it.</li><li>A sale approved offline must be below the floor limit (${FLOOR_LIMIT / 100}.00) and its advice sent before the batch closes.</li><li>The card can decline more than the terminal asked, never less.</li></ul>
<p class="hint">Related: <a href="/knowledge/terminal-messages-and-batches">Terminal messages guide</a>, <a href="/knowledge/emv-decision-flow-and-pin-keys">EMV decision flow</a>, <a href="/academy/terminal-messaging">Terminal messaging course</a>.</p>`;
    const script = `var S=null;function $(i){return document.getElementById(i);}
function money(c){return (c/100).toFixed(2);}
$("mb").onclick=async function(){var r=await fetch("/v1/terminal/mti?mti="+encodeURIComponent($("mt").value));var j=await r.json();$("mo").innerHTML=r.status===200?("<ul>"+j.digits.map(function(d){return "<li>Digit "+d.position+": <b>"+d.digit+"</b> "+Z.esc(d.meaning)+"</li>";}).join("")+"</ul>"+Z.esc(j.summary)):Z.esc((j.error&&j.error.message)||"Error");};
function stan(){return S?S.next_stan:"100001";}
function presets(){var ob=(S&&S.batch.transactions)||[];var last=ob.filter(function(x){return x.state==="approved"&&x.type==="sale";}).pop();var P={
"Sale":{mti:"0200",processing_code:"000000",amount:1250,stan:stan(),entry_mode:"chip",terminal_id:"${TERMINAL_ID}",merchant_id:"${MERCHANT_ID}"},
"Sale, answer lost":{mti:"0200",processing_code:"000000",amount:2000,stan:stan(),entry_mode:"chip",terminal_id:"${TERMINAL_ID}",merchant_id:"${MERCHANT_ID}",simulate_timeout:true},
"Echo test":{mti:"0800",processing_code:"990000",terminal_id:"${TERMINAL_ID}"},
"Close batch":{mti:"0500",processing_code:"920000",stan:stan(),totals:S?S.batch.terminal_totals:{sales_count:0,sales_amount:0,refund_count:0,refund_amount:0}}};
if(S&&S.pending_reversal)P["Reversal"]={mti:"0400",processing_code:"000000",amount:S.pending_reversal.amount,stan:S.pending_reversal.stan,reason:"98"};
if(last){P["Void last sale"]={mti:"0200",processing_code:"020000",amount:last.amount,stan:last.stan,original:{stan:last.stan,amount:last.amount,rrn:last.rrn,time:last.time}};P["Add a tip"]={mti:"0220",adjust_of:last.stan,base_amount:last.amount,tip:150,amount:last.amount+150,auth_code:"HOST01"};}
var u=S&&S.batch.unsent_offline[0];if(u)P["Send offline advice"]={mti:"0220",processing_code:"000000",amount:u.amount,stan:u.stan,auth_code:"SVC201"};
if(S&&S.batch.awaiting_upload){var u2=S.batch.unsent_offline[0];if(u2)P["Upload batch item"]={mti:"0320",stan:u2.stan,amount:u2.amount};P["Close batch again"]={mti:"0500",processing_code:"960000",stan:stan(),totals:S.batch.terminal_totals};}
return P;}
function draw(){var P=presets();$("pre").innerHTML=Object.keys(P).map(function(k){return '<button type="button" class="small" data-p="'+Z.esc(k)+'">'+Z.esc(k)+'</button>';}).join("");$("pre").onclick=function(e){var b=e.target.closest("button[data-p]");if(!b)return;$("msg").value=JSON.stringify(presets()[b.dataset.p],null,1);};
var t=S.batch.terminal_totals;$("bt").innerHTML="<p class=hint>Batch "+S.batch.number+(S.batch.awaiting_upload?" (host asked for an upload)":"")+". Terminal totals: "+t.sales_count+" sales "+money(t.sales_amount)+", "+t.refund_count+" refunds "+money(t.refund_amount)+". Unsent offline: "+S.batch.unsent_offline.length+(S.pending_reversal?'. <b>Reversal outstanding for trace '+S.pending_reversal.stan+'.</b>':"")+"</p>";
$("lg").innerHTML=S.log.slice().reverse().map(function(l){return Z.esc(l.at+" "+l.dir+" "+(l.mti||"")+" "+(l.response_code?("rc "+l.response_code):"")+" "+(l.stan||""));}).join("<br>");}
async function load(){if(!(await Z.ensureKey()))return;var r=await Z.api("GET","/v1/terminal");if(r.status!==200){$("sm").textContent=Z.msg(r);return;}S=r.body;draw();if(!$("msg").value)$("msg").value=JSON.stringify(presets()["Sale"],null,1);}
$("send").onclick=async function(){var b;try{b=JSON.parse($("msg").value);}catch(e){$("sm").textContent="That is not valid JSON.";return;}var r=await Z.api("POST","/v1/terminal/message",b);$("sm").textContent="";$("rsp").innerHTML="<b>HTTP "+r.status+"</b><pre>"+Z.esc(JSON.stringify(r.body,null,1))+"</pre>";await load();};
$("off").onclick=async function(){var r=await Z.api("POST","/v1/terminal/offline-sale",{amount:1800});$("sm").textContent=r.status===200?("Approved locally, trace "+r.body.stan+". Not yet sent to the host."):Z.msg(r);await load();};
$("ab").onclick=async function(){var b={tvr:$("tvr").value,tac_denial:$("td").value,tac_online:$("to").value,tac_default:$("tf").value,iac_denial:$("id").value,iac_online:$("io").value,iac_default:$("if").value,can_go_online:$("onl").checked};if($("cr").value)b.card_response=$("cr").value;var r=await Z.api("POST","/v1/terminal/action-analysis",b);if(r.status!==200){$("ao").textContent=Z.msg(r);return;}var j=r.body;$("ao").innerHTML="Terminal asks the card for <b>"+j.terminal_asks+"</b>. "+Z.esc(j.why)+"<br>TVR bits set: "+(j.tvr_flags.length?Z.esc(j.tvr_flags.join("; ")):"none")+(j.card_note?"<br><b>"+Z.esc(j.card_response)+":</b> "+Z.esc(j.card_note):"");};
if(Z.hasKey())load();else $("sm").textContent="Create a test key to start.";`;
    return UI.shell({ title: "Terminal messaging – Zanboxx", description: "Play a payment terminal: send sales, lose a response and reverse, void, add a tip, close and upload a batch, and run the chip action-code decision.", active: "labs", body, script });
  }

  return {
    async handle(req, res, path, m) {
      if (m === "GET" && path === "/labs/terminal") { html(res, 200, page()); return true; }
      if (m === "GET" && path === "/v1/terminal/mti") { send(res, 200, mtiInfo(new URL(req.url, "http://x").searchParams.get("mti") || "")); return true; }
      if (!path.startsWith("/v1/terminal")) return false;
      const acc = ctx.authed(req), t = st(acc);
      if (m === "GET" && path === "/v1/terminal") { send(res, 200, view(t)); return true; }
      if (m === "POST" && path === "/v1/terminal/action-analysis") {
        const out = actionAnalysis(await readBody(req)); t.did.action = true;
        if (out.terminal_asks === "ARQC") t.did.action_online = true;
        if (out.terminal_asks === "AAC") t.did.action_decline = true;
        if (out.card_response_valid === false) t.did.card_rule = true;
        save(acc); send(res, 200, out); return true;
      }
      if (m === "POST" && path === "/v1/terminal/offline-sale") {
        const b = await readBody(req);
        if (!amountOk(b.amount)) throw bad(400, "invalid_request", "amount must be a positive whole number of cents");
        if (b.amount > FLOOR_LIMIT) throw bad(400, "above_floor_limit", `The terminal may approve offline only up to the floor limit (${FLOOR_LIMIT} cents). Send this online instead.`);
        const stan = String(nextStan(t)); t.next_stan++; t.local.push({ stan, amount: b.amount, sent: false }); t.seen[stan] = true; save(acc);
        send(res, 200, { stan, amount: b.amount, note: "Approved by the terminal on its own. The host does not know until you send the advice." }); return true;
      }
      if (m === "POST" && path === "/v1/terminal/message") {
        const b = await readBody(req), mti = String(b.mti || "");
        if (!KNOWN.includes(mti)) throw bad(400, "invalid_request", "mti must be one of " + KNOWN.join(", "));
        log(t, "terminal", { mti, stan: b.stan || (b.original && b.original.stan) });
        if (t.pending && mti !== "0400" && mti !== "0800") { save(acc); throw bad(409, "reversal_outstanding", "The last answer was lost. Send the reversal for trace " + t.pending.stan + " and wait for its answer before any other message."); }
        const out = (code, extra) => reply(t, b, { mti: String(+mti + 10).padStart(4, "0"), stan: b.stan || (b.original && b.original.stan), response_code: code, ...extra });
        if (mti === "0800") { if (b.processing_code !== "990000") throw bad(400, "invalid_request", "Use processing code 990000 for an echo test"); save(acc); send(res, 200, out("00")); return true; }
        if (mti === "0400") {
          if (!stanOk(b.stan) || !amountOk(b.amount)) throw bad(400, "invalid_request", "A reversal needs the original's stan (6 digits) and amount");
          const x = t.host[b.stan];
          if (x && x.amount === b.amount && x.state === "approved") { x.state = "reversed"; if (t.pending && t.pending.stan === b.stan) t.pending = null; t.did.reversal = true; save(acc); send(res, 200, out("00", { reversal_of: b.stan })); return true; }
          if (!x && t.pending && t.pending.stan === b.stan) { t.pending = null; save(acc); send(res, 200, out("00", { note: "Nothing to undo on the host." })); return true; }
          if (x && x.amount !== b.amount) throw bad(422, "fields_do_not_match", "The amount must be the original's amount.");
          save(acc); send(res, 200, out("25")); return true;
        }
        if (mti === "0200" && /^02/.test(String(b.processing_code))) {
          const o = b.original || {}, x = t.host[o.stan];
          if (!x) { save(acc); send(res, 200, out("25")); return true; }
          if (x.batch !== t.batch.n) throw bad(400, "batch_closed", "That sale is in a closed batch. A void is only possible while its batch is open; send a refund instead.");
          if (x.state !== "approved" || x.type !== "sale" || x.amount !== o.amount || x.rrn !== o.rrn || x.time !== o.time) { save(acc); send(res, 200, out("25", { hint: "A void must repeat the original's amount, trace number, time and reference exactly." })); return true; }
          x.state = "voided"; t.did.void = true; save(acc); send(res, 200, out("00", { rrn: x.rrn })); return true;
        }
        if (mti === "0200") {
          const pc = String(b.processing_code || "").slice(0, 2);
          if (!["00", "20"].includes(pc) || !/^\d{6}$/.test(String(b.processing_code))) throw bad(400, "invalid_request", "processing_code must be 6 digits starting 00 (sale), 20 (refund) or 02 (void)");
          if (!amountOk(b.amount) || !stanOk(b.stan)) throw bad(400, "invalid_request", "A sale or refund needs a positive amount in cents and a 6-digit stan");
          if (!b.terminal_id || !b.merchant_id) throw bad(400, "invalid_request", "terminal_id and merchant_id are required");
          if (t.host[b.stan] || t.seen[b.stan]) { save(acc); send(res, 200, out("94")); return true; }
          t.seen[b.stan] = true;
          const code = b.amount % 100 === 51 ? "51" : b.amount % 100 === 5 ? "05" : "00";
          if (code !== "00") { save(acc); send(res, 200, out(code)); return true; }
          const rrn = String(t.rrn++).padStart(12, "0"), p = nowParts(), x = { stan: b.stan, rrn, auth: "A" + String(t.rrn).padStart(5, "0"), type: pc === "20" ? "refund" : "sale", amount: b.amount, state: "approved", batch: t.batch.n, time: p.time };
          t.host[b.stan] = x; t.order.push(b.stan);
          if (b.simulate_timeout) { x.lost = true; t.pending = { stan: b.stan, amount: b.amount }; save(acc); throw bad(504, "host_timeout", "No answer received. The host may or may not have approved. Send a reversal for trace " + b.stan + "."); }
          save(acc); send(res, 200, out("00", { rrn, auth_code: x.auth, local_time: p.time })); return true;
        }
        if (mti === "0220" && b.adjust_of) {
          const x = t.host[b.adjust_of];
          if (!x || x.state !== "approved" || x.type !== "sale") { save(acc); send(res, 200, out("25")); return true; }
          if (x.batch !== t.batch.n) throw bad(400, "batch_closed", "Tips can only be added while the batch is open.");
          if (!Number.isInteger(b.tip) || b.tip < 0 || b.base_amount !== x.amount || b.amount !== b.base_amount + b.tip) throw bad(422, "fields_do_not_match", "amount must equal base_amount plus tip, and base_amount must be the original sale amount.");
          x.amount = b.amount; x.tip = b.tip; t.did.adjust = true; save(acc); send(res, 200, out("00", { rrn: x.rrn, stan: b.adjust_of })); return true;
        }
        if (mti === "0220") {
          const l = t.local.find((z) => z.stan === b.stan);
          if (!l || l.sent) throw bad(400, "invalid_request", "No unsent offline sale with that stan. Approve one offline first.");
          if (!/^SVC/.test(String(b.auth_code || ""))) throw bad(400, "invalid_request", "A sale the terminal approved on its own carries an auth_code starting SVC.");
          if (b.amount !== l.amount) throw bad(422, "fields_do_not_match", "The amount must match the offline sale.");
          if (b.amount > FLOOR_LIMIT) throw bad(400, "above_floor_limit", "Above the floor limit this must have been online.");
          l.sent = true; const rrn = String(t.rrn++).padStart(12, "0"); t.host[l.stan] = { stan: l.stan, rrn, type: "sale", offline: true, amount: l.amount, state: "approved", batch: t.batch.n, time: nowParts().time };
          t.order.push(l.stan); t.did.offline = true; save(acc); send(res, 200, out("00", { rrn })); return true;
        }
        if (mti === "0320") {
          if (!t.batch.mismatch) throw bad(409, "upload_not_requested", "Upload only after the host answered a batch close with 95.");
          const l = t.local.find((z) => z.stan === b.stan && !z.sent);
          if (!l) throw bad(400, "invalid_request", "No unsent transaction with that stan.");
          if (b.amount !== l.amount) throw bad(422, "fields_do_not_match", "The amount must match the terminal's record.");
          l.sent = true; const rrn = String(t.rrn++).padStart(12, "0"); t.host[l.stan] = { stan: l.stan, rrn, type: "sale", offline: true, amount: l.amount, state: "approved", batch: t.batch.n, time: nowParts().time };
          t.order.push(l.stan); save(acc); send(res, 200, out("00", { rrn })); return true;
        }
        if (mti === "0500") {
          const pc = String(b.processing_code || ""), tt = b.totals || {};
          if (!["920000", "960000"].includes(pc)) throw bad(400, "invalid_request", "processing_code must be 920000 (first attempt) or 960000 (later attempt)");
          if (pc === "960000" && !t.batch.mismatch) throw bad(409, "sequence_error", "960000 follows a failed 920000.");
          for (const k of ["sales_count", "sales_amount", "refund_count", "refund_amount"]) if (!Number.isInteger(tt[k]) || tt[k] < 0) throw bad(400, "invalid_request", "totals." + k + " must be a whole number");
          const host = sum(open(t));
          if (JSON.stringify(host) !== JSON.stringify({ sales_count: tt.sales_count, sales_amount: tt.sales_amount, refund_count: tt.refund_count, refund_amount: tt.refund_amount })) { t.batch.mismatch = true; t.did.mismatch = true; save(acc); send(res, 200, out("95", { host_totals_hidden: true })); return true; }
          if (t.local.some((l) => !l.sent)) { save(acc); throw bad(409, "unsent_offline", "Offline sales are still unsent. Send their advice before closing the batch."); }
          t.batch.closed.push({ number: t.batch.n, ...host }); t.did.batch_closed = true; if (t.batch.mismatch) t.did.recovered = true;
          t.batch.n++; t.batch.mismatch = false; t.local = []; save(acc); send(res, 200, out("00", { batch_closed: t.batch.n - 1 })); return true;
        }
      }
      return false;
    },
  };
};
