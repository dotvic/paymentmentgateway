"use strict";
// Card account lifecycle lab (issuer view): run an invented credit card account through up to eight monthly cycles.
// Interest and grace, minimum payment, late and overlimit fees, delinquency stages, payment application, open-to-buy.
// A teaching model: every rate, fee, threshold and rule is invented and simplified. Real issuers differ.

module.exports = function ({ html, ctx, UI, esc }) {
  const { send, bad, readBody, save } = ctx;
  const st = (acc) => (acc.life = acc.life || { did: {} });
  const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

  const TERMS = {
    credit_limit: 3000, retail_apr_percent: 24, cash_apr_percent: 28, year_base_days: 360, cycle_days: 30, payment_due_day: 20,
    cash_fee_percent: 3, cash_fee_minimum: 2, late_fee: 25, overlimit_fee: 15, minimum_floor: 25, minimum_rate_percent: 4,
    payment_order: ["fees", "interest", "cash", "retail"],
    delinquency: [{ days: 1, state: "Late", card: "open" }, { days: 30, state: "Delinquent", card: "cash blocked" }, { days: 60, state: "Seriously delinquent", card: "blocked" }, { days: 90, state: "Frozen", card: "closed; interest and fees stop (switchable)" }],
    notes: ["Retail purchases are interest-free while you pay each statement in full by the due date (grace). Cash advances never get grace.", "Interest is calculated each day on the balance, on a 360-day year, and billed on the statement.", "The minimum covers interest and fees so the balance cannot grow from the minimum alone.", "This model charges no interest on interest or fees. Many real products do, and many cap how much can be charged.", "All numbers are invented."],
  };

  function validEvent(o, label, defDay) {
    if (o === undefined || o === null) return null;
    if (typeof o !== "object") throw bad(400, "invalid_request", label + " must be an object with amount and day");
    const a = Number(o.amount), d = o.day === undefined ? defDay : Number(o.day);
    if (!Number.isFinite(a) || a < 0 || a > 100000) throw bad(400, "invalid_request", label + " amount must be between 0 and 100000");
    if (!Number.isInteger(d) || d < 1 || d > 30) throw bad(400, "invalid_request", label + " day must be a whole number from 1 to 30");
    return a > 0 ? { amount: r2(a), day: d } : null;
  }

  function simulate(b) {
    const plan = b && b.cycles; if (!Array.isArray(plan) || plan.length < 1 || plan.length > 8) throw bad(400, "invalid_request", "cycles must be a list of 1 to 8 cycles");
    const stop90 = (b.interest_after_90 || "stop") !== "continue"; if (b.interest_after_90 && !["stop", "continue"].includes(b.interest_after_90)) throw bad(400, "invalid_request", "interest_after_90 must be stop or continue");
    const T = TERMS, yb = T.year_base_days, orderKeys = T.payment_order;
    const bal = { fees: 0, interest: 0, cash: 0, retail: 0 }, total = () => r2(bal.fees + bal.interest + bal.cash + bal.retail);
    let due = 0, lastStmt = 0, pastSince = null, closed = false, status = "open"; const out = [], flags = {};
    plan.forEach((cy, i) => {
      const c = i + 1, ev = [], R = validEvent(cy && cy.retail, "Cycle " + c + " retail", 5), C = validEvent(cy && cy.cash, "Cycle " + c + " cash", 10), P = validEvent(cy && cy.payment, "Cycle " + c + " payment", 15);
      let accCash = 0, accRetail = 0, paid20 = 0, paidAll = 0, late = false, cycFees = 0; const log = [];
      for (let d = 1; d <= 30; d++) {
        if (R && R.day === d) {
          if (status === "blocked" || closed) log.push({ day: d, type: "Retail purchase", amount: R.amount, result: "Declined: card is " + (closed ? "closed" : "blocked") });
          else if (total() + R.amount > T.credit_limit) log.push({ day: d, type: "Retail purchase", amount: R.amount, result: "Declined: over the credit limit" });
          else { bal.retail = r2(bal.retail + R.amount); log.push({ day: d, type: "Retail purchase", amount: R.amount, result: "Approved" }); }
        }
        if (C && C.day === d) {
          const fee = Math.max(T.cash_fee_minimum, r2(C.amount * T.cash_fee_percent / 100));
          if (status !== "open" || closed) log.push({ day: d, type: "Cash advance", amount: C.amount, result: "Declined: cash is blocked on this account" });
          else if (total() + C.amount + fee > T.credit_limit) log.push({ day: d, type: "Cash advance", amount: C.amount, result: "Declined: over the credit limit" });
          else { bal.cash = r2(bal.cash + C.amount); bal.fees = r2(bal.fees + fee); cycFees = r2(cycFees + fee); log.push({ day: d, type: "Cash advance", amount: C.amount, result: "Approved. Cash fee " + fee.toFixed(2) }); }
        }
        if (P && P.day === d) {
          let pay = Math.min(P.amount, total()), left = pay, parts = [];
          for (const k of orderKeys) { const x = Math.min(bal[k], left); if (x > 0) { bal[k] = r2(bal[k] - x); left = r2(left - x); parts.push(k + " " + x.toFixed(2)); } }
          paidAll = r2(paidAll + pay); if (d <= T.payment_due_day) paid20 = r2(paid20 + pay);
          log.push({ day: d, type: "Payment", amount: P.amount, result: pay === 0 ? "Nothing owed, payment not taken" : (pay < P.amount ? "Capped at the balance owed. " : "") + "Applied to " + parts.join(", ") + (d > T.payment_due_day ? ". After the due date." : "") });
        }
        if (bal.cash > 0) accCash += bal.cash * T.cash_apr_percent / 100 / yb;
        if (bal.retail > 0) accRetail += bal.retail * T.retail_apr_percent / 100 / yb;
        if (d === T.payment_due_day && due > 0 && paid20 + 0.005 < due) late = true;
      }
      // statement
      const overdue = due > 0 ? Math.max(0, r2(due - paidAll)) : 0;
      if (due > 0 && overdue > 0) { if (pastSince === null) pastSince = (c - 1) * 30 + T.payment_due_day; } else pastSince = null;
      const g = c * 30, daysPast = pastSince === null ? 0 : g - pastSince;
      const frozen = stop90 && daysPast >= 90;
      const graceKept = lastStmt === 0 || paid20 + 0.005 >= lastStmt;
      const intBilled = frozen ? 0 : r2(accCash + (graceKept ? 0 : accRetail)), graceSaved = graceKept && !frozen ? r2(accRetail) : 0;
      const lateFee = late && !frozen ? T.late_fee : 0; bal.interest = r2(bal.interest + intBilled); bal.fees = r2(bal.fees + lateFee); cycFees = r2(cycFees + lateFee);
      const overFee = !frozen && total() > T.credit_limit ? T.overlimit_fee : 0; bal.fees = r2(bal.fees + overFee); cycFees = r2(cycFees + overFee);
      const tot = total();
      const minimum = tot === 0 ? 0 : r2(Math.min(tot, Math.max(T.minimum_floor, r2((bal.cash + bal.retail) * T.minimum_rate_percent / 100)) + intBilled + cycFees + overdue));
      const stage = daysPast >= 90 ? 3 : daysPast >= 60 ? 2 : daysPast >= 30 ? 1 : daysPast >= 1 ? 0 : -1;
      const stateName = stage < 0 ? "Current" : T.delinquency[stage].state;
      status = stage >= 2 ? "blocked" : stage >= 1 ? "restricted" : "open"; if (stage === 3) closed = true; if (tot === 0) closed = false;
      const cardStatus = closed ? "closed" : status === "blocked" ? "blocked" : status === "restricted" ? "cash blocked" : "open";
      if (graceSaved > 0 && R) flags.grace = true; if (lateFee > 0) flags.late = true; if (stage >= 1) flags.delinquent30 = true; if (stage === 3) flags.frozen = true;
      if (flags.delinquent30 && stage < 0 && c > 1) flags.recovered = true; if (overFee > 0) flags.overlimit = true;
      out.push({ cycle: c, events: log, interest_billed: intBilled, retail_interest_waived_by_grace: graceSaved, late_fee: lateFee, overlimit_fee: overFee, balance: tot, minimum_due: minimum, due_in_next_cycle_on_day: T.payment_due_day, days_past_due: daysPast, state: stateName, card: cardStatus, grace_next_cycle: tot === 0, breakdown: { fees: bal.fees, interest: bal.interest, cash: bal.cash, retail: bal.retail } });
      due = minimum; lastStmt = tot;
    });
    const last = out[out.length - 1], tips = [];
    if (flags.late) tips.push("Missing the due date cost a late fee and also meant the next statement's grace was lost.");
    if (flags.overlimit) tips.push("Interest and fees pushed the balance over the limit. An overlimit fee followed, and the next minimum rose to include the overlimit amount.");
    if (flags.frozen) tips.push(stop90 ? "After 90 days overdue this model stops interest and fees and closes the card. The debt remains and would normally go to collections or be written off." : "Interest kept growing past 90 days because you chose to continue it. Compare the final balance with the stop option.");
    if (flags.grace) tips.push("Grace saved retail interest because the previous statement was paid in full by the due date. Cash advances were charged interest from the day taken.");
    return { terms_used: { credit_limit: T.credit_limit, interest_after_90: stop90 ? "stop" : "continue" }, cycles: out, final_balance: last.balance, final_state: last.state, total_interest: r2(out.reduce((a, x) => a + x.interest_billed, 0)), total_fees: r2(out.reduce((a, x) => a + x.late_fee + x.overlimit_fee, 0)), tips, flags };
  }

  function interestCalc(b) {
    const bal = Number(b.balance), apr = Number(b.apr_percent), days = Number(b.days), yb = Number(b.year_base || 365);
    if (!(bal >= 0 && bal <= 1e6) || !(apr >= 0 && apr <= 100) || !Number.isInteger(days) || days < 1 || days > 31 || ![360, 365, 366].includes(yb)) throw bad(400, "invalid_request", "balance 0 to 1000000, apr_percent 0 to 100, days 1 to 31 and year_base 360, 365 or 366 are required");
    const daily = r2(bal * apr / 100 * days / yb), monthly30 = r2(bal * apr / 100 * 30 / yb);
    const kind = b.kind === "cash" ? "cash" : "retail", grace = b.grace_applies === true && kind === "retail";
    return { balance: bal, apr_percent: apr, days, year_base: yb, kind, daily_accrual_interest: grace ? 0 : daily, monthly_method_interest: grace ? 0 : monthly30, difference: grace ? 0 : r2(daily - monthly30), grace_applied: grace, per_day: grace ? 0 : +(bal * apr / 100 / yb).toFixed(4),
      explanation: grace ? "Retail purchases in a cycle where the previous statement was paid in full carry no interest." : kind === "cash" ? "Cash advances accrue interest from the day taken, with no grace." : "Interest is balance times rate times days divided by the year base. A monthly method that always uses 30 days gives a slightly different result in a 31-day month." };
  }

  function applyPay(b) {
    const k = ["fees", "interest", "cash", "retail"], bal = b.buckets, pay = Number(b.payment), order = b.order || k;
    if (!bal || typeof bal !== "object" || k.some((x) => !(Number(bal[x]) >= 0 && Number(bal[x]) <= 1e6))) throw bad(400, "invalid_request", "buckets must give fees, interest, cash and retail amounts");
    if (!(pay >= 0 && pay <= 1e6)) throw bad(400, "invalid_request", "payment must be between 0 and 1000000");
    if (!Array.isArray(order) || order.length !== 4 || k.some((x) => !order.includes(x))) throw bad(400, "invalid_request", "order must list fees, interest, cash and retail once each");
    const rem = Object.fromEntries(k.map((x) => [x, r2(Number(bal[x]))])); let left = r2(pay); const steps = [];
    for (const x of order) { const t = Math.min(rem[x], left); if (t > 0) steps.push({ bucket: x, applied: r2(t) }); rem[x] = r2(rem[x] - t); left = r2(left - t); }
    const est = r2(rem.cash * TERMS.cash_apr_percent / 100 / 12 + rem.retail * TERMS.retail_apr_percent / 100 / 12), best = ["fees", "interest", "cash", "retail"];
    const alt = { ...Object.fromEntries(k.map((x) => [x, r2(Number(bal[x]))])) }; let l2 = r2(pay); for (const x of best) { const t = Math.min(alt[x], l2); alt[x] = r2(alt[x] - t); l2 = r2(l2 - t); }
    const altEst = r2(alt.cash * TERMS.cash_apr_percent / 100 / 12 + alt.retail * TERMS.retail_apr_percent / 100 / 12);
    return { steps, remaining: rem, unapplied: left, next_month_interest_estimate: est, estimate_with_cheapest_order_for_customer: altEst, note: "The estimate ignores grace and uses a simple month. Applying payments to the highest-rate balance first leaves the customer paying less interest." };
  }

  function otb(b) {
    const limit = Number(b.limit), bal = Number(b.balance), holds = b.holds, nw = b.new_authorisation === undefined ? null : Number(b.new_authorisation);
    if (!(limit > 0 && limit <= 1e6) || !(bal >= 0 && bal <= 1e6) || !Array.isArray(holds) || holds.length > 10) throw bad(400, "invalid_request", "limit, balance and up to 10 holds are required");
    const h = holds.map((x, i) => { const a = Number(x.amount), d = Number(x.days_left); if (!(a > 0 && a <= 1e6) || !Number.isInteger(d) || d < 0 || d > 60) throw bad(400, "invalid_request", "Hold " + (i + 1) + ": amount and days_left (0 to 60) required"); return { amount: r2(a), days_left: d }; });
    const held = r2(h.reduce((s, x) => s + x.amount, 0)), open = r2(limit - bal - held), timeline = [];
    for (const d of [0, 1, 3, 7, 14, 30]) { const hd = r2(h.filter((x) => x.days_left > d).reduce((s, x) => s + x.amount, 0)); timeline.push({ day: d, holds: hd, open_to_buy: r2(limit - bal - hd) }); }
    let decision = null; if (nw !== null) { if (!(nw > 0 && nw <= 1e6)) throw bad(400, "invalid_request", "new_authorisation must be a positive amount"); decision = nw <= open ? { approved: true, open_to_buy_after: r2(open - nw), reason: "Within open-to-buy." } : { approved: false, open_to_buy_after: open, reason: "Exceeds open-to-buy by " + r2(nw - open).toFixed(2) + ". Holds that have not cleared still use the limit." }; }
    return { credit_limit: limit, posted_balance: bal, holds_total: held, open_to_buy: open, timeline, decision, note: "Open-to-buy is the limit minus the posted balance minus holds. Holds drop when the sale posts or the hold expires." };
  }

  function page() {
    const rowsInit = 8;
    const body = `<style>.cy{display:grid;grid-template-columns:34px repeat(6,minmax(70px,1fr));gap:6px;align-items:center;margin:4px 0}.cy input{width:100%;min-width:0}.cyh{font-size:12px;color:var(--mute,#5b6478)}.pc button.on{outline:2px solid #3b6cff}.t td,.t th{padding:5px 8px;border-bottom:1px solid var(--line,#e3e7ef);text-align:left;vertical-align:top}.bad{color:#b3261e}.good{color:#1b7a3d}.warn{color:#9a6700}#r1,#r2,#r3,#r4{overflow-x:auto}#r1 .t,#r2 .t,#r3 .t,#r4 .t{display:table;width:100%}#r1 .t{font-size:14px}#r1 .t td,#r1 .t th{padding:5px 6px}#r1 td:nth-child(2){width:280px;white-space:normal;overflow-wrap:anywhere}.cy-wrap{overflow-x:auto}.cy-wrap .cy{min-width:620px}.fl2 label{display:inline-block;margin:4px 10px 4px 0}.fl2 input,.fl2 select{max-width:calc(100vw - 80px)}</style><div class="wrap"><h1>Card account lifecycle</h1>
<p class="lede">This is what happens after a card is issued. Run a fictional credit account through up to eight monthly cycles and watch interest, grace, the minimum payment, fees and delinquency respond to what you do. Everything here is a teaching model with invented rates, fees and rules, and you use test data only.</p>
<p class="hint" id="top"></p>
<div class="panel"><strong>The account</strong><p id="terms" class="hint"></p></div>
<div class="panel"><strong>1. Monthly simulator</strong><p class="hint">Each row is one 30-day cycle. A payment made in the cycle counts toward the previous statement. The due date is day 20 of the cycle. Leave an amount at 0 to skip it.</p>
<p class="pc">Try: <button type="button" data-p="full">Pay in full</button> <button type="button" data-p="min">Pay the minimum</button> <button type="button" data-p="late">Pay late</button> <button type="button" data-p="none">Stop paying</button> <button type="button" data-p="recover">Fall behind then recover</button></p>
<div class="cy-wrap"><div class="cy cyh"><span>#</span><span>Retail 1</span><span>Day</span><span>Cash</span><span>Day</span><span>Payment</span><span>Day</span></div><div id="cy"></div></div>
<p class="fl2"><label>After 90 days overdue: <select id="a90"><option value="stop">stop interest and fees</option><option value="continue">keep charging</option></select></label> <button type="button" id="go">Run the account</button> <button type="button" id="clr">Clear</button> <span class="hint" id="m1"></span></p><div id="r1"></div></div>
<div class="panel"><strong>2. Interest calculator</strong><p class="hint">See how interest is worked out, and why a 30-day monthly method gives a different answer in a 31-day month.</p>
<p class="fl2"><label>Balance <input type="number" id="ib" value="1000" min="0"></label><label>Rate % <input type="number" id="ia" value="18" min="0" step="0.1"></label><label>Days <input type="number" id="id" value="31" min="1" max="31"></label><label>Year <select id="iy"><option>365</option><option>360</option><option>366</option></select></label><label>Type <select id="ik"><option value="retail">retail</option><option value="cash">cash advance</option></select></label><label><input type="checkbox" id="ig"> grace applies</label> <button type="button" id="igo">Calculate</button> <span class="hint" id="m2"></span></p><div id="r2"></div></div>
<div class="panel"><strong>3. Payment application</strong><p class="hint">A payment is split across what you owe in a chosen order. The order changes how much interest you pay next month.</p>
<p class="fl2"><label>Fees <input type="number" id="pf" value="30" min="0"></label><label>Interest <input type="number" id="pi" value="16" min="0"></label><label>Cash <input type="number" id="pc" value="1000" min="0"></label><label>Retail <input type="number" id="pr" value="800" min="0"></label><label>Payment <input type="number" id="pp" value="500" min="0"></label></p>
<p class="fl2"><label>Order <select id="po"><option value="fees,interest,cash,retail">fees, interest, cash, retail</option><option value="fees,interest,retail,cash">fees, interest, retail, cash</option><option value="retail,cash,interest,fees">retail, cash, interest, fees</option><option value="cash,retail,interest,fees">cash, retail, interest, fees</option></select></label> <button type="button" id="pgo">Apply</button> <span class="hint" id="m3"></span></p><div id="r3"></div></div>
<div class="panel"><strong>4. Open-to-buy and holds</strong><p class="hint">Authorisations use up the credit limit before they post. Try an approval that fits only after a hold expires.</p>
<p class="fl2"><label>Limit <input type="number" id="ol" value="3000" min="1"></label><label>Posted balance <input type="number" id="ob" value="2200" min="0"></label><label>Hold 1 <input type="number" id="oa" value="500" min="0"></label><label>days left <input type="number" id="od" value="5" min="0" max="60"></label><label>Hold 2 <input type="number" id="oa2" value="250" min="0"></label><label>days left <input type="number" id="od2" value="1" min="0" max="60"></label><label>New authorisation <input type="number" id="on" value="300" min="1"></label> <button type="button" id="ogo">Check</button> <span class="hint" id="m4"></span></p><div id="r4"></div></div>
<p class="hint">Related: <a href="/knowledge/credit-card-account-lifecycle">Credit card account lifecycle</a>, <a href="/knowledge/interest-grace-and-minimum-payments">Interest, grace and minimum payments</a>, <a href="/knowledge/delinquency-collections-and-charge-off">Delinquency and charge-off</a>, <a href="/academy/card-account-lifecycle">Course</a>, <a href="/labs/types">Transaction types</a>.</p></div>`;
    const script = `function $(i){return document.getElementById(i);}async function api(a,b,c){if(!(await Z.ensureKey()))return {status:0,body:{}};return Z.api(a,b,c);}
var N=${rowsInit};
function row(i){return '<div class="cy"><b>'+(i+1)+'</b><input type="number" min="0" aria-label="Retail" data-k="r'+i+'a" value="0"><input type="number" min="1" max="30" aria-label="Retail day" data-k="r'+i+'d" value="5"><input type="number" min="0" aria-label="Cash" data-k="c'+i+'a" value="0"><input type="number" min="1" max="30" aria-label="Cash day" data-k="c'+i+'d" value="10"><input type="number" min="0" aria-label="Payment" data-k="p'+i+'a" value="0"><input type="number" min="1" max="30" aria-label="Payment day" data-k="p'+i+'d" value="15"></div>';}
function build(){var h="";for(var i=0;i<N;i++)h+=row(i);$("cy").innerHTML=h;}
function setv(k,v){var e=document.querySelector('[data-k="'+k+'"]');if(e)e.value=v;}
function clearAll(){build();$("r1").innerHTML="";}
var PRE={full:function(){setv("r0a",500);setv("c0a",300);setv("p1a",830);setv("r1a",200);setv("p2a",200);setv("p3a",0);},
min:function(){setv("r0a",1200);setv("c0a",500);for(var i=1;i<8;i++)setv("p"+i+"a",100);},
late:function(){setv("r0a",800);setv("p1a",840);setv("p1d",25);setv("p2a",100);setv("p2d",25);},
none:function(){setv("r0a",1000);setv("c0a",1000);},
recover:function(){setv("r0a",800);setv("c0a",600);setv("p3a",600);setv("p4a",800);setv("p5a",800);setv("p6a",800);}};
document.querySelectorAll("[data-p]").forEach(function(b){b.onclick=function(){build();PRE[b.getAttribute("data-p")]();run();};});
function val(k){var e=document.querySelector('[data-k="'+k+'"]');return parseFloat(e.value)||0;}
function plan(){var c=[];var last=-1;for(var i=0;i<N;i++){var any=val("r"+i+"a")||val("c"+i+"a")||val("p"+i+"a");if(any)last=i;}if(last<0)last=0;for(var j=0;j<=last||j<1;j++){c.push({retail:{amount:val("r"+j+"a"),day:Math.round(val("r"+j+"d"))||5},cash:{amount:val("c"+j+"a"),day:Math.round(val("c"+j+"d"))||10},payment:{amount:val("p"+j+"a"),day:Math.round(val("p"+j+"d"))||15}});}
if(c.length<N&&PRE_ALL)for(var k=c.length;k<N;k++)c.push({});return c;}
var PRE_ALL=true;
async function run(){var r=await api("POST","/v1/lifecycle/simulate",{cycles:plan(),interest_after_90:$("a90").value});if(r.status!==200){$("m1").textContent=Z.msg(r);return;}$("m1").textContent="";var j=r.body;
var cls=function(s){return s==="Current"?"good":s==="Late"?"warn":"bad";};
$("r1").innerHTML='<table class="t"><tr><th>Cycle</th><th>What happened</th><th>Interest</th><th>Fees</th><th>Balance</th><th>Minimum due</th><th>State</th></tr>'+j.cycles.map(function(x){var ev=x.events.map(function(e){return "Day "+e.day+": "+Z.esc(e.type)+" "+e.amount.toFixed(2)+" - "+Z.esc(e.result);}).join("<br>");var f=(x.late_fee+x.overlimit_fee);return "<tr><td>"+x.cycle+"</td><td>"+(ev||"No activity")+(x.retail_interest_waived_by_grace>0?'<br><span class="good">Grace saved '+x.retail_interest_waived_by_grace.toFixed(2)+" of retail interest</span>":"")+"</td><td>"+x.interest_billed.toFixed(2)+"</td><td>"+f.toFixed(2)+(x.late_fee?" (late)":"")+(x.overlimit_fee?" (overlimit)":"")+"</td><td>"+x.balance.toFixed(2)+"</td><td>"+x.minimum_due.toFixed(2)+'</td><td class="'+cls(x.state)+'">'+Z.esc(x.state)+(x.days_past_due?" ("+x.days_past_due+" days)":"")+"<br><small>Card: "+Z.esc(x.card)+"</small></td></tr>";}).join("")+"</table><p>Final balance <b>"+j.final_balance.toFixed(2)+"</b>. Interest billed in total "+j.total_interest.toFixed(2)+". Fees "+j.total_fees.toFixed(2)+".</p>"+(j.tips.length?"<ul>"+j.tips.map(function(t){return "<li>"+Z.esc(t)+"</li>";}).join("")+"</ul>":"");}
$("go").onclick=run;$("clr").onclick=clearAll;
$("igo").onclick=async function(){var r=await api("POST","/v1/lifecycle/interest",{balance:parseFloat($("ib").value),apr_percent:parseFloat($("ia").value),days:parseInt($("id").value,10),year_base:parseInt($("iy").value,10),kind:$("ik").value,grace_applies:$("ig").checked});if(r.status!==200){$("m2").textContent=Z.msg(r);return;}$("m2").textContent="";var j=r.body;$("r2").innerHTML='<table class="t"><tr><td>Interest accrued daily over the actual days</td><td><b>'+j.daily_accrual_interest.toFixed(2)+'</b></td></tr><tr><td>Monthly method (always 30 days)</td><td><b>'+j.monthly_method_interest.toFixed(2)+'</b></td></tr><tr><td>Difference</td><td>'+j.difference.toFixed(2)+'</td></tr><tr><td>Per day</td><td>'+j.per_day+"</td></tr></table><p>"+Z.esc(j.explanation)+"</p>";};
$("pgo").onclick=async function(){var r=await api("POST","/v1/lifecycle/payment-apply",{buckets:{fees:parseFloat($("pf").value),interest:parseFloat($("pi").value),cash:parseFloat($("pc").value),retail:parseFloat($("pr").value)},payment:parseFloat($("pp").value),order:$("po").value.split(",")});if(r.status!==200){$("m3").textContent=Z.msg(r);return;}$("m3").textContent="";var j=r.body;$("r3").innerHTML='<table class="t"><tr><th>Applied to</th><th>Amount</th></tr>'+j.steps.map(function(s){return "<tr><td>"+s.bucket+"</td><td>"+s.applied.toFixed(2)+"</td></tr>";}).join("")+"</table><p>Left owing: fees "+j.remaining.fees.toFixed(2)+", interest "+j.remaining.interest.toFixed(2)+", cash "+j.remaining.cash.toFixed(2)+", retail "+j.remaining.retail.toFixed(2)+".</p><p>Next month interest estimate with this order: <b>"+j.next_month_interest_estimate.toFixed(2)+"</b>. With the cheapest order for the customer: <b>"+j.estimate_with_cheapest_order_for_customer.toFixed(2)+"</b>.</p><p class=hint>"+Z.esc(j.note)+"</p>";};
$("ogo").onclick=async function(){var h=[];if(parseFloat($("oa").value)>0)h.push({amount:parseFloat($("oa").value),days_left:parseInt($("od").value,10)});if(parseFloat($("oa2").value)>0)h.push({amount:parseFloat($("oa2").value),days_left:parseInt($("od2").value,10)});var r=await api("POST","/v1/lifecycle/open-to-buy",{limit:parseFloat($("ol").value),balance:parseFloat($("ob").value),holds:h,new_authorisation:parseFloat($("on").value)});if(r.status!==200){$("m4").textContent=Z.msg(r);return;}$("m4").textContent="";var j=r.body;$("r4").innerHTML="<p>Open-to-buy now: <b>"+j.open_to_buy.toFixed(2)+"</b> (limit "+j.credit_limit.toFixed(2)+" minus posted "+j.posted_balance.toFixed(2)+" minus holds "+j.holds_total.toFixed(2)+")</p>"+(j.decision?'<p class="'+(j.decision.approved?"good":"bad")+'"><b>'+(j.decision.approved?"Approved":"Declined")+".</b> "+Z.esc(j.decision.reason)+"</p>":"")+'<table class="t"><tr><th>In (days)</th><th>Holds still on</th><th>Open-to-buy</th></tr>'+j.timeline.map(function(t){return "<tr><td>"+t.day+"</td><td>"+t.holds.toFixed(2)+"</td><td>"+t.open_to_buy.toFixed(2)+"</td></tr>";}).join("")+"</table><p class=hint>"+Z.esc(j.note)+"</p>";};
build();
(async function(){if(!Z.hasKey()){$("top").textContent="Create a test key to start.";return;}var r=await api("GET","/v1/lifecycle/terms");if(r.status===200){var t=r.body;$("terms").textContent="Credit limit "+t.credit_limit+". Retail rate "+t.retail_apr_percent+"% with grace, cash rate "+t.cash_apr_percent+"% with no grace. Cash fee "+t.cash_fee_percent+"% (minimum "+t.cash_fee_minimum+"). Late fee "+t.late_fee+", overlimit fee "+t.overlimit_fee+". 30-day cycles, 360-day year, due on day "+t.payment_due_day+". Minimum is the larger of "+t.minimum_floor+" or "+t.minimum_rate_percent+"% of principal, plus interest and fees. Overdue 30, 60 and 90 days block cash, block the card and freeze it.";}})();`;
    return UI.shell({ title: "Card account lifecycle lab – Zanboxx", description: "Run a fictional credit card account through monthly cycles: interest, grace, minimum payments, fees, delinquency, payment application and open-to-buy. Test data only.", active: "labs", body, script });
  }

  return {
    async handle(req, res, path, m) {
      if (m === "GET" && path === "/labs/account") { html(res, 200, page()); return true; }
      if (!path.startsWith("/v1/lifecycle")) return false;
      const acc = ctx.authed(req), t = st(acc);
      if (m === "GET" && path === "/v1/lifecycle/terms") { send(res, 200, TERMS); return true; }
      if (m === "POST" && path === "/v1/lifecycle/simulate") {
        const r = simulate(await readBody(req)); t.did.sim_run = true; for (const k of Object.keys(r.flags)) t.did["sim_" + k] = true; if (r.cycles.length >= 6) t.did.sim_long = true; save(acc);
        const { flags, ...rest } = r; send(res, 200, rest); return true;
      }
      if (m === "POST" && path === "/v1/lifecycle/interest") { const r = interestCalc(await readBody(req)); t.did.interest_calc = true; if (r.grace_applied) t.did.interest_grace = true; if (r.kind === "cash") t.did.interest_cash = true; save(acc); send(res, 200, r); return true; }
      if (m === "POST" && path === "/v1/lifecycle/payment-apply") { const b = await readBody(req), r = applyPay(b); t.did.pay_apply = true; if (r.next_month_interest_estimate > r.estimate_with_cheapest_order_for_customer) t.did.pay_order_worse = true; save(acc); send(res, 200, r); return true; }
      if (m === "POST" && path === "/v1/lifecycle/open-to-buy") { const r = otb(await readBody(req)); t.did.otb_used = true; if (r.decision && !r.decision.approved) t.did.otb_declined = true; save(acc); send(res, 200, r); return true; }
      return false;
    },
  };
};
