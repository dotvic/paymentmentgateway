"use strict";
// Payouts lab: how a marketplace or platform pays its sellers. A day-by-day seller balance with commission, a settlement delay,
// a rolling reserve, refunds, chargebacks, negative balances, verification holds and payout schedules, plus a scenario quiz.
// A teaching model: all rates, fees and rules are invented and simplified.

module.exports = function ({ html, ctx, UI, esc }) {
  const { send, bad, readBody, save } = ctx;
  const st = (acc) => (acc.payouts = acc.payouts || { did: {} });
  const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
  const HORIZON = 45, CB_FEE = 15;

  function listOf(v, label) {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > 20) throw bad(400, "invalid_request", label + " must be a list of at most 20 items");
    return v.map((x, i) => {
      const d = Number(x && x.day), a = Number(x && x.amount);
      if (!Number.isInteger(d) || d < 1 || d > HORIZON || !(a > 0 && a <= 1e6)) throw bad(400, "invalid_request", `${label} ${i + 1}: day must be 1 to ${HORIZON} and amount greater than 0`);
      return { day: d, amount: r2(a) };
    });
  }

  function simulate(b) {
    const mode = b.schedule || "daily"; if (!["daily", "weekly", "monthly"].includes(mode)) throw bad(400, "invalid_request", "schedule must be daily, weekly or monthly");
    const num = (k, def, lo, hi) => { const v = b[k] === undefined ? def : Number(b[k]); if (!(v >= lo && v <= hi)) throw bad(400, "invalid_request", `${k} must be between ${lo} and ${hi}`); return v; };
    const delay = Math.round(num("delay_days", 2, 0, 14)), reservePct = num("reserve_percent", 0, 0, 30), reserveDays = Math.round(num("reserve_days", 0, 0, 30)), minPayout = num("minimum_payout", 10, 0, 1000);
    const comm = num("commission_percent", 10, 0, 50), fixed = num("fixed_fee", 0.3, 0, 5), verifiedDay = Math.round(num("verified_day", 0, 0, HORIZON));
    const sales = listOf(b.sales, "Sale"), refunds = listOf(b.refunds, "Refund"), cbs = listOf(b.chargebacks, "Chargeback");
    if (!sales.length) throw bad(400, "invalid_request", "Add at least one sale");
    let avail = 0; const pend = [], resv = []; const timeline = [], payouts = []; let fees = 0, gross = 0, paid = 0, minAvail = 0, heldDays = 0;
    const take = (q, amt) => { let left = amt; while (left > 0.0001 && q.length) { const t = Math.min(q[0].amount, left); q[0].amount = r2(q[0].amount - t); left = r2(left - t); if (q[0].amount <= 0.0001) q.shift(); } return left; };
    const sum = (q) => r2(q.reduce((s, x) => s + x.amount, 0));
    for (let day = 1; day <= HORIZON; day++) {
      const ev = [];
      for (const s of sales.filter((x) => x.day === day)) {
        const fee = r2(s.amount * comm / 100 + fixed), net = r2(s.amount - fee), res = r2(net * reservePct / 100), pe = r2(net - res); fees = r2(fees + fee); gross = r2(gross + s.amount);
        if (pe > 0) pend.push({ due: day + delay, amount: pe }); if (res > 0) resv.push({ due: day + delay + reserveDays, amount: res });
        ev.push(`Sale ${s.amount.toFixed(2)}, fee ${fee.toFixed(2)}` + (res > 0 ? `, ${res.toFixed(2)} into reserve` : ""));
      }
      for (const q of [pend, resv]) while (q.length && q[0].due <= day) { avail = r2(avail + q[0].amount); q.shift(); }
      pend.sort((a, c) => a.due - c.due); resv.sort((a, c) => a.due - c.due);
      const debit = (amt, label) => {
        let left = amt; const t1 = Math.max(0, Math.min(avail, left)); avail = r2(avail - t1); left = r2(left - t1);
        left = take(resv, left); left = take(pend, left); if (left > 0) avail = r2(avail - left);
        ev.push(`${label} ${amt.toFixed(2)} debited` + (left > 0 ? `. Seller now owes ${left.toFixed(2)}` : ""));
      };
      for (const r of refunds.filter((x) => x.day === day)) { const back = r2(r.amount * comm / 100); fees = r2(fees - back); debit(r2(r.amount - back), "Refund"); }
      for (const c of cbs.filter((x) => x.day === day)) { fees = r2(fees + CB_FEE); debit(r2(c.amount + CB_FEE), "Chargeback (incl. " + CB_FEE + " fee)"); }
      let out = 0, status = null;
      const due = mode === "daily" || (mode === "weekly" && day % 7 === 0) || (mode === "monthly" && day % 30 === 0);
      if (due && avail > 0) {
        if (day < verifiedDay) { status = "held: seller not verified yet"; heldDays++; }
        else if (avail < minPayout) status = "below the minimum payout, carried forward";
        else { out = avail; avail = 0; paid = r2(paid + out); payouts.push({ day, amount: out }); status = "paid"; }
      }
      minAvail = Math.min(minAvail, avail);
      timeline.push({ day, pending: sum(pend), reserved: sum(resv), available: avail, paid_out: out, events: ev, payout_status: status });
    }
    const last = timeline[timeline.length - 1], warn = [];
    if (minAvail < 0) warn.push(`The seller's balance went negative (lowest ${minAvail.toFixed(2)}). The platform paid the seller before the loss arrived and now has to recover the money or absorb it.`);
    if (cbs.length && minAvail >= 0 && reservePct > 0) warn.push("The reserve and the balance covered the chargeback, so the platform was not left exposed.");
    if (heldDays > 0) warn.push("Payouts were held until the seller was verified. Holding money until verification protects the platform but delays the seller.");
    if (delay === 0 && cbs.length) warn.push("Paying out on the same day gives the platform no time to see disputes before the money is gone.");
    return { settings: { schedule: mode, delay_days: delay, reserve_percent: reservePct, reserve_days: reserveDays, minimum_payout: minPayout, commission_percent: comm, fixed_fee: fixed, verified_day: verifiedDay },
      summary: { gross_sales: gross, platform_fees: fees, paid_out: paid, pending_at_end: last.pending, reserved_at_end: last.reserved, available_at_end: last.available, lowest_balance: minAvail, payouts: payouts.length }, payouts, timeline, warnings: warn,
      flags: { negative: minAvail < 0, reserve_covered: cbs.length > 0 && minAvail >= 0 && reservePct > 0, kyc_hold: heldDays > 0 } };
  }

  const OPT = { release: "Release the payout", hold: "Hold for review", retry: "Retry the payout", bank_details: "Ask the seller for new bank details", debit: "Debit the seller's balance", instant: "Pay out now for a fee" };
  const SC = [
    ["A verified seller with steady sales reaches the weekly payout day. Nothing unusual.", "release", "Normal case: release on schedule."],
    ["A seller created their account two days ago, is unverified, and asks to withdraw 8,000 from a single day's sales.", "hold", "A new, unverified seller with large volume is the classic fraud pattern. Hold and review."],
    ["A payout came back from the bank with the reason account closed.", "bank_details", "Retrying a closed account will only fail again. Ask the seller for new details."],
    ["A payout came back with a temporary time-out at the bank.", "retry", "A temporary failure is worth a retry, with the same payout reference so it cannot be paid twice."],
    ["A reliable seller wants cash today and your policy allows instant payouts with a fee.", "instant", "That is exactly what the instant option is for."],
    ["A 200.00 chargeback arrives. The seller has 500.00 available.", "debit", "Take it from the balance. No other action is needed."],
    ["A seller who normally sells 300 a day suddenly sells 12,000 in a new category the day after changing their bank details.", "hold", "A sharp jump after a bank change is a warning sign of account takeover."],
    ["A 100.00 refund is issued but the seller's balance is only 30.00.", "debit", "Debit the balance. It goes negative and you recover it from future sales."],
    ["Verification finished this morning and the seller's held payout is due.", "release", "The reason for holding is gone, so release."],
    ["A payout failed with account holder name does not match.", "bank_details", "The details need correcting. A retry will fail again."],
    ["The payout provider's API returned a 503 error while sending a payout.", "retry", "A server error is temporary. Retry using the same idempotency key."],
    ["A seller's reserve period has ended and the funds are due to be released.", "release", "Release the reserve to the seller's available balance."],
  ];
  const SCEN = SC.map((s, i) => ({ id: i + 1, text: s[0], answer: s[1], why: s[2] }));

  function page() {
    const body = `<style>.t td,.t th{padding:5px 8px;border-bottom:1px solid var(--line,#e3e7ef);text-align:left;vertical-align:top}.bad{color:#b3261e}.good{color:#1b7a3d}.warn{color:#9a6700}.ev{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:4px 0}.ev input{width:90px}.ev select{width:auto}.fl2 label{display:inline-block;margin:4px 10px 4px 0}.fl2 input,.fl2 select{max-width:calc(100vw - 80px)}#r1,#r2{overflow-x:auto}#r1 .t,#r2 .t{display:table;width:100%}.sc{padding:8px 0;border-bottom:1px solid var(--line,#e3e7ef)}.sc select{max-width:calc(100vw - 80px)}</style><div class="wrap"><h1>Payouts</h1>
<p class="lede">A marketplace or platform takes payments from buyers and pays its sellers later. Between the two sits a balance with a fee, a waiting period, sometimes a reserve, and the risk that refunds and chargebacks arrive after the money has left. Run a seller through 45 days and see what each setting does. A teaching model with invented rates, and you use test data only.</p>
<p class="hint" id="top"></p>
<div class="panel"><strong>1. Seller balance simulator</strong><p class="hint">Add sales, refunds and chargebacks by day, choose the payout rules, and press Run.</p>
<p>Examples: <button type="button" data-p="steady">Steady seller</button> <button type="button" data-p="cb">Chargeback after payout</button> <button type="button" data-p="reserve">Same, with a reserve</button> <button type="button" data-p="kyc">Unverified seller</button></p>
<div class="fl2"><label>Schedule <select id="sc"><option>daily</option><option selected>weekly</option><option>monthly</option></select></label><label>Delay (days) <input type="number" id="dl" value="2" min="0" max="14"></label><label>Reserve % <input type="number" id="rs" value="0" min="0" max="30"></label><label>Reserve held (days) <input type="number" id="rd" value="0" min="0" max="30"></label><label>Minimum payout <input type="number" id="mp" value="10" min="0"></label><label>Commission % <input type="number" id="cm" value="10" min="0" max="50"></label><label>Fixed fee <input type="number" id="ff" value="0.30" step="0.1" min="0"></label><label>Verified on day <input type="number" id="vd" value="0" min="0" max="45"></label></div>
<p><b>Events</b> <button type="button" data-a="sales">+ Sale</button> <button type="button" data-a="refunds">+ Refund</button> <button type="button" data-a="chargebacks">+ Chargeback</button></p><div id="evs"></div>
<p><button type="button" id="go">Run</button> <button type="button" id="clr">Clear</button> <span class="hint" id="m1"></span></p><div id="r1"></div></div>
<div class="panel"><strong>2. What should the platform do?</strong><p class="hint">Twelve payout situations. Choose the action for each, then score.</p><div id="sq"></div><p><button type="button" id="qgo">Score</button> <span class="hint" id="m2"></span></p><div id="r2"></div></div>
<p class="hint">Related: <a href="/knowledge/how-marketplace-payouts-work">How marketplace payouts work</a>, <a href="/knowledge/payout-risk-reserves-and-negative-balances">Payout risk, reserves and negative balances</a>, <a href="/academy/payouts-for-platforms">Payouts course</a>, <a href="/labs/clearing">Clearing and reconciliation</a>.</p></div>`;
    const script = `function $(i){return document.getElementById(i);}async function api(a,b,c){if(!(await Z.ensureKey()))return {status:0,body:{}};return Z.api(a,b,c);}
var OPT=${JSON.stringify(OPT)};var EV=[];
function drawEv(){$("evs").innerHTML=EV.map(function(e,i){return '<div class="ev"><b>'+(e.k==="sales"?"Sale":e.k==="refunds"?"Refund":"Chargeback")+'</b> day <input type="number" min="1" max="45" value="'+e.day+'" data-i="'+i+'" data-f="day"> amount <input type="number" min="1" value="'+e.amount+'" data-i="'+i+'" data-f="amount"> <button type="button" data-rm="'+i+'">Remove</button></div>';}).join("");}
$("evs").oninput=function(e){var i=e.target.getAttribute("data-i");if(i===null)return;EV[+i][e.target.getAttribute("data-f")]=parseFloat(e.target.value)||0;};
$("evs").onclick=function(e){var i=e.target.getAttribute("data-rm");if(i===null)return;EV.splice(+i,1);drawEv();};
document.querySelectorAll("[data-a]").forEach(function(b){b.onclick=function(){var k=b.getAttribute("data-a");EV.push({k:k,day:k==="sales"?1:10,amount:k==="sales"?500:300});drawEv();};});
function setS(o){["sc","dl","rs","rd","mp","cm","ff","vd"].forEach(function(id){if(o[id]!==undefined)$(id).value=o[id];});}
var PRE={steady:function(){setS({sc:"weekly",dl:2,rs:0,rd:0,vd:0});EV=[{k:"sales",day:1,amount:400},{k:"sales",day:3,amount:600},{k:"sales",day:8,amount:500},{k:"sales",day:15,amount:700}];},
cb:function(){setS({sc:"daily",dl:0,rs:0,rd:0,vd:0});EV=[{k:"sales",day:1,amount:1000},{k:"sales",day:2,amount:800},{k:"chargebacks",day:20,amount:1500}];},
reserve:function(){setS({sc:"daily",dl:2,rs:10,rd:30,vd:0});EV=[{k:"sales",day:1,amount:1000},{k:"sales",day:2,amount:800},{k:"chargebacks",day:20,amount:120}];},
kyc:function(){setS({sc:"daily",dl:1,rs:0,rd:0,vd:10});EV=[{k:"sales",day:1,amount:3000},{k:"sales",day:2,amount:2500}];}};
document.querySelectorAll("[data-p]").forEach(function(b){b.onclick=function(){PRE[b.getAttribute("data-p")]();drawEv();run();};});
async function run(){var body={schedule:$("sc").value,delay_days:+$("dl").value,reserve_percent:+$("rs").value,reserve_days:+$("rd").value,minimum_payout:+$("mp").value,commission_percent:+$("cm").value,fixed_fee:+$("ff").value,verified_day:+$("vd").value};["sales","refunds","chargebacks"].forEach(function(k){body[k]=EV.filter(function(e){return e.k===k;}).map(function(e){return {day:e.day,amount:e.amount};});});
var r=await api("POST","/v1/payouts/simulate",body);if(r.status!==200){$("m1").textContent=Z.msg(r);return;}$("m1").textContent="";var j=r.body,s=j.summary;
var rows=j.timeline.filter(function(t){return t.events.length||t.payout_status||t.day%7===0||t.day===45;});
$("r1").innerHTML='<p>Gross sales <b>'+s.gross_sales.toFixed(2)+"</b>. Platform fees "+s.platform_fees.toFixed(2)+". Paid out <b>"+s.paid_out.toFixed(2)+"</b> in "+s.payouts+" payout(s). On day 45: pending "+s.pending_at_end.toFixed(2)+", reserved "+s.reserved_at_end.toFixed(2)+", available <b>"+s.available_at_end.toFixed(2)+"</b>. Lowest balance "+s.lowest_balance.toFixed(2)+".</p>"+(j.warnings.length?"<ul>"+j.warnings.map(function(w){return "<li>"+Z.esc(w)+"</li>";}).join("")+"</ul>":"")+'<table class="t"><tr><th>Day</th><th>What happened</th><th>Pending</th><th>Reserved</th><th>Available</th><th>Paid out</th></tr>'+rows.map(function(t){return "<tr><td>"+t.day+"</td><td>"+t.events.map(Z.esc).join("<br>")+(t.payout_status&&t.payout_status!=="paid"?'<br><span class="warn">'+Z.esc(t.payout_status)+"</span>":"")+"</td><td>"+t.pending.toFixed(2)+"</td><td>"+t.reserved.toFixed(2)+'</td><td class="'+(t.available<0?"bad":"")+'">'+t.available.toFixed(2)+"</td><td>"+(t.paid_out?'<b class="good">'+t.paid_out.toFixed(2)+"</b>":"-")+"</td></tr>";}).join("")+"</table>";}
$("go").onclick=run;$("clr").onclick=function(){EV=[];drawEv();$("r1").innerHTML="";};
function opts(){return Object.keys(OPT).map(function(k){return '<option value="'+k+'">'+Z.esc(OPT[k])+"</option>";}).join("");}
async function loadSc(){var r=await api("GET","/v1/payouts/scenarios");if(r.status!==200)return;$("sq").innerHTML=r.body.scenarios.map(function(s){return '<div class="sc"><b>'+s.id+".</b> "+Z.esc(s.text)+'<br><select data-s="'+s.id+'"><option value="">Choose...</option>'+opts()+"</select></div>";}).join("");}
$("qgo").onclick=async function(){var a={};[].slice.call(document.querySelectorAll("#sq select")).forEach(function(s){a[s.getAttribute("data-s")]=s.value;});var r=await api("POST","/v1/payouts/scenarios/score",{answers:a});if(r.status!==200){$("m2").textContent=Z.msg(r);return;}$("m2").textContent="";var j=r.body;
$("r2").innerHTML='<h3 class="'+(j.passed?"good":"bad")+'">'+j.correct+" of "+j.total+(j.passed?": passed":": try again (10 to pass)")+'</h3><table class="t"><tr><th>#</th><th>Right?</th><th>Why</th></tr>'+j.rows.map(function(x){return "<tr><td>"+x.id+'</td><td class="'+(x.correct?"good":"bad")+'">'+(x.correct?"Yes":"No: "+Z.esc(x.answer_name))+"</td><td>"+Z.esc(x.why)+"</td></tr>";}).join("")+"</table>";};
if(Z.hasKey()){PRE.steady();drawEv();loadSc();}else $("top").textContent="Create a test key to start.";`;
    return UI.shell({ title: "Payouts lab – Zanboxx", description: "Pay a marketplace seller: balances, settlement delay, reserves, chargebacks, negative balances and verification holds. Test data only.", active: "labs", body, script });
  }

  return {
    async handle(req, res, path, m) {
      if (m === "GET" && path === "/labs/payouts") { html(res, 200, page()); return true; }
      if (!path.startsWith("/v1/payouts")) return false;
      const acc = ctx.authed(req), t = st(acc);
      if (m === "POST" && path === "/v1/payouts/simulate") {
        const r = simulate(await readBody(req)); t.did.sim_run = true; if (r.flags.negative) t.did.sim_negative = true; if (r.flags.reserve_covered) t.did.sim_reserve = true; if (r.flags.kyc_hold) t.did.sim_kyc = true;
        if (r.settings.schedule === "weekly") t.did.sim_weekly = true; save(acc); const { flags, ...rest } = r; send(res, 200, rest); return true;
      }
      if (m === "GET" && path === "/v1/payouts/scenarios") { send(res, 200, { scenarios: SCEN.map((s) => ({ id: s.id, text: s.text })), options: OPT }); return true; }
      if (m === "POST" && path === "/v1/payouts/scenarios/score") {
        const a = (await readBody(req)).answers; if (!a || typeof a !== "object") throw bad(400, "invalid_request", "answers must be an object of scenario id to action");
        let ok = 0; const rows = [];
        for (const s of SCEN) { const v = a[s.id] || a[String(s.id)]; if (v !== undefined && v !== "" && !OPT[v]) throw bad(400, "invalid_request", `Scenario ${s.id}: unknown action '${v}'`); const c = v === s.answer; if (c) ok++; rows.push({ id: s.id, correct: c, answer: s.answer, answer_name: OPT[s.answer], why: s.why }); }
        const passed = ok >= 10; t.did.scen_done = true; if (passed) t.did.scen_pass = true; save(acc); send(res, 200, { correct: ok, total: SCEN.length, passed, rows }); return true;
      }
      return false;
    },
  };
};
