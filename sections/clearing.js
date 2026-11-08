"use strict";
// Clearing and reconciliation lab: you are an acquirer. You send clearing files of the day's sales in cycles, see them
// accepted or rejected, read the settlement advice, and reconcile your own total against it. A second tool walks the
// dispute ladder (chargeback, second presentment, arbitration) and who pays what. Generic names, invented rules and fees,
// fictional calendar and test data only. Amounts are in minor units (cents).

module.exports = function ({ html, ctx, UI, esc }) {
  const { send, bad, readBody, save } = ctx;
  const WINDOW = { electronic: 7, manual: 30 };   // days after the sale in which it may be presented
  const FEE_PER_MESSAGE = 10;                     // invented handling fee per accepted message
  const CHARGEBACK = { id: "CB1", amount: 1800 }; // an issuer chargeback notified on the first settlement day
  const CUTOFF_AFTER_CYCLE = 3;                   // cycles 1 to 3 settle on day 0, cycle 4 on the next settlement day
  const DAY0 = Date.UTC(2030, 2, 15);             // Friday, fictional calendar
  const HOLIDAYS = new Set(["2030-03-18"]);       // a fictional bank holiday on the Monday
  const SEED = [["S01", 4200, "electronic", 1], ["S02", 1999, "electronic", 1], ["S03", 12500, "electronic", 2], ["S04", 800, "electronic", 0], ["S05", 6400, "electronic", 3], ["S06", 2350, "electronic", 9], ["S07", 3100, "manual", 20], ["S08", 15000, "electronic", 1], ["S09", 990, "electronic", 2], ["S10", 5400, "manual", 35], ["S11", 2700, "electronic", 4], ["S12", 7800, "electronic", 6]];
  const LADDER = { chargeback_days: 90, second_presentment_days: 45, arbitration_days: 45, review_wait_days: 10 };
  const LADDER_FEES = { filing: 12000, admin: 20000, technical: 8000 }; // invented
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const money = (c) => (c / 100).toFixed(2);
  const isBankDay = (ms) => { const d = new Date(ms).getUTCDay(); return d !== 0 && d !== 6 && !HOLIDAYS.has(iso(ms)); };
  const nextBankDay = (ms) => { do { ms += 864e5; } while (!isBankDay(ms)); return ms; };
  const settleDate = (day) => (day === 0 ? DAY0 : nextBankDay(DAY0));
  const valueDate = (day) => nextBankDay(settleDate(day));

  const st = (acc) => {
    if (!acc.clr) acc.clr = { items: SEED.map(([id, amount, capture, age]) => ({ id, amount, capture, age })), files: [], cleared: {}, did: {} };
    return acc.clr;
  };
  const fileView = (f) => ({ file_id: f.file_id, cycle: f.cycle, settlement_day: f.day, status: f.status, accepted: f.accepted, rejected: f.rejected, file_error: f.file_error || null });

  function submit(t, b) {
    const fid = String(b.file_id || ""), cycle = b.cycle, ids = b.message_ids;
    if (!/^F\d{3}$/.test(fid)) throw bad(400, "invalid_request", "file_id must look like F001");
    if (!Number.isInteger(cycle) || cycle < 1 || cycle > 4) throw bad(400, "invalid_request", "cycle must be 1, 2, 3 or 4");
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some((x) => typeof x !== "string")) throw bad(400, "invalid_request", "message_ids must be a list of 1 to 50 sale ids");
    if (!Number.isInteger(b.trailer_count)) throw bad(400, "invalid_request", "trailer_count must be a whole number: the file trailer repeats how many messages the file holds");
    const day = cycle > CUTOFF_AFTER_CYCLE ? 1 : 0, rec = { file_id: fid, cycle, day, ids: ids.slice(), accepted: [], rejected: [], status: "accepted" };
    const fileErr = t.files.some((f) => f.file_id === fid) ? { code: "duplicate_file_id", reason: "A file with this id was already received. Every file needs a new id, even after a rejection." }
      : b.trailer_count !== ids.length ? { code: "trailer_count_mismatch", reason: `The trailer says ${b.trailer_count} messages but the file holds ${ids.length}.` } : null;
    if (fileErr) { rec.status = "rejected"; rec.file_error = fileErr; rec.rejected = ids.map((id) => ({ id, code: "file_rejected" })); }
    else {
      const seen = new Set();
      for (const id of ids) {
        const it = t.items.find((x) => x.id === id);
        let code = null, reason = null;
        if (!it) { code = "unknown_message"; reason = "No such sale."; }
        else if (t.cleared[id] || seen.has(id)) { code = "duplicate_presentment"; reason = "This sale was already presented and accepted. Presenting it twice would pay it twice."; }
        else if (it.age > WINDOW[it.capture]) { code = "presentment_expired"; reason = `A ${it.capture} sale must be presented within ${WINDOW[it.capture]} days; this one is ${it.age} days old. It can no longer be collected through clearing.`; }
        seen.add(id);
        if (code) rec.rejected.push({ id, code, reason }); else { rec.accepted.push(id); t.cleared[id] = fid; }
      }
      if (!rec.accepted.length) { rec.status = "rejected"; rec.file_error = { code: "all_messages_rejected", reason: "Every message was rejected, so the whole file is rejected." }; }
      else if (rec.rejected.length) rec.status = "partly_rejected";
    }
    t.files.push(rec);
    t.did.sent = true; if (rec.status === "accepted") t.did.accepted = true;
    if (rec.file_error && rec.file_error.code === "duplicate_file_id") t.did.dup_file = true;
    if (rec.file_error && rec.file_error.code === "trailer_count_mismatch") t.did.trailer = true;
    if (rec.rejected.some((x) => x.code === "presentment_expired")) t.did.expired = true;
    if (rec.rejected.some((x) => x.code === "duplicate_presentment")) t.did.dup_msg = true;
    const sum = rec.accepted.reduce((s, id) => s + t.items.find((x) => x.id === id).amount, 0);
    return { ...fileView(rec), errors_shown: rec.rejected.filter((x) => x.reason).slice(0, 10), acknowledgement: { accepted_count: rec.accepted.length, accepted_total_cents: sum, note: "The acknowledgement counts groups of accepted messages. Rejected messages are not paid until you correct them and send them again in a new file." } };
  }

  function dayReport(t, day) {
    const files = t.files.filter((f) => f.day === day), amt = (id) => t.items.find((x) => x.id === id).amount;
    const summary = files.map((f) => ({ file_id: f.file_id, cycle: f.cycle, status: f.status, accepted_count: f.accepted.length, accepted_total_cents: f.accepted.reduce((s, id) => s + amt(id), 0), handling_fee_cents: f.accepted.length * FEE_PER_MESSAGE }));
    const credits = summary.reduce((s, x) => s + x.accepted_total_cents, 0), fees = summary.reduce((s, x) => s + x.handling_fee_cents, 0);
    const notifications = day === 0 && summary.some((x) => x.accepted_count) ? [{ id: CHARGEBACK.id, kind: "chargeback received from an issuer", debit_cents: CHARGEBACK.amount }] : [];
    const cb = notifications.reduce((s, x) => s + x.debit_cents, 0);
    const gross = files.reduce((s, f) => s + f.ids.reduce((q, id) => q + (t.items.find((x) => x.id === id) || { amount: 0 }).amount, 0), 0);
    const rej = files.reduce((s, f) => s + f.rejected.reduce((q, x) => q + (t.items.find((y) => y.id === x.id) || { amount: 0 }).amount, 0), 0);
    return { day, settlement_date: iso(settleDate(day)), value_date: iso(valueDate(day)), cycles: day === 0 ? [1, 2, 3] : [4], cycle_summary: summary, notifications,
      advice: { net_cents: credits - fees - cb, direction: credits - fees - cb >= 0 ? "credit to you" : "debit from you", note: "The advice gives one net figure. Add up the cycle summary yourself and compare." },
      your_ledger: { submitted_gross_cents: gross }, _rej: rej, _fees: fees, _cb: cb };
  }
  const pub = (r) => { const { _rej, _fees, _cb, ...x } = r; return x; };

  function reconcile(t, b) {
    if (b.day !== 0 && b.day !== 1) throw bad(400, "invalid_request", "day must be 0 or 1");
    if (!Number.isInteger(b.gross_cents)) throw bad(400, "invalid_request", "gross_cents must be your own total, in cents, of everything you sent for that day");
    const lab = Array.isArray(b.explained_by) ? b.explained_by : [], ok = ["rejected", "fees", "chargebacks"];
    if (lab.some((x) => !ok.includes(x))) throw bad(400, "invalid_request", "explained_by may contain: " + ok.join(", "));
    const r = dayReport(t, b.day);
    if (!r.cycle_summary.length) throw bad(409, "nothing_to_reconcile", "No files were received for that settlement day.");
    const adj = b.gross_cents - (lab.includes("rejected") ? r._rej : 0) - (lab.includes("fees") ? r._fees : 0) - (lab.includes("chargebacks") ? r._cb : 0);
    const diff = r.advice.net_cents - adj, out = { day: b.day, advice_net_cents: r.advice.net_cents, your_adjusted_cents: adj, difference_cents: diff, status: diff === 0 ? "reconciled" : "break" };
    if (diff !== 0) {
      const parts = { rejected: r._rej, fees: r._fees, chargebacks: r._cb };
      out.hint = Object.keys(parts).filter((k) => !lab.includes(k) && parts[k]).map((k) => `${k}: ${money(parts[k])}`);
      out.hint_text = "Something between what you sent and what will be paid is not yet explained. Candidates still unaccounted for: " + (out.hint.join("; ") || "none, so check your own arithmetic") + ".";
    } else if (lab.length) { t.did.reconciled = true; if (lab.includes("rejected") && r._rej) t.did.break_found = true; if (lab.includes("chargebacks") && r._cb) t.did.chargeback_seen = true; }
    return out;
  }

  function escalate(t, b) {
    if (!Number.isInteger(b.amount_cents) || b.amount_cents < 1 || b.amount_cents > 1e8) throw bad(400, "invalid_request", "amount_cents must be a positive whole number of cents");
    if (!["issuer", "acquirer"].includes(b.winner)) throw bad(400, "invalid_request", "winner must be issuer or acquirer");
    const tech = b.technical_violations || {}, n = (k) => (Number.isInteger(tech[k]) && tech[k] >= 0 && tech[k] <= 5 ? tech[k] : 0);
    const loser = b.winner === "issuer" ? "acquirer" : "issuer", a = b.amount_cents;
    const steps = [
      { step: "First presentment", window: "starts the clock", money: `Acquirer is credited ${money(a)}; issuer is debited ${money(a)}.` },
      { step: "First chargeback", window: `issuer within ${LADDER.chargeback_days} days`, money: `Issuer is credited ${money(a)}; acquirer is debited ${money(a)}.` },
      { step: "Second presentment", window: `acquirer within ${LADDER.second_presentment_days} days`, money: `Acquirer is credited ${money(a)} again; issuer is debited ${money(a)}.` },
      { step: "Arbitration chargeback", window: `issuer within ${LADDER.second_presentment_days} days`, money: `Issuer is credited ${money(a)} again; acquirer is debited ${money(a)}.` },
      { step: "Arbitration case", window: `filed within ${LADDER.arbitration_days} days; the scheme waits ${LADDER.review_wait_days} days for the other side to accept or reject`, money: `The scheme rules for the ${b.winner}. The ${b.winner} ends up holding ${money(a)}.` },
    ];
    const fees = { filing_cents: LADDER_FEES.filing, administrative_cents: LADDER_FEES.admin, loser, loser_pays_cents: LADDER_FEES.filing + LADDER_FEES.admin, technical: { issuer_cents: n("issuer") * LADDER_FEES.technical, acquirer_cents: n("acquirer") * LADDER_FEES.technical } };
    const owes = { issuer: (loser === "issuer" ? fees.loser_pays_cents : 0) + fees.technical.issuer_cents, acquirer: (loser === "acquirer" ? fees.loser_pays_cents : 0) + fees.technical.acquirer_cents };
    t.did.ladder = true; if (n("issuer") + n("acquirer")) t.did.technical = true; if (b.winner === "acquirer") t.did.acquirer_wins = true;
    return { steps, fees, total_fees_by_party_cents: owes, compliance_note: "If no chargeback reason fits but another participant broke the rules and caused a financial loss, a compliance case (after a pre-compliance attempt) is the route instead. A chargeback is not available there.", note: "Windows and fees are invented for teaching." };
  }

  function page() {
    const body = `<style>.k select,.k input,.k textarea{width:auto;display:inline-block}textarea{width:100%!important;font-family:ui-monospace,monospace;min-height:90px}.t td,.t th{padding:5px 8px;border-bottom:1px solid var(--line,#e3e7ef);text-align:left}.row{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}</style><div class="wrap"><h1>Clearing and reconciliation lab</h1>
<p class="lede">You are the acquirer. The day's sales are waiting to be presented for payment. Send them in files, read the acknowledgements, find out why some are rejected, then check the settlement advice against your own total. The calendar is fictional and the rules and fees are invented. Test data only.</p>
<div class="panel k"><strong>1. Sales waiting to be presented</strong><div id="it"></div></div>
<div class="panel k"><strong>2. Send a clearing file</strong><p class="hint">Cycles 1 to 3 settle on day 0. Cycle 4 is after the cut-off and settles on day 1. The trailer repeats the message count. Each file needs a new id.</p>
<div class="row" id="pre"></div><textarea id="msg" spellcheck="false"></textarea><p><button type="button" id="send">Send file</button> <span id="sm" class="hint"></span></p><div id="rsp"></div><div id="fl"></div></div>
<div class="panel k"><strong>3. Settlement advice and reconciliation</strong><p>Settlement day <select id="dy"><option value="0">0</option><option value="1">1</option></select> <button type="button" id="ad" class="small">Show advice and cycle summary</button></p><div id="ao"></div>
<p>Your gross total <input id="gr" size="8"> explained by <label><input type="checkbox" class="ex" value="rejected"> rejected</label> <label><input type="checkbox" class="ex" value="fees"> fees</label> <label><input type="checkbox" class="ex" value="chargebacks"> chargebacks</label> <button type="button" id="rc" class="small">Reconcile</button></p><div id="ro" class="hint"></div></div>
<div class="panel k"><strong>4. The dispute ladder: who pays when it goes all the way</strong><p>Disputed amount <input id="da" size="7" value="120.00"> Winner <select id="wn"><option>issuer</option><option>acquirer</option></select> Technical violations: issuer <input id="vi" size="2" value="0"> acquirer <input id="va" size="2" value="1"> <button type="button" id="eb" class="small">Walk the ladder</button></p><div id="eo"></div></div>
<h2>What to notice</h2><ul><li>A sale has a <b>presentment window</b>. Past it, clearing will not collect it, so the money is lost unless another route exists.</li><li>A file can be rejected whole (repeated id, wrong trailer) or message by message. Rejected messages are <b>not paid</b> until you fix and resend them.</li><li>The advice gives one net figure. To reconcile you add up the cycle summaries yourself and then account for rejections, fees and chargebacks.</li><li>Money moves at every step of a dispute, and the loser at arbitration also pays fees.</li></ul>
<p class="hint">Related: <a href="/knowledge/clearing-settlement-advice-and-reconciliation">Clearing, settlement advice and reconciliation</a>, <a href="/academy/fees-clearing-reconciliation">Course</a>, <a href="/labs/fees">Fees lab</a>.</p></div>`;
    const script = `var S=null;function $(i){return document.getElementById(i);}function m(c){return (c/100).toFixed(2);}
function cents(s){return Math.round(parseFloat(String(s).replace(",","."))*100);}
function nextFile(){return "F"+String((S?S.files.length:0)+1).padStart(3,"0");}
function presets(){var ok=S.items.filter(function(x){return !x.cleared&&!x.expired;}).map(function(x){return x.id;});var all=S.items.filter(function(x){return !x.cleared;}).map(function(x){return x.id;});var id=nextFile();
return {"Good sales, cycle 1":{file_id:id,cycle:1,message_ids:ok.slice(0,5),trailer_count:Math.min(5,ok.length)},"Everything left, cycle 2":{file_id:id,cycle:2,message_ids:all,trailer_count:all.length},"Wrong trailer":{file_id:id,cycle:2,message_ids:ok.slice(0,3),trailer_count:4},"Same file id again":{file_id:"F001",cycle:2,message_ids:ok.slice(0,2),trailer_count:Math.min(2,ok.length)},"After cut-off, cycle 4":{file_id:id,cycle:4,message_ids:ok.slice(0,3),trailer_count:Math.min(3,ok.length)}};}
function draw(){$("it").innerHTML='<table class="t"><tr><th>Sale</th><th>Amount</th><th>Captured</th><th>Age</th><th>Window</th><th>State</th></tr>'+S.items.map(function(x){return "<tr><td>"+x.id+"</td><td>"+m(x.amount)+"</td><td>"+x.capture+"</td><td>"+x.age+" days</td><td>"+x.window+" days</td><td>"+(x.cleared?"accepted in "+x.cleared:x.expired?"<b>window passed</b>":"waiting")+"</td></tr>";}).join("")+"</table>";
$("pre").innerHTML=Object.keys(presets()).map(function(k){return '<button type="button" class="small" data-p="'+Z.esc(k)+'">'+Z.esc(k)+'</button>';}).join("");$("pre").onclick=function(e){var b=e.target.closest("button[data-p]");if(b)$("msg").value=JSON.stringify(presets()[b.dataset.p]);};
$("fl").innerHTML=S.files.length?'<table class="t"><tr><th>File</th><th>Cycle</th><th>Day</th><th>Status</th><th>Accepted</th><th>Rejected</th></tr>'+S.files.map(function(f){return "<tr><td>"+f.file_id+"</td><td>"+f.cycle+"</td><td>"+f.settlement_day+"</td><td>"+f.status+"</td><td>"+f.accepted.length+"</td><td>"+f.rejected.length+(f.file_error?" ("+Z.esc(f.file_error.code)+")":"")+"</td></tr>";}).join("")+"</table>":"";}
async function load(){if(!(await Z.ensureKey()))return;var r=await Z.api("GET","/v1/clearing");if(r.status!==200){$("sm").textContent=Z.msg(r);return;}S=r.body;draw();if(!$("msg").value)$("msg").value=JSON.stringify(presets()["Good sales, cycle 1"]);}
$("send").onclick=async function(){var b;try{b=JSON.parse($("msg").value);}catch(e){$("sm").textContent="That is not valid JSON.";return;}var r=await Z.api("POST","/v1/clearing/file",b);$("sm").textContent="";
if(r.status!==200){$("rsp").innerHTML="<p class=hint>"+Z.esc(Z.msg(r))+"</p>";}else{var j=r.body;$("rsp").innerHTML="<p><b>"+Z.esc(j.status)+"</b>. "+(j.file_error?Z.esc(j.file_error.reason)+" ":"")+"Acknowledged "+j.acknowledgement.accepted_count+" messages, "+m(j.acknowledgement.accepted_total_cents)+".</p>"+(j.errors_shown.length?"<ul>"+j.errors_shown.map(function(e){return "<li>"+Z.esc(e.id)+": <code>"+Z.esc(e.code)+"</code> "+Z.esc(e.reason)+"</li>";}).join("")+"</ul>":"");}
$("msg").value="";await load();};
$("ad").onclick=async function(){if(!(await Z.ensureKey()))return;var r=await Z.api("GET","/v1/clearing/advice?day="+$("dy").value);if(r.status!==200){$("ao").innerHTML="<p class=hint>"+Z.esc(Z.msg(r))+"</p>";return;}var j=r.body;
$("ao").innerHTML="<p class=hint>Settlement date "+j.settlement_date+", value date "+j.value_date+" (funds move on the value date, on bank days only). Cycles "+j.cycles.join(", ")+".</p><table class=t><tr><th>File</th><th>Cycle</th><th>Status</th><th>Accepted</th><th>Total</th><th>Handling fee</th></tr>"+j.cycle_summary.map(function(x){return "<tr><td>"+x.file_id+"</td><td>"+x.cycle+"</td><td>"+x.status+"</td><td>"+x.accepted_count+"</td><td>"+m(x.accepted_total_cents)+"</td><td>"+m(x.handling_fee_cents)+"</td></tr>";}).join("")+"</table>"+j.notifications.map(function(n){return "<p class=hint>Notification: "+Z.esc(n.kind)+" "+Z.esc(n.id)+", debit "+m(n.debit_cents)+"</p>";}).join("")+"<p><b>Settlement advice: net "+m(j.advice.net_cents)+" ("+Z.esc(j.advice.direction)+")</b></p><p class=hint>You sent "+m(j.your_ledger.submitted_gross_cents)+" in total.</p>";$("gr").value=m(j.your_ledger.submitted_gross_cents);};
$("rc").onclick=async function(){var ex=[].slice.call(document.querySelectorAll(".ex")).filter(function(c){return c.checked;}).map(function(c){return c.value;});var r=await Z.api("POST","/v1/clearing/reconcile",{day:parseInt($("dy").value,10),gross_cents:cents($("gr").value),explained_by:ex});$("ro").innerHTML=r.status===200?("Advice "+m(r.body.advice_net_cents)+", yours after adjustments "+m(r.body.your_adjusted_cents)+": <b>"+Z.esc(r.body.status)+"</b>. "+Z.esc(r.body.hint_text||"")):Z.esc(Z.msg(r));};
$("eb").onclick=async function(){if(!(await Z.ensureKey()))return;var r=await Z.api("POST","/v1/clearing/escalate",{amount_cents:cents($("da").value),winner:$("wn").value,technical_violations:{issuer:parseInt($("vi").value,10)||0,acquirer:parseInt($("va").value,10)||0}});if(r.status!==200){$("eo").innerHTML=Z.esc(Z.msg(r));return;}var j=r.body;
$("eo").innerHTML="<table class=t><tr><th>Step</th><th>Time limit</th><th>Money</th></tr>"+j.steps.map(function(s){return "<tr><td>"+Z.esc(s.step)+"</td><td>"+Z.esc(s.window)+"</td><td>"+Z.esc(s.money)+"</td></tr>";}).join("")+"</table><p class=hint>Fees: the loser ("+j.fees.loser+") pays filing "+m(j.fees.filing_cents)+" + administrative "+m(j.fees.administrative_cents)+". Technical violations: issuer "+m(j.fees.technical.issuer_cents)+", acquirer "+m(j.fees.technical.acquirer_cents)+". Total fees: issuer "+m(j.total_fees_by_party_cents.issuer)+", acquirer "+m(j.total_fees_by_party_cents.acquirer)+".</p><p class=hint>"+Z.esc(j.compliance_note)+" "+Z.esc(j.note)+"</p>";};
if(Z.hasKey())load();else $("sm").textContent="Create a test key to start.";`;
    return UI.shell({ title: "Clearing and reconciliation lab – Zanboxx", description: "Send clearing files in cycles, see why messages are rejected, read a settlement advice, reconcile your total against it, and walk the dispute ladder.", active: "labs", body, script });
  }

  return {
    async handle(req, res, path, m) {
      if (m === "GET" && path === "/labs/clearing") { html(res, 200, page()); return true; }
      if (!path.startsWith("/v1/clearing")) return false;
      const acc = ctx.authed(req), t = st(acc);
      if (m === "GET" && path === "/v1/clearing") {
        send(res, 200, { calendar: { day0: iso(DAY0), bank_holiday: [...HOLIDAYS], cutoff_after_cycle: CUTOFF_AFTER_CYCLE }, items: t.items.map((x) => ({ id: x.id, amount: x.amount, capture: x.capture, age: x.age, window: WINDOW[x.capture], expired: x.age > WINDOW[x.capture], cleared: t.cleared[x.id] || null })), files: t.files.map(fileView) });
        return true;
      }
      if (m === "POST" && path === "/v1/clearing/file") { const out = submit(t, await readBody(req)); save(acc); send(res, 200, out); return true; }
      if (m === "GET" && path === "/v1/clearing/advice") {
        const day = parseInt(new URL(req.url, "http://x").searchParams.get("day"), 10);
        if (day !== 0 && day !== 1) throw bad(400, "invalid_request", "day must be 0 or 1");
        const r = dayReport(t, day); if (!r.cycle_summary.length) throw bad(404, "no_files", "No files were received for that settlement day yet."); t.did.advice = true; save(acc); send(res, 200, pub(r)); return true;
      }
      if (m === "POST" && path === "/v1/clearing/reconcile") { const out = reconcile(t, await readBody(req)); save(acc); send(res, 200, out); return true; }
      if (m === "POST" && path === "/v1/clearing/escalate") { const out = escalate(t, await readBody(req)); save(acc); send(res, 200, out); return true; }
      return false;
    },
  };
};
