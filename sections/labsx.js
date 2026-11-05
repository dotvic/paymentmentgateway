"use strict";
// Extra Payment Labs: the risk engine lab and the KPI panel.
module.exports = function ({ html, ctx, UI, esc }) {
  const R = require("../risk");
  const { send, bad, readBody, save } = ctx;

  function kpis(acc) {
    const pays = acc.payments || [], first = pays.filter((p) => ["purchase", "authorization", "debit"].includes(p.transaction_type) && p.transaction_state !== "pending");
    const ok = first.filter((p) => p.transaction_state === "success"), failed = first.filter((p) => p.transaction_state === "failed");
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
    const bucket = (key) => { const m = {}; for (const p of first) { const k = key(p) || "unknown"; (m[k] = m[k] || { attempts: 0, approved: 0 }).attempts++; if (p.transaction_state === "success") m[k].approved++; } return Object.entries(m).map(([k, v]) => ({ key: k, attempts: v.attempts, approved: v.approved, approval_rate_percent: pct(v.approved, v.attempts) })).sort((a, b) => b.attempts - a.attempts); };
    const codes = {}; for (const p of failed) { const c = (p.status && p.status.code) || "unknown"; codes[c] = (codes[c] || 0) + 1; }
    const refunds = pays.filter((p) => p.transaction_type === "refund" && p.transaction_state === "success").length, auth3 = first.filter((p) => p.authentication);
    return {
      attempts: first.length, approved: ok.length, declined: failed.length,
      approval_rate_percent: pct(ok.length, first.length), decline_rate_percent: pct(failed.length, first.length),
      refund_rate_percent: pct(refunds, ok.length), dispute_ratio_percent: pct((acc.disputes || []).length, ok.length),
      strong_auth: { payments: auth3.length, share_percent: pct(auth3.length, first.length), authenticated: auth3.filter((p) => p.authentication.trans_status === "Y").length },
      by_scheme: bucket((p) => p.scheme), by_method: bucket((p) => p.method),
      top_decline_codes: Object.entries(codes).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([code, count]) => ({ code, count })),
      note: "Computed from the payments currently in your sandbox account.",
    };
  }

  function riskPage() {
    const body = `<style>.rule select,.rule input{width:auto;display:inline-block}</style><div class="crumbs"><a href="/labs">Payment Labs</a> / Risk engine</div><h1>Risk engine lab</h1>
<p class="lede">Every payment gets a risk score from 0 to 100. Where you draw the lines decides how much fraud you stop, how many good customers you annoy, and what it costs. Tune it on 58 practice payments, about one in four of them fraud.</p>
<div class="panel"><strong>1. Thresholds</strong><p class="hint">Scores up to the first number are approved, scores from the second number are declined, in between goes to manual review.</p>
<label class="l" for="a" style="margin-top:0">Approve up to: <span id="av">30</span></label><input id="a" type="range" min="0" max="98" value="30" style="width:100%">
<label class="l" for="d">Decline from: <span id="dv">71</span></label><input id="d" type="range" min="2" max="100" value="71" style="width:100%"></div>
<div class="panel"><strong>2. Rules (optional)</strong><p class="hint">Rules run before the score and win over it. Up to 8. Example: if minutes_since_last &lt;= 90 then review.</p><div id="rules"></div><button type="button" class="small" id="addr">Add a rule</button></div>
<p><button class="primary" id="run" type="button">Run on the practice set</button> <span id="msg" class="hint"></span></p>
<div id="out"></div>
<h2>How the score is built</h2><p>Each signal adds or removes points: an amount far above the customer's usual, a new device, a foreign country, travel that cannot be real, many payments in an hour, a very new account, a first visit to the merchant, and late-night hours. Passing strong authentication takes points off. The weights are made up for teaching. Real models learn them from data.</p>
<h2>Things to try</h2><ul><li>Lower the decline line until fraud drops. What happens to good customers?</li><li>Find the cheapest setting. The table shows the total cost.</li><li>Add a rule for impossible travel. Does it help or only move cases around?</li><li>Look at the fraud the score cannot see: payments from a known device, at a known merchant, for a normal amount.</li></ul>
<p class="hint">A model that is right today drifts as customers and fraudsters change, so thresholds need recalibrating and monitoring. Related: <a href="/academy/fraud-and-risk">the Academy fraud and risk course</a>, <a href="/labs/kpis">payment KPIs</a>.</p>`;
    const script = `var FIELDS=${JSON.stringify(Object.keys(R.FIELDS))},BOOL=${JSON.stringify(Object.keys(R.FIELDS).filter((k) => R.FIELDS[k] === "b"))};
function $(i){return document.getElementById(i);}
$("a").oninput=function(){$("av").textContent=this.value;};$("d").oninput=function(){$("dv").textContent=this.value;};
function addRule(){var n=document.querySelectorAll(".rule").length;if(n>=8)return;var d=document.createElement("div");d.className="rule row";d.style.margin="6px 0";
d.innerHTML='<select class="rf">'+FIELDS.map(function(f){return "<option>"+f+"</option>";}).join("")+'</select> <select class="ro"><option>&gt;</option><option>&gt;=</option><option>&lt;</option><option>&lt;=</option><option>==</option></select> <input class="rv" size="6" value="0" aria-label="value"> then <select class="rt"><option>review</option><option>decline</option><option>approve</option></select> <button type="button" class="small rx">Remove</button>';
d.querySelector(".rx").onclick=function(){d.remove();};$("rules").appendChild(d);}
$("addr").onclick=addRule;
function rules(){return Array.prototype.map.call(document.querySelectorAll(".rule"),function(r){var f=r.querySelector(".rf").value;return{field:f,op:r.querySelector(".ro").value,value:BOOL.indexOf(f)>=0?(r.querySelector(".rv").value.trim()==="true"):r.querySelector(".rv").value,then:r.querySelector(".rt").value};});}
$("run").onclick=async function(){$("msg").textContent="Running…";if(!(await Z.ensureKey())){$("msg").textContent="Could not create your account.";return;}
var r=await Z.api("POST","/v1/risk/evaluate",{thresholds:{approve_max:+$("a").value,decline_min:+$("d").value},rules:rules()});if(r.status!==200){$("msg").textContent=Z.msg(r);return;}$("msg").textContent="";var e=r.body,m=e.metrics;
function pc(x){return Math.round(x*100)+"%";}
var h='<div class="grid"><div class="panel"><strong>Fraud stopped</strong><h2 style="margin:4px 0">'+pc(m.fraud_catch_rate)+'</h2></div><div class="panel"><strong>Good customers declined</strong><h2 style="margin:4px 0">'+pc(m.false_positive_rate)+'</h2></div><div class="panel"><strong>Sent to review</strong><h2 style="margin:4px 0">'+pc(m.review_rate)+'</h2></div><div class="panel"><strong>Total cost</strong><h2 style="margin:4px 0">'+m.total_cost+'</h2><span class="hint">fraud '+m.fraud_loss+' + lost sales '+m.lost_sales+' + review '+m.review_cost+'</span></div></div><p class="hint">'+Z.esc(e.assumptions)+'</p>';
h+='<div style="overflow-x:auto"><table><thead><tr><th>Payment</th><th>Amount</th><th>Score</th><th>Decision</th><th>Truth</th><th>Result</th></tr></thead><tbody>'+e.rows.map(function(x){var good=(x.fraud&&x.decision==="decline")||(!x.fraud&&x.decision==="approve");var res=x.fraud?(x.decision==="approve"?"fraud got through":x.decision==="review"?"caught by review":"stopped"):(x.decision==="decline"?"good customer lost":x.decision==="review"?"delayed":"fine");return "<tr><td>"+x.id+"</td><td>"+x.amount+"</td><td>"+x.score+"</td><td>"+x.decision+"</td><td>"+(x.fraud?"fraud ("+Z.esc(x.kind)+")":"legitimate ("+Z.esc(x.kind)+")")+"</td><td>"+(good?"":"<strong>")+res+(good?"":"</strong>")+"</td></tr>";}).join("")+'</tbody></table></div>';
$("out").innerHTML=h;};`;
    return UI.shell({ title: "Risk engine lab – Zanboxx", description: "Tune a fraud score and thresholds and see the cost of every choice.", active: "labs", body, script });
  }
  function kpiPage() {
    const body = `<div class="crumbs"><a href="/labs">Payment Labs</a> / Payment KPIs</div><h1>Payment KPIs</h1><p class="lede">The numbers a payments team watches, computed from the payments in your sandbox account. Make some payments in the <a href="/labs">Payment Labs</a>, then come back.</p><div id="out" class="hint">Loading…</div>
<h2>What they mean</h2><ul><li><strong>Approval rate</strong>: approved first attempts divided by all first attempts. Every point lost is revenue lost.</li><li><strong>Decline rate</strong>: the rest. Read it together with the top decline codes: some are fixable, some are not.</li><li><strong>Refund rate</strong> and <strong>dispute ratio</strong>: signals of product or fraud problems. Disputes above about 1% put a merchant under scheme monitoring.</li><li><strong>Strong authentication share</strong>: how much traffic is challenged. More challenges mean less fraud liability but more drop-off.</li></ul>`;
    const script = `(async function(){var o=document.getElementById("out");if(!Z.hasKey()){o.textContent="No payments yet. Make some in the Payment Labs first.";return;}var r=await Z.api("GET","/v1/kpis");if(r.status!==200){o.textContent=Z.msg(r);return;}var k=r.body;
function v(x){return x==null?"–":x+"%";}
function tbl(rows,cols){return rows.length?'<div style="overflow-x:auto"><table><thead><tr>'+cols.map(function(c){return "<th>"+c[0]+"</th>";}).join("")+"</tr></thead><tbody>"+rows.map(function(x){return "<tr>"+cols.map(function(c){return "<td>"+Z.esc(x[c[1]])+"</td>";}).join("")+"</tr>";}).join("")+"</tbody></table></div>":'<p class="hint">Nothing yet.</p>';}
o.innerHTML='<div class="grid"><div class="panel"><strong>Approval rate</strong><h2 style="margin:4px 0">'+v(k.approval_rate_percent)+'</h2><span class="hint">'+k.approved+' of '+k.attempts+' attempts</span></div><div class="panel"><strong>Decline rate</strong><h2 style="margin:4px 0">'+v(k.decline_rate_percent)+'</h2></div><div class="panel"><strong>Refund rate</strong><h2 style="margin:4px 0">'+v(k.refund_rate_percent)+'</h2></div><div class="panel"><strong>Dispute ratio</strong><h2 style="margin:4px 0">'+v(k.dispute_ratio_percent)+'</h2></div><div class="panel"><strong>Strong authentication share</strong><h2 style="margin:4px 0">'+v(k.strong_auth.share_percent)+'</h2></div></div><h3>By scheme</h3>'+tbl(k.by_scheme,[["Scheme","key"],["Attempts","attempts"],["Approved","approved"],["Approval %","approval_rate_percent"]])+'<h3>By method</h3>'+tbl(k.by_method,[["Method","key"],["Attempts","attempts"],["Approved","approved"],["Approval %","approval_rate_percent"]])+'<h3>Top decline codes</h3>'+tbl(k.top_decline_codes,[["Code","code"],["Count","count"]]);})();`;
    return UI.shell({ title: "Payment KPIs – Zanboxx", description: "Approval rate, decline rate, refunds and disputes for your sandbox payments.", active: "labs", body, script, noindex: true });
  }

  return {
    async handle(req, res, path, m) {
      if (m === "GET" && path === "/labs/risk") { html(res, 200, riskPage()); return true; }
      if (m === "GET" && path === "/labs/kpis") { html(res, 200, kpiPage()); return true; }
      if (m === "GET" && path === "/v1/risk/dataset") { send(res, 200, { transactions: R.DATASET.map(R.publicTx), fields: Object.keys(R.FIELDS), note: "Practice payments. Labels are revealed only in evaluation results." }); return true; }
      if (!path.startsWith("/v1/risk/") && path !== "/v1/kpis") return false;
      const acc = ctx.authed(req);
      if (m === "GET" && path === "/v1/kpis") { send(res, 200, kpis(acc)); return true; }
      if (m === "POST" && path === "/v1/risk/score") {
        const b = await readBody(req); if (!b || typeof b.signals !== "object" || !b.signals) throw bad(400, "invalid_request", "Send signals: { amount, typical_amount, device_known, country_matches_home, ... }");
        const s = b.signals, num = (k, d) => (Number.isFinite(+s[k]) ? +s[k] : d);
        const sig = { amount: num("amount", 0), typical_amount: num("typical_amount", 0), velocity_1h: num("velocity_1h", 0), account_age_days: num("account_age_days", 365), hour: num("hour", 12), minutes_since_last: s.minutes_since_last == null ? null : num("minutes_since_last", null), device_known: s.device_known !== false, country_matches_home: s.country_matches_home !== false, merchant_known: s.merchant_known !== false, authenticated: s.authenticated === true, last_country_matches_home: s.last_country_matches_home !== false };
        let th, rl; try { th = R.cleanThresholds(b.thresholds); rl = R.cleanRules(b.rules); } catch (e) { throw bad(400, "invalid_request", e.message); }
        send(res, 200, R.decide(sig, th, rl)); return true;
      }
      if (m === "POST" && path === "/v1/risk/evaluate") {
        const b = (await readBody(req)) || {}; let out; try { out = R.evaluate(b.thresholds, b.rules); } catch (e) { throw bad(400, "invalid_request", e.message); }
        const r = acc.risk = acc.risk || { runs: 0, rule_used: false, best_cost: null, goal: false };
        r.runs++; if (out.rules.length) r.rule_used = true; r.best_cost = r.best_cost == null ? out.metrics.total_cost : Math.min(r.best_cost, out.metrics.total_cost);
        if (out.metrics.total_cost <= 250 && out.metrics.false_positive_rate <= 0.05) r.goal = true;
        save(acc); send(res, 200, out); return true;
      }
      return false;
    },
  };
};
