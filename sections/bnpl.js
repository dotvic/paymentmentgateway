"use strict";
// Buy-now-pay-later lab: pay-in-four and monthly instalment plans, missed payments, returns, merchant and provider economics,
// affordability and stacking, plus a scenario quiz. A teaching model: all rates, fees and rules are invented and simplified.

module.exports = function ({ html, ctx, UI, esc }) {
  const { send, bad, readBody, save } = ctx;
  const st = (acc) => (acc.bnpl = acc.bnpl || { did: {} });
  const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
  const LATE_FEE = 7, LATE_CAP_PCT = 25, MDR = { pay4: 5, monthly: 6 };
  const PLANS = { pay4: { label: "Pay in 4", n: 4, interval: 14, upfront: true, apr: 0 }, m3: { label: "3 monthly instalments", n: 3, interval: 30, upfront: false }, m6: { label: "6 monthly instalments", n: 6, interval: 30, upfront: false }, m12: { label: "12 monthly instalments", n: 12, interval: 30, upfront: false } };

  function schedule(plan, amount, apr) {
    const P = PLANS[plan], rows = [];
    if (plan === "pay4") { let left = amount; for (let i = 0; i < 4; i++) { const a = i === 3 ? left : r2(amount / 4); left = r2(left - a); rows.push({ n: i + 1, day: i * 14, principal: a, interest: 0, amount: a }); } return rows; }
    const r = apr / 100 / 12, n = P.n; const pmt = r === 0 ? r2(amount / n) : r2(amount * r / (1 - Math.pow(1 + r, -n)));
    let bal = amount;
    for (let i = 1; i <= n; i++) {
      const interest = r2(bal * r); let principal = i === n ? bal : r2(pmt - interest); let a = r2(principal + interest); bal = r2(bal - principal);
      rows.push({ n: i, day: i * 30, principal, interest, amount: a });
    }
    return rows;
  }

  function plan(b) {
    const amount = Number(b.amount), p = b.plan, apr = b.apr_percent === undefined ? (p === "pay4" ? 0 : 19.9) : Number(b.apr_percent);
    if (!PLANS[p]) throw bad(400, "invalid_request", "plan must be one of: " + Object.keys(PLANS).join(", "));
    if (!(amount >= 20 && amount <= 10000)) throw bad(400, "invalid_request", "amount must be between 20 and 10000");
    if (!(apr >= 0 && apr <= 60)) throw bad(400, "invalid_request", "apr_percent must be between 0 and 60");
    const miss = Array.isArray(b.missed) ? [...new Set(b.missed.map(Number))] : []; const rows = schedule(p, amount, p === "pay4" ? 0 : apr);
    if (miss.some((k) => !Number.isInteger(k) || k < (p === "pay4" ? 2 : 1) || k > rows.length)) throw bad(400, "invalid_request", "missed must list instalment numbers from " + (p === "pay4" ? 2 : 1) + " to " + rows.length + (p === "pay4" ? " (the first part is paid at checkout)" : ""));
    const ret = b.return === undefined || b.return === null ? null : b.return;
    let rAmt = 0, rDay = 0;
    if (ret) { rAmt = Number(ret.amount); rDay = Number(ret.day); if (!(rAmt > 0 && rAmt <= amount) || !Number.isInteger(rDay) || rDay < 0 || rDay > 400) throw bad(400, "invalid_request", "return needs an amount up to the order value and a whole day number"); }
    const lateEach = LATE_FEE, lateCap = r2(amount * LATE_CAP_PCT / 100); let lateTotal = 0;
    const lines = rows.map((x) => { const missed = miss.includes(x.n); let fee = 0; if (missed) { fee = Math.min(lateEach, r2(lateCap - lateTotal)); lateTotal = r2(lateTotal + fee); } return { ...x, status: missed ? "missed, paid late" : "paid on time", late_fee: fee }; });
    const interest = r2(rows.reduce((s, x) => s + x.interest, 0)), totalPlan = r2(rows.reduce((s, x) => s + x.amount, 0)), mdr = p === "pay4" ? MDR.pay4 : MDR.monthly, mdrAmt = r2(amount * mdr / 100);
    const out = { plan: p, label: PLANS[p].label, amount, apr_percent: p === "pay4" ? 0 : apr, schedule: lines, interest_total: interest, late_fees_total: lateTotal, customer_total_cost: r2(totalPlan + lateTotal), cost_of_credit: r2(interest + lateTotal),
      merchant: { discount_rate_percent: mdr, fee: mdrAmt, receives_up_front: r2(amount - mdrAmt) }, provider: { revenue: r2(mdrAmt + interest + lateTotal), exposure_at_checkout: r2(amount - (p === "pay4" ? rows[0].amount : 0)) } };
    if (p === "pay4" && miss.length === 0) out.note = "Pay in 4 charges the customer no interest. The merchant pays the provider's fee, so the provider earns from the merchant, not from the buyer.";
    if (ret) {
      const share = rAmt / amount, newOwed = r2(totalPlan * (1 - share)), paidSoFar = r2(lines.filter((x) => x.day <= rDay && x.status === "paid on time").reduce((s, x) => s + x.amount, 0));
      const toCard = Math.max(0, r2(paidSoFar - newOwed)), still = Math.max(0, r2(newOwed - paidSoFar));
      out.return = { amount: rAmt, day: rDay, share_percent: r2(share * 100), paid_before_return: paidSoFar, new_total_owed: newOwed, refunded_to_card: toCard, still_to_pay: still, note: "A return reduces what is still owed first. Money the customer already paid above the new total goes back to their card. Unpaid instalments shrink in proportion." };
    }
    return out;
  }

  function afford(b) {
    const income = Number(b.monthly_income), commits = Number(b.existing_monthly_commitments), active = Number(b.active_plans || 0), amount = Number(b.amount), p = b.plan;
    if (!PLANS[p]) throw bad(400, "invalid_request", "plan must be one of: " + Object.keys(PLANS).join(", "));
    if (!(income > 0 && income <= 1e6) || !(commits >= 0 && commits <= 1e6) || !Number.isInteger(active) || active < 0 || active > 20 || !(amount >= 20 && amount <= 10000)) throw bad(400, "invalid_request", "monthly_income, existing_monthly_commitments, active_plans (0 to 20), amount (20 to 10000) and plan are required");
    const apr = p === "pay4" ? 0 : 19.9, rows = schedule(p, amount, apr), monthly = p === "pay4" ? r2(amount / 2) : rows[0].amount;
    const ratio = r2(((commits + monthly) / income) * 100), reasons = []; let decision, limit = null;
    if (active >= 3) reasons.push("Stacking: three or more active plans at once is a risk flag.");
    if (ratio <= 35 && active < 3) { decision = "approve"; reasons.push("Total payments are within 35 percent of income."); }
    else if (ratio <= 45 && active < 4 && income * 0.35 - commits > 0) { decision = "approve_lower"; limit = r2((income * 0.35 - commits) * (p === "pay4" ? 2 : PLANS[p].n === 3 ? 3 : PLANS[p].n === 6 ? 5 : 8)); reasons.push("Total payments would be between 35 and 45 percent of income. Offer a smaller plan."); }
    else { decision = "decline"; reasons.push(ratio <= 45 && active < 4 ? "Existing commitments already take more than 35 percent of income, so there is no room for a new plan." : "Total payments would be above 45 percent of income or too many plans are open."); }
    if (income - commits - monthly < 150) reasons.push("Less than 150 would be left each month after payments.");
    return { plan: p, monthly_payment_added: monthly, payments_to_income_percent: ratio, decision, suggested_max_order: limit, reasons, note: "A real lender uses credit data and its own rules. This shows the idea of affordability, not a real model." };
  }

  const OPT = { approve: "Approve", approve_lower: "Approve a smaller plan", decline: "Decline", pay4: "Offer pay in 4", monthly: "Offer a monthly plan", refund_card: "Refund the card", reduce_owed: "Reduce what is still owed", fee: "Charge the late fee" };
  const SC = [
    ["A customer with steady income and no other plans asks for pay in 4 on a 120.00 order.", "approve", "Low risk and low amount."],
    ["A customer already has four open plans and asks for a fifth for 600.00.", "decline", "Stacking: that many open plans is a risk flag regardless of the single order."],
    ["A customer's payments would be 41 percent of their income with this plan.", "approve_lower", "Between the thresholds: offer a smaller plan."],
    ["A shopper wants 1,200.00 spread over 12 months and wants the cheapest monthly payment.", "monthly", "Pay in 4 would be too large each instalment. A longer monthly plan suits the amount."],
    ["A shopper wants to split a 60.00 order and does not want to pay any interest.", "pay4", "Pay in 4 charges the buyer no interest."],
    ["A customer returns an order after paying 2 of 4 instalments. The refund is 100 percent of the order.", "refund_card", "What they already paid goes back to their card, and the unpaid instalments are cancelled."],
    ["A customer returns half of a 200.00 order before any instalment after the first is due.", "reduce_owed", "Reduce what they still owe first. Only the excess paid goes back to the card."],
    ["The customer's second instalment was missed and paid ten days late.", "fee", "A late fee applies within the cap."],
    ["The same buyer opened three plans with different providers in one week for similar goods.", "decline", "Rapid stacking across providers is a warning sign."],
    ["A new customer with thin credit history asks for pay in 4 on a 40.00 order.", "approve", "Tiny amount and no interest: provider exposure is minimal."],
  ];
  const SCEN = SC.map((s, i) => ({ id: i + 1, text: s[0], answer: s[1], why: s[2] }));

  function page() {
    const body = `<style>.t td,.t th{padding:5px 8px;border-bottom:1px solid var(--line,#e3e7ef);text-align:left;vertical-align:top}.bad{color:#b3261e}.good{color:#1b7a3d}.warn{color:#9a6700}.fl2 label{display:inline-block;margin:4px 10px 4px 0}.fl2 input,.fl2 select{max-width:calc(100vw - 80px)}#r1,#r2,#r3{overflow-x:auto}#r1 .t,#r2 .t,#r3 .t{display:table;width:100%}.sc{padding:8px 0;border-bottom:1px solid var(--line,#e3e7ef)}.sc select{max-width:calc(100vw - 80px)}</style><div class="wrap"><h1>Buy now, pay later</h1>
<p class="lede">Buy-now-pay-later splits a purchase into instalments. The buyer gets the goods today, the merchant is paid up front (less a fee), and the provider carries the risk until the last instalment. Build a plan, miss a payment, return goods, and test an affordability decision. A teaching model with invented rates, and you use test data only.</p>
<p class="hint" id="top"></p>
<div class="panel"><strong>1. Plan builder</strong><p class="hint">Choose a plan and see the schedule, the cost of credit and who earns what.</p>
<div class="fl2"><label>Order amount <input type="number" id="am" value="240" min="20" max="10000"></label><label>Plan <select id="pl"><option value="pay4">Pay in 4 (no interest)</option><option value="m3">3 monthly</option><option value="m6">6 monthly</option><option value="m12">12 monthly</option></select></label><label>Rate % (monthly plans) <input type="number" id="ap" value="19.9" min="0" max="60" step="0.1"></label></div>
<p>Missed instalments (numbers, comma separated): <input id="ms" placeholder="e.g. 2" style="width:110px"> &nbsp; Return <input type="number" id="ra" placeholder="amount" style="width:90px"> on day <input type="number" id="rd" placeholder="day" style="width:70px"></p>
<p><button type="button" id="go">Build the plan</button> <span class="hint" id="m1"></span></p><div id="r1"></div></div>
<div class="panel"><strong>2. Affordability and stacking</strong><p class="hint">Would a provider approve this customer? Try raising the commitments, or the number of open plans.</p>
<div class="fl2"><label>Monthly income <input type="number" id="in" value="2500" min="1"></label><label>Existing monthly commitments <input type="number" id="cm" value="900" min="0"></label><label>Open BNPL plans <input type="number" id="ac" value="1" min="0" max="20"></label><label>Order <input type="number" id="ao" value="600" min="20" max="10000"></label><label>Plan <select id="ap2"><option value="pay4">Pay in 4</option><option value="m3">3 monthly</option><option value="m6" selected>6 monthly</option><option value="m12">12 monthly</option></select></label></div>
<p><button type="button" id="ago">Decide</button> <span class="hint" id="m2"></span></p><div id="r2"></div></div>
<div class="panel"><strong>3. What happens next?</strong><p class="hint">Ten situations. Choose the right outcome for each, then score.</p><div id="sq"></div><p><button type="button" id="qgo">Score</button> <span class="hint" id="m3"></span></p><div id="r3"></div></div>
<p class="hint">Related: <a href="/knowledge/how-buy-now-pay-later-works">How buy now, pay later works</a>, <a href="/knowledge/bnpl-risk-returns-and-stacking">BNPL risk, returns and stacking</a>, <a href="/academy/buy-now-pay-later">BNPL course</a>, <a href="/labs/account">Card account lifecycle</a>.</p></div>`;
    const script = `function $(i){return document.getElementById(i);}async function api(a,b,c){if(!(await Z.ensureKey()))return {status:0,body:{}};return Z.api(a,b,c);}
var OPT=${JSON.stringify(OPT)};
$("pl").onchange=function(){$("ap").disabled=$("pl").value==="pay4";};
$("go").onclick=async function(){var b={amount:parseFloat($("am").value),plan:$("pl").value,apr_percent:parseFloat($("ap").value)};var ms=$("ms").value.split(",").map(function(x){return parseInt(x,10);}).filter(function(x){return x>0;});if(ms.length)b.missed=ms;if(parseFloat($("ra").value)>0)b.return={amount:parseFloat($("ra").value),day:parseInt($("rd").value,10)||0};
var r=await api("POST","/v1/bnpl/plan",b);if(r.status!==200){$("m1").textContent=Z.msg(r);return;}$("m1").textContent="";var j=r.body;
$("r1").innerHTML='<table class="t"><tr><th>#</th><th>Due (day)</th><th>Principal</th><th>Interest</th><th>Late fee</th><th>Instalment</th><th>Status</th></tr>'+j.schedule.map(function(x){return "<tr><td>"+x.n+"</td><td>"+x.day+"</td><td>"+x.principal.toFixed(2)+"</td><td>"+x.interest.toFixed(2)+"</td><td>"+x.late_fee.toFixed(2)+"</td><td>"+x.amount.toFixed(2)+'</td><td class="'+(x.status==="paid on time"?"good":"warn")+'">'+x.status+"</td></tr>";}).join("")+"</table>"+
"<p>The customer pays <b>"+j.customer_total_cost.toFixed(2)+"</b> for a "+j.amount.toFixed(2)+" order. Cost of credit <b>"+j.cost_of_credit.toFixed(2)+"</b> (interest "+j.interest_total.toFixed(2)+", late fees "+j.late_fees_total.toFixed(2)+").</p><p>The merchant pays a "+j.merchant.discount_rate_percent+"% fee ("+j.merchant.fee.toFixed(2)+") and receives <b>"+j.merchant.receives_up_front.toFixed(2)+"</b> up front. The provider earns "+j.provider.revenue.toFixed(2)+" and carries "+j.provider.exposure_at_checkout.toFixed(2)+" of risk at checkout.</p>"+(j.note?"<p class=hint>"+Z.esc(j.note)+"</p>":"")+
(j.return?'<h3>Return</h3><p>Returning '+j.return.amount.toFixed(2)+" ("+j.return.share_percent+"% of the order) on day "+j.return.day+". Paid before the return: "+j.return.paid_before_return.toFixed(2)+". New total owed: "+j.return.new_total_owed.toFixed(2)+". <b>Refunded to the card: "+j.return.refunded_to_card.toFixed(2)+"</b>. Still to pay: <b>"+j.return.still_to_pay.toFixed(2)+"</b>.</p><p class=hint>"+Z.esc(j.return.note)+"</p>":"");};
$("ago").onclick=async function(){var r=await api("POST","/v1/bnpl/affordability",{monthly_income:parseFloat($("in").value),existing_monthly_commitments:parseFloat($("cm").value),active_plans:parseInt($("ac").value,10),amount:parseFloat($("ao").value),plan:$("ap2").value});if(r.status!==200){$("m2").textContent=Z.msg(r);return;}$("m2").textContent="";var j=r.body;
$("r2").innerHTML='<h3 class="'+(j.decision==="approve"?"good":j.decision==="decline"?"bad":"warn")+'">'+Z.esc(OPT[j.decision])+"</h3><p>The plan adds about "+j.monthly_payment_added.toFixed(2)+" a month. Payments would be "+j.payments_to_income_percent+"% of income."+(j.suggested_max_order!==null?" A plan up to about "+j.suggested_max_order.toFixed(2)+" would fit.":"")+"</p><ul>"+j.reasons.map(function(x){return "<li>"+Z.esc(x)+"</li>";}).join("")+"</ul><p class=hint>"+Z.esc(j.note)+"</p>";};
function opts(){return Object.keys(OPT).map(function(k){return '<option value="'+k+'">'+Z.esc(OPT[k])+"</option>";}).join("");}
async function loadSc(){var r=await api("GET","/v1/bnpl/scenarios");if(r.status!==200)return;$("sq").innerHTML=r.body.scenarios.map(function(s){return '<div class="sc"><b>'+s.id+".</b> "+Z.esc(s.text)+'<br><select data-s="'+s.id+'"><option value="">Choose...</option>'+opts()+"</select></div>";}).join("");}
$("qgo").onclick=async function(){var a={};[].slice.call(document.querySelectorAll("#sq select")).forEach(function(s){a[s.getAttribute("data-s")]=s.value;});var r=await api("POST","/v1/bnpl/scenarios/score",{answers:a});if(r.status!==200){$("m3").textContent=Z.msg(r);return;}$("m3").textContent="";var j=r.body;
$("r3").innerHTML='<h3 class="'+(j.passed?"good":"bad")+'">'+j.correct+" of "+j.total+(j.passed?": passed":": try again (8 to pass)")+'</h3><table class="t"><tr><th>#</th><th>Right?</th><th>Why</th></tr>'+j.rows.map(function(x){return "<tr><td>"+x.id+'</td><td class="'+(x.correct?"good":"bad")+'">'+(x.correct?"Yes":"No: "+Z.esc(x.answer_name))+"</td><td>"+Z.esc(x.why)+"</td></tr>";}).join("")+"</table>";};
if(Z.hasKey()){$("ap").disabled=true;loadSc();}else $("top").textContent="Create a test key to start.";`;
    return UI.shell({ title: "Buy now, pay later lab – Zanboxx", description: "Build a pay-in-4 or monthly instalment plan, miss a payment, return goods and test affordability and stacking. Test data only.", active: "labs", body, script });
  }

  return {
    async handle(req, res, path, m) {
      if (m === "GET" && path === "/labs/bnpl") { html(res, 200, page()); return true; }
      if (!path.startsWith("/v1/bnpl")) return false;
      const acc = ctx.authed(req), t = st(acc);
      if (m === "POST" && path === "/v1/bnpl/plan") {
        const b = await readBody(req), r = plan(b); t.did.plan_run = true; if (r.plan === "pay4") t.did.plan_pay4 = true; else t.did.plan_monthly = true; if (r.late_fees_total > 0) t.did.plan_missed = true; if (r.return) t.did.plan_return = true; save(acc); send(res, 200, r); return true;
      }
      if (m === "POST" && path === "/v1/bnpl/affordability") { const r = afford(await readBody(req)); t.did.afford_run = true; if (r.decision === "decline") t.did.afford_decline = true; if (r.decision === "approve_lower") t.did.afford_lower = true; save(acc); send(res, 200, r); return true; }
      if (m === "GET" && path === "/v1/bnpl/scenarios") { send(res, 200, { scenarios: SCEN.map((s) => ({ id: s.id, text: s.text })), options: OPT }); return true; }
      if (m === "POST" && path === "/v1/bnpl/scenarios/score") {
        const a = (await readBody(req)).answers; if (!a || typeof a !== "object") throw bad(400, "invalid_request", "answers must be an object of scenario id to outcome");
        let ok = 0; const rows = [];
        for (const s of SCEN) { const v = a[s.id] || a[String(s.id)]; if (v !== undefined && v !== "" && !OPT[v]) throw bad(400, "invalid_request", `Scenario ${s.id}: unknown outcome '${v}'`); const c = v === s.answer; if (c) ok++; rows.push({ id: s.id, correct: c, answer: s.answer, answer_name: OPT[s.answer], why: s.why }); }
        const passed = ok >= 8; t.did.scen_done = true; if (passed) t.did.scen_pass = true; save(acc); send(res, 200, { correct: ok, total: SCEN.length, passed, rows }); return true;
      }
      return false;
    },
  };
};
