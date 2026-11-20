"use strict";
// Merchant risk lab: score a merchant at onboarding, apply a client-defined policy, watch a merchant day by day, tune thresholds on an
// invented portfolio, and check for model drift. A teaching model: invented weights, invented merchants, simplified rules. Not a
// production risk model and not tied to any scheme's monitoring programme.

module.exports = function ({ html, ctx, UI, esc }) {
  const { send, bad, readBody, save } = ctx;
  const st = (acc) => (acc.mrisk = acc.mrisk || { did: {} });
  const MODEL = "teach-1.0";
  const isNum = (v) => typeof v === "number" && isFinite(v);
  const num = (v, name, lo, hi, def) => { if (v === undefined || v === null || v === "") { if (def !== undefined) return def; throw bad(400, "invalid_request", `${name} is required`); } const n = Number(v); if (!isFinite(n) || n < lo || n > hi) throw bad(400, "invalid_request", `${name} must be between ${lo} and ${hi}`); return n; };
  const r2 = (n) => Math.round(n * 100) / 100;
  function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // ---------- onboarding score ----------
  const COUNTRY = { low: 0, medium: 8, high: 18 };
  const MCC = { retail: 0, subscriptions: 8, digital_goods: 10, travel: 12, money_services: 16, gaming: 20 };
  const MCC_LABEL = { retail: "Retail and groceries", subscriptions: "Subscriptions", digital_goods: "Digital goods", travel: "Travel and tickets", money_services: "Money services", gaming: "Online gaming" };
  const BANDS = [["low", 0], ["medium", 30], ["high", 60], ["severe", 80]];
  const bandOf = (s) => BANDS.reduce((b, x) => (s >= x[1] ? x[0] : b), "low");
  const POLICY = {
    conservative: { low: ["approve"], medium: ["approve", "reserve:10:14"], high: ["manual_review", "reserve:15:30"], severe: ["reject"] },
    balanced: { low: ["approve"], medium: ["approve", "enhanced_kyc"], high: ["manual_review", "reserve:10:21"], severe: ["reject"] },
    aggressive: { low: ["approve"], medium: ["approve"], high: ["approve", "enhanced_kyc", "reserve:5:7"], severe: ["manual_review"] },
  };
  const PRIORITY = ["reject", "freeze", "manual_review", "enhanced_kyc", "delay_settlement", "reserve", "approve"];
  const ACTION_LABEL = { approve: "Approve", enhanced_kyc: "Ask for enhanced checks", manual_review: "Send to an analyst", reject: "Reject", reserve: "Hold a reserve", delay_settlement: "Delay settlement", freeze: "Freeze payouts" };
  const actName = (a) => a.split(":")[0];
  const primary = (acts) => PRIORITY.find((p) => acts.some((a) => actName(a) === p)) || "approve";

  function scoreMerchant(m) {
    const c = [];
    const add = (code, label, pts) => c.push({ code, label, points: pts });
    add("R-COUNTRY", "Country risk (" + m.country_band + ")", COUNTRY[m.country_band]);
    add("R-MCC", "Business type (" + MCC_LABEL[m.mcc_group] + ")", MCC[m.mcc_group]);
    add("R-AGE", "Company age (" + m.company_age_months + " months)", m.company_age_months < 6 ? 14 : m.company_age_months < 12 ? 9 : m.company_age_months < 36 ? 4 : 0);
    add("R-KYB", "Business checks score (" + m.kyb_score + ")", r2(m.kyb_score * 0.2));
    add("R-VOLUME", "Projected volume (" + m.monthly_volume + ")", m.monthly_volume >= 150000 ? 8 : m.monthly_volume >= 50000 ? 4 : 0);
    add("R-TICKET", "Average ticket (" + m.avg_ticket + ")", m.avg_ticket >= 400 ? 6 : m.avg_ticket >= 250 ? 3 : 0);
    add("R-SITE", "Website matches the declared business", m.website_matches ? 0 : 10);
    add("R-DIRECTOR", "Director or owner flagged in screening", m.director_flag ? 20 : 0);
    add("R-CROSS", "Cross-border share (" + m.cross_border_pct + "%)", m.cross_border_pct >= 60 ? 8 : m.cross_border_pct >= 30 ? 4 : 0);
    const raw = c.reduce((s, x) => s + x.points, 0), score = Math.min(100, Math.round(raw));
    return { score, band: bandOf(score), contributions: c.filter((x) => x.points > 0).sort((a, b) => b.points - a.points) };
  }
  function parseMerchant(b) {
    if (!b || typeof b !== "object") throw bad(400, "invalid_request", "Send a JSON body");
    const country_band = String(b.country_band || "low"); if (!(country_band in COUNTRY)) throw bad(400, "invalid_request", "country_band must be low, medium or high");
    const mcc_group = String(b.mcc_group || "retail"); if (!(mcc_group in MCC)) throw bad(400, "invalid_request", "mcc_group must be one of " + Object.keys(MCC).join(", "));
    return { country_band, mcc_group, company_age_months: num(b.company_age_months, "company_age_months", 0, 600, 24), kyb_score: num(b.kyb_score, "kyb_score", 0, 100, 30), monthly_volume: num(b.monthly_volume, "monthly_volume", 0, 10000000, 40000), avg_ticket: num(b.avg_ticket, "avg_ticket", 1, 100000, 80), website_matches: b.website_matches !== false && b.website_matches !== "false", director_flag: b.director_flag === true || b.director_flag === "true", cross_border_pct: num(b.cross_border_pct, "cross_border_pct", 0, 100, 10) };
  }
  function overridesOf(o) {
    if (o === undefined || o === null) return [];
    if (!Array.isArray(o) || o.length > 5) throw bad(400, "invalid_request", "overrides must be a list of at most 5 rules");
    return o.map((r) => { if (!r || !(r.mcc_group in MCC) || !["reject", "manual_review", "enhanced_kyc"].includes(r.action)) throw bad(400, "invalid_request", "Each override needs mcc_group and an action of reject, manual_review or enhanced_kyc"); return { mcc_group: r.mcc_group, above: num(r.above, "above", 0, 100, 60), action: r.action }; });
  }
  function decide(m, appetite, overrides) {
    const s = scoreMerchant(m); let acts = (POLICY[appetite] || POLICY.balanced)[s.band].slice(), hit = null;
    for (const o of overrides) if (o.mcc_group === m.mcc_group && s.score > o.above) { acts = [o.action]; hit = o; break; }
    return { ...s, actions: acts, decision: primary(acts), override: hit };
  }

  // ---------- monitoring simulation ----------
  const SCENARIOS = {
    steady: "A steady merchant: normal day-to-day noise",
    bust_out: "Bust-out: volume balloons, payout account changes, then the merchant vanishes",
    ticket_creep: "Ticket creep: basket size and declines drift upward",
    chargeback_spike: "Chargeback spike: refunds disputes rise sharply after day 12",
    new_market: "New market: volume doubles and new countries appear",
  };
  SCENARIOS.chargeback_spike = "Chargeback spike: disputes rise sharply for sales made after day 12";
  const H = 45;
  function series(scn, lag) {
    const R = rng(scn.split("").reduce((a, c) => a * 31 + c.charCodeAt(0), 7)), base = { vol: 5000, ticket: 50, decline: 8, cb: 0.2, countries: 1 }, days = [];
    for (let d = 1; d <= H; d++) {
      const n = () => 1 + (R() - 0.5) * 0.1; let vol = base.vol * n(), ticket = base.ticket * n(), decline = base.decline * n(), cb = base.cb, countries = base.countries, payout = false;
      if (scn === "bust_out") { if (d >= 3) vol *= 1 + Math.min(4, (d - 2) * 0.33); if (d >= 14) ticket *= 1.6; if (d >= 11) countries = 3; if (d === 16) payout = true; if (d >= 12) cb = 6; if (d >= 22) vol = 0; }
      if (scn === "ticket_creep") { ticket *= Math.pow(1.03, d); decline = Math.min(25, base.decline + d * 0.5) * n(); }
      if (scn === "chargeback_spike") { if (d >= 12) cb = 1.8; }
      if (scn === "new_market") { if (d >= 10) { vol *= 2; countries = 3; } }
      days.push({ day: d, volume: Math.round(vol), ticket: r2(ticket), decline: r2(decline), cb_rate: cb, countries, payout_change: payout });
    }
    return { days, base };
  }
  function monitor(b, appetite, onboardScore, settleDelay, lag) {
    const { days, base } = series(b.scenario, lag), rows = [];
    const cbArrivals = days.map(() => 0);
    days.forEach((x) => { const arr = x.day + lag; if (arr <= H) cbArrivals[arr - 1] += Math.round(x.volume * x.cb_rate / 100); });
    const policyOf = (score) => (POLICY[appetite])[bandOf(score)];
    const run = (continuous) => {
      let held = [], paid = 0, shortfall = 0, cbTotal = 0, first = null, actionsPrev = ["approve"];
      const hist = [];
      for (let i = 0; i < H; i++) {
        const x = days[i], d = x.day;
        const win = days.slice(Math.max(0, i - 6), i + 1), vol7 = win.reduce((s, y) => s + y.volume, 0) / win.length;
        const tWin = days.slice(Math.max(0, i - lag - 6), Math.max(1, i - lag + 1)), cbRatio = i - lag < 0 ? base.cb : tWin.reduce((s, y) => s + y.cb_rate, 0) / tWin.length;
        const trig = [];
        if (vol7 > 3 * base.vol) trig.push(["volume_spike", 25]); if (x.ticket > 1.5 * base.ticket) trig.push(["ticket_shift", 15]); if (x.decline > base.decline + 10) trig.push(["decline_surge", 10]);
        if (cbRatio >= 1.0) trig.push(["chargebacks_excessive", 30]); else if (cbRatio >= 0.5) trig.push(["chargebacks_warning", 15]);
        if (x.countries >= base.countries + 2) trig.push(["new_countries", 10]); if (days.slice(Math.max(0, i - 6), i + 1).some((y) => y.payout_change)) trig.push(["payout_account_changed", 20]);
        const score = Math.min(100, onboardScore + trig.reduce((s, t) => s + t[1], 0)), band = bandOf(score);
        let acts = continuous ? policyOf(score).slice() : ["approve"];
        if (continuous && band === "severe" && !acts.includes("reject")) acts.push("freeze"); if (continuous && (band === "high" || band === "severe")) acts.push("delay_settlement");
        const use = actionsPrev; // actions decided yesterday apply to today's sales
        let reserve = 0, rdays = 0, delay = settleDelay, frozen = false;
        use.forEach((a) => { const [n, p, dd] = a.split(":"); if (n === "reserve") { reserve = +p / 100; rdays = +dd; } if (n === "delay_settlement") delay = Math.max(delay, 7); if (n === "freeze" || n === "reject") frozen = true; });
        const v = x.volume; if (v > 0) { const res = v * reserve, rest = v - res; if (res > 0) held.push({ rel: d + rdays, amt: res }); held.push({ rel: frozen ? 99999 : d + delay, amt: rest }); }
        const cb = cbArrivals[i]; cbTotal += cb; let need = cb; for (const h of held) { if (need <= 0) break; if (h.rel > d) { const t = Math.min(h.amt, need); h.amt -= t; need -= t; } }
        // float released on or before today is paid out (after chargebacks are netted against what is still held)
        held = held.filter((h) => { if (h.rel <= d && h.amt > 0) { paid += h.amt; return false; } return h.amt > 0; }); shortfall += need;
        if (first === null && (band === "high" || band === "severe")) first = d;
        hist.push({ day: d, volume: x.volume, ticket: x.ticket, decline_pct: x.decline, chargeback_ratio_pct: r2(cbRatio), triggers: trig.map((t) => t[0]), score, band, actions: acts.map(actName).filter((a) => a !== "approve").filter((a, k, arr) => arr.indexOf(a) === k), chargebacks_received: cb });
        actionsPrev = acts;
      }
      return { first_alert_day: first, paid_out: Math.round(paid), still_held: Math.round(held.reduce((s, h) => s + h.amt, 0)), chargebacks_total: cbTotal, loss: Math.round(shortfall), timeline: hist };
    };
    const staticRun = run(false), cont = run(true);
    return { scenario: b.scenario, appetite, onboarding_score: onboardScore, settlement_delay_days: settleDelay, chargeback_lag_days: lag, static_policy: { ...staticRun, timeline: undefined }, continuous_policy: cont, loss_avoided: Math.max(0, staticRun.loss - cont.loss), baseline: base };
  }

  // ---------- invented portfolio and thresholds ----------
  const portfolio = (() => {
    const R = rng(20260301), ms = [], pick = (a) => a[Math.floor(R() * a.length)], mk = Object.keys(MCC), cb = Object.keys(COUNTRY);
    for (let i = 0; i < 60; i++) {
      const m = { id: "P" + String(i + 1).padStart(3, "0"), country_band: cb[Math.min(2, Math.floor(R() * R() * 3))], mcc_group: pick(mk), company_age_months: Math.floor(R() * R() * 120), kyb_score: Math.floor(R() * 100), monthly_volume: Math.round((5000 + R() * 195000) / 100) * 100, avg_ticket: Math.round(10 + R() * 480), website_matches: R() > 0.15, director_flag: R() < 0.07, cross_border_pct: Math.floor(R() * 90) };
      const s = scoreMerchant(m).score, p = 1 / (1 + Math.exp(-(s - 52) / 8)); m.bad = R() < p; m.score = s; ms.push(m);
    }
    return ms;
  })();
  function thresholds(reject_at, review_at) {
    let rej = 0, rev = 0, app = 0, badRej = 0, badRev = 0, badApp = 0, goodRej = 0, goodRev = 0; const rows = [];
    portfolio.forEach((m) => { const v = m.score >= reject_at ? "reject" : m.score >= review_at ? "review" : "approve"; if (v === "reject") { rej++; m.bad ? badRej++ : goodRej++; } else if (v === "review") { rev++; m.bad ? badRev++ : goodRev++; } else { app++; if (m.bad) badApp++; } rows.push({ id: m.id, mcc_group: m.mcc_group, score: m.score, verdict: v, truth: m.bad ? "later bad" : "later good" }); });
    const totalBad = portfolio.filter((m) => m.bad).length;
    return { merchants: portfolio.length, total_later_bad: totalBad, rejected: rej, reviewed: rev, approved: app, bad_rejected: badRej, bad_reviewed: badRev, bad_approved: badApp, good_rejected: goodRej, good_reviewed: goodRev, precision_reject: rej ? r2(badRej / rej) : null, recall_reject: totalBad ? r2(badRej / totalBad) : null, recall_reject_or_review: totalBad ? r2((badRej + badRev) / totalBad) : null, false_positive_rate_reject: r2(goodRej / (portfolio.length - totalBad)), rows };
  }

  // ---------- drift ----------
  const DRIFT = {
    ticket: { labels: ["under 50", "50 to 100", "100 to 200", "200 to 400", "400 and over"], base: [0.30, 0.30, 0.20, 0.15, 0.05], none: [0.29, 0.31, 0.20, 0.15, 0.05], mild: [0.22, 0.28, 0.22, 0.18, 0.10], strong: [0.10, 0.20, 0.25, 0.25, 0.20] },
    country: { labels: ["low risk", "medium risk", "high risk"], base: [0.70, 0.25, 0.05], none: [0.69, 0.26, 0.05], mild: [0.58, 0.31, 0.11], strong: [0.35, 0.35, 0.30] },
    mcc: { labels: ["retail", "subscriptions", "digital goods", "travel", "money services", "gaming"], base: [0.40, 0.20, 0.15, 0.12, 0.08, 0.05], none: [0.39, 0.20, 0.16, 0.12, 0.08, 0.05], mild: [0.34, 0.20, 0.17, 0.12, 0.10, 0.07], strong: [0.20, 0.15, 0.20, 0.10, 0.15, 0.20] },
  };
  function psi(feature, shift) {
    const f = DRIFT[feature]; if (!f) throw bad(400, "invalid_request", "feature must be ticket, country or mcc"); if (!f[shift] || shift === "base" || shift === "labels") throw bad(400, "invalid_request", "shift must be none, mild or strong");
    const rows = f.labels.map((l, i) => { const e = f.base[i], a = f[shift][i], p = (a - e) * Math.log(a / e); return { bucket: l, training: e, now: a, contribution: Math.round(p * 1000) / 1000 }; });
    const idx = Math.round(rows.reduce((s, r) => s + r.contribution, 0) * 1000) / 1000;
    return { feature, shift, index: idx, status: idx < 0.1 ? "stable" : idx < 0.25 ? "watch" : "retrain", rows };
  }

  // ---------- quiz ----------
  const OPT = { approve: "Approve as is", enhanced_kyc: "Ask for enhanced checks", manual_review: "Send to an analyst", reject: "Reject", reserve: "Hold a reserve", delay_settlement: "Delay settlement", freeze: "Freeze payouts and review", retrain: "Retrain and revalidate the model", no_action: "No action needed", audit_log: "Look up the audit record" };
  const SC = [
    ["An established grocery chain in a low-risk country, clean checks, score 12.", "approve", "A low score under any appetite means approval with normal settlement."],
    ["A three-month-old online gaming operator with a flagged director scores 88 under a conservative policy.", "reject", "Severe band: the policy rejects. Compounded signals can outweigh any one clean check."],
    ["Score 45 (medium band) under a balanced policy, with director address checks incomplete.", "enhanced_kyc", "Medium band under the balanced policy asks for more evidence rather than refusing."],
    ["A merchant's weekly volume has tripled with the same product and nothing else odd.", "manual_review", "A single large spike is a reason for an analyst to look, not yet for punishment."],
    ["Payout bank account changed, ticket size jumped and two new countries appeared in one week.", "delay_settlement", "Several signals together point to a bust-out: slow the money while someone checks."],
    ["Chargeback ratio crossed the warning level for the first time. Volume is steady.", "reserve", "A reserve covers the exposure that is about to arrive, without stopping the business."],
    ["Chargeback ratio has been far above the excessive level for three weeks.", "freeze", "Money still owed to buyers must not leave: hold payouts and review the merchant."],
    ["The average-ticket distribution has shifted a lot against the training data (index 0.4).", "retrain", "A large drift index means the model no longer sees the world it was trained on."],
    ["Drift index 0.04 on every feature.", "no_action", "Below 0.1 the distributions are stable."],
    ["A regulator asks why a merchant was held three months ago.", "audit_log", "Every decision must be traceable: inputs, score, decision, model version and time."],
  ];
  const SCEN = SC.map((s, i) => ({ id: i + 1, text: s[0], answer: s[1], why: s[2] }));

  function page() {
    const body = `<style>.t td,.t th{padding:5px 8px;border-bottom:1px solid var(--line,#e3e7ef);text-align:left;vertical-align:top}.good{color:#1b7a3d}.bad{color:#b3261e}.warn{color:#9a6700}.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}.fl2 label{display:inline-block;margin:6px 14px 6px 0;vertical-align:top}.fl2 input,.fl2 select{max-width:100%;width:190px}#r1,#r2,#r3,#r4,#qres,#r2w{overflow-x:auto}#r1 .t,#r2 .t,#r3 .t,#r4 .t,#qres .t{display:table;width:100%}#r1 .t td,#r2 .t td,#r3 .t td,#r4 .t td,#qres .t td{white-space:normal;overflow-wrap:anywhere}.sc{padding:8px 0;border-bottom:1px solid var(--line,#e3e7ef)}.sc select{max-width:calc(100vw - 80px)}.pill{display:inline-block;padding:1px 8px;border-radius:10px;background:#eef1f7;font-size:13px;margin:1px 2px}.bar{display:inline-block;height:10px;background:#6b46f0;border-radius:3px;vertical-align:middle}pre.audit{background:#10151c;color:#d7e0ea;border-radius:8px;padding:10px 12px;overflow-x:auto;font-size:13px}</style><div class="wrap"><h1>Merchant risk</h1>
<p class="lede">An acquirer or payment platform does not just approve a merchant once. It scores the merchant when it joins, applies its own rules, then keeps watching, because the losses (chargebacks) arrive weeks after the sales. This lab walks through that whole loop on invented merchants. The weights, thresholds and data are teaching values, not a real model.</p><p class="hint" id="top"></p>
<div class="panel"><strong>1. Score a new merchant and apply a policy</strong><div class="fl2" id="f1"></div><p><button type="button" id="go1">Score</button> <span class="hint" id="m1"></span></p><div id="r1"></div></div>
<div class="panel"><strong>2. Watch a merchant for 45 days</strong><p class="hint">Compare approving once and walking away with continuous monitoring. Chargebacks arrive only after a delay, which is the whole difficulty.</p><div class="fl2" id="f2"></div><p><button type="button" id="go2">Run the simulation</button> <span class="hint" id="m2"></span></p><div id="r2"></div></div>
<div class="panel"><strong>3. Tune the thresholds on a portfolio of 60 merchants</strong><p class="hint">Every merchant gets a score. Some later turned out bad. Choose where to reject and where to send to an analyst, then see what it cost.</p><div class="fl2" id="f3"></div><p><button type="button" id="go3">Apply thresholds</button> <span class="hint" id="m3"></span></p><div id="r3"></div></div>
<div class="panel"><strong>4. Has the world drifted?</strong><p class="hint">Compare the data a model was trained on with today's, using a population stability index: below 0.1 stable, 0.1 to 0.25 watch, above 0.25 retrain.</p><div class="fl2" id="f4"></div><p><button type="button" id="go4">Check drift</button> <span class="hint" id="m4"></span></p><div id="r4"></div></div>
<div class="panel"><strong>5. What should happen?</strong><p class="hint">Ten situations. Choose the action for each, then score. Eight right passes.</p><div id="sq"></div><p><button type="button" id="qgo">Score</button> <span class="hint" id="m5"></span></p><div id="qres"></div></div>
<p class="hint">Related: <a href="/labs/risk">Risk engine</a> (single payments), <a href="/labs/payouts">Payouts</a>, <a href="/labs/kpis">Payment KPIs</a>, <a href="/knowledge/merchant-risk-onboarding-and-monitoring">Merchant risk guide</a>, <a href="/academy/merchant-risk">Merchant risk course</a>, <a href="/labs">Payment Labs</a>.</p></div>`;
    const script = `function $(i){return document.getElementById(i);}async function api(a,b,c){if(!(await Z.ensureKey()))return {status:0,body:{}};return Z.api(a,b,c);}
var S=null;function sel(id,lab,opts,def){return '<label>'+lab+' <select id="'+id+'">'+opts.map(function(o){var v=o[0],t=o[1];return '<option value="'+v+'"'+(v===def?' selected':'')+'>'+Z.esc(t)+'</option>';}).join('')+'</select></label>';}
function inp(id,lab,v){return '<label>'+lab+' <input id="'+id+'" value="'+v+'"></label>';}
function pairs(o){return Object.keys(o).map(function(k){return [k,o[k]];});}
function pill(a){return '<span class="pill">'+Z.esc(S.action_labels[a]||a)+'</span>';}
async function init(){var r=await api('GET','/v1/merchant-risk/setup');if(r.status!==200){$('top').textContent=Z.msg(r)||'Create a test key to start.';return;}S=r.body;
$('f1').innerHTML=sel('cb','Country risk',[['low','Low'],['medium','Medium'],['high','High']],'low')+sel('mcc','Business type',pairs(S.mcc_labels),'retail')+inp('age','Company age (months)','24')+inp('kyb','Business checks score (0 safe, 100 risky)','30')+inp('vol','Projected monthly volume','40000')+inp('tk','Average ticket','80')+inp('xb','Cross-border share %','10')+sel('web','Website matches business',[['true','Yes'],['false','No']],'true')+sel('dir','Director flagged',[['false','No'],['true','Yes']],'false')+sel('app','Risk appetite',[['conservative','Conservative'],['balanced','Balanced'],['aggressive','Aggressive']],'balanced')+sel('ov','Extra rule',[['none','None'],['gaming','Reject online gaming above 60']],'none');
$('f2').innerHTML=sel('sc','Scenario',pairs(S.scenarios),'bust_out')+sel('app2','Risk appetite',[['conservative','Conservative'],['balanced','Balanced'],['aggressive','Aggressive']],'balanced')+inp('os','Onboarding score','35')+inp('sd','Normal settlement delay (days)','2')+inp('lag','Chargeback delay (days)','10');
$('f3').innerHTML=inp('rj','Reject at or above','75')+inp('rv','Send to an analyst at or above','50');
$('f4').innerHTML=sel('ft','Feature',[['ticket','Average ticket'],['country','Country risk mix'],['mcc','Business type mix']],'ticket')+sel('sh','Shift',[['none','None'],['mild','Mild'],['strong','Strong']],'mild');
$('sq').innerHTML=S.scenario_list.map(function(s){return '<div class="sc"><b>'+s.id+'.</b> '+Z.esc(s.text)+'<br><select data-s="'+s.id+'"><option value="">Choose...</option>'+pairs(S.options).map(function(o){return '<option value="'+o[0]+'">'+Z.esc(o[1])+'</option>';}).join('')+'</select></div>';}).join('');}
$('go1').onclick=async function(){var b={country_band:$('cb').value,mcc_group:$('mcc').value,company_age_months:$('age').value,kyb_score:$('kyb').value,monthly_volume:$('vol').value,avg_ticket:$('tk').value,cross_border_pct:$('xb').value,website_matches:$('web').value,director_flag:$('dir').value,appetite:$('app').value};if($('ov').value==='gaming')b.overrides=[{mcc_group:'gaming',above:60,action:'reject'}];var r=await api('POST','/v1/merchant-risk/onboard',b);if(r.status!==200){$('m1').textContent=Z.msg(r);return;}$('m1').textContent='';var j=r.body;
$('r1').innerHTML='<h3>Score '+j.score+' ('+Z.esc(j.band)+'): '+Z.esc(S.action_labels[j.decision])+'</h3><p>'+j.actions.map(function(a){var p=a.split(':');return pill(p[0])+(p[0]==='reserve'?' <span class="hint">'+p[1]+'% for '+p[2]+' days</span>':'');}).join(' ')+(j.override?' <span class="hint">An extra rule changed the outcome.</span>':'')+'</p><table class="t"><tr><th>What raised the score</th><th>Points</th><th>Reason code</th></tr>'+j.drivers.map(function(d){return '<tr><td>'+Z.esc(d.label)+'</td><td>'+d.points+'</td><td class="mono">'+d.code+'</td></tr>';}).join('')+'</table><p class="hint">The audit record a real system would keep:</p><pre class="audit">'+Z.esc(JSON.stringify(j.audit,null,2))+'</pre>';};
$('go2').onclick=async function(){var r=await api('POST','/v1/merchant-risk/monitor',{scenario:$('sc').value,appetite:$('app2').value,onboarding_score:$('os').value,settlement_delay_days:$('sd').value,chargeback_lag_days:$('lag').value});if(r.status!==200){$('m2').textContent=Z.msg(r);return;}$('m2').textContent='';var j=r.body,c=j.continuous_policy,s=j.static_policy;
var pk='',rows=c.timeline.filter(function(x){var k=x.score+'|'+x.actions.join()+'|'+x.triggers.join();var keep=k!==pk||x.day===45;pk=k;return keep;});
$('r2').innerHTML='<table class="t"><tr><th></th><th>Approve once</th><th>Continuous monitoring</th></tr><tr><td>Chargebacks that arrived</td><td>'+s.chargebacks_total+'</td><td>'+c.chargebacks_total+'</td></tr><tr><td>First day flagged high risk</td><td>never</td><td>'+(c.first_alert_day===null?'never':'day '+c.first_alert_day)+'</td></tr><tr><td>Money paid out</td><td>'+s.paid_out+'</td><td>'+c.paid_out+'</td></tr><tr><td>Money still held</td><td>'+s.still_held+'</td><td>'+c.still_held+'</td></tr><tr><td><b>Loss the platform absorbs</b></td><td><b class="bad">'+s.loss+'</b></td><td><b class="'+(c.loss<s.loss?'good':'warn')+'">'+c.loss+'</b></td></tr></table><h3>Loss avoided by watching: '+j.loss_avoided+'</h3><p class="hint">Days are shown only when the signals, score or actions change.</p><table class="t"><tr><th>Day</th><th>Volume</th><th>Chargeback ratio %</th><th>Signals</th><th>Score</th><th>Actions</th></tr>'+rows.map(function(x){return '<tr><td>'+x.day+'</td><td>'+x.volume+'</td><td>'+x.chargeback_ratio_pct+'</td><td>'+x.triggers.map(function(t){return '<span class="pill">'+Z.esc(S.trigger_labels[t]||t)+'</span>';}).join('')+'</td><td class="'+(x.band==='severe'||x.band==='high'?'bad':'')+'">'+x.score+' ('+x.band+')</td><td>'+x.actions.map(pill).join('')+'</td></tr>';}).join('')+'</table>';};
$('go3').onclick=async function(){var r=await api('POST','/v1/merchant-risk/thresholds',{reject_at:$('rj').value,review_at:$('rv').value});if(r.status!==200){$('m3').textContent=Z.msg(r);return;}$('m3').textContent='';var j=r.body;
$('r3').innerHTML='<table class="t"><tr><th></th><th>Merchants</th><th>Later turned out bad</th></tr><tr><td>Rejected</td><td>'+j.rejected+'</td><td>'+j.bad_rejected+'</td></tr><tr><td>Sent to an analyst</td><td>'+j.reviewed+'</td><td>'+j.bad_reviewed+'</td></tr><tr><td>Approved</td><td>'+j.approved+'</td><td class="'+(j.bad_approved?'bad':'good')+'">'+j.bad_approved+'</td></tr></table><p>Of '+j.total_later_bad+' merchants that turned out bad, rejection caught '+j.bad_rejected+' (recall '+j.recall_reject+') and rejection plus review caught '+(j.bad_rejected+j.bad_reviewed)+' (recall '+j.recall_reject_or_review+'). Precision of rejections: '+j.precision_reject+'. Good merchants wrongly rejected: '+j.good_rejected+'.</p><p class="hint">Lower the reject line and you catch more bad merchants but turn away more good ones. The analyst band costs time instead of customers.</p>';};
$('go4').onclick=async function(){var r=await api('POST','/v1/merchant-risk/drift',{feature:$('ft').value,shift:$('sh').value});if(r.status!==200){$('m4').textContent=Z.msg(r);return;}$('m4').textContent='';var j=r.body;
$('r4').innerHTML='<h3 class="'+(j.status==='stable'?'good':j.status==='watch'?'warn':'bad')+'">Index '+j.index+': '+Z.esc(j.status)+'</h3><table class="t"><tr><th>Bucket</th><th>Training</th><th>Now</th><th>Contribution</th></tr>'+j.rows.map(function(x){return '<tr><td>'+Z.esc(x.bucket)+'</td><td><span class="bar" style="width:'+Math.round(x.training*160)+'px"></span> '+x.training+'</td><td><span class="bar" style="width:'+Math.round(x.now*160)+'px"></span> '+x.now+'</td><td>'+x.contribution+'</td></tr>';}).join('')+'</table>';};
$('qgo').onclick=async function(){var a={};[].slice.call(document.querySelectorAll('#sq select')).forEach(function(s){a[s.getAttribute('data-s')]=s.value;});var r=await api('POST','/v1/merchant-risk/scenarios/score',{answers:a});if(r.status!==200){$('m5').textContent=Z.msg(r);return;}$('m5').textContent='';var j=r.body;$('qres').innerHTML='<h3 class="'+(j.passed?'good':'bad')+'">'+j.correct+' of '+j.total+(j.passed?': passed':': try again (8 to pass)')+'</h3><table class="t"><tr><th>#</th><th>Right?</th><th>Why</th></tr>'+j.rows.map(function(x){return '<tr><td>'+x.id+'</td><td class="'+(x.correct?'good':'bad')+'">'+(x.correct?'Yes':'No')+'</td><td>'+Z.esc(x.why)+'</td></tr>';}).join('')+'</table>';};
if(Z.hasKey())init();else $('top').textContent='Create a test key to start.';`;
    return UI.shell({ title: "Merchant risk lab – Zanboxx", description: "Score a merchant at onboarding, apply a policy, monitor it day by day, tune thresholds and check model drift, all on invented data.", active: "labs", body, script });
  }

  const TRIGGER_LABELS = { volume_spike: "Volume spike", ticket_shift: "Ticket size jump", decline_surge: "Declines surge", chargebacks_warning: "Chargebacks: warning", chargebacks_excessive: "Chargebacks: excessive", new_countries: "New countries", payout_account_changed: "Payout account changed" };

  return {
    async handle(req, res, path, m) {
      if (m === "GET" && path === "/labs/merchant-risk") { html(res, 200, page()); return true; }
      if (!path.startsWith("/v1/merchant-risk")) return false;
      const acc = ctx.authed(req), t = st(acc);
      if (m === "GET" && path === "/v1/merchant-risk/setup") { send(res, 200, { mcc_labels: MCC_LABEL, scenarios: SCENARIOS, action_labels: ACTION_LABEL, trigger_labels: TRIGGER_LABELS, options: OPT, scenario_list: SCEN.map((s) => ({ id: s.id, text: s.text })), model_version: MODEL, note: "Invented weights and data for teaching." }); return true; }
      if (m === "POST" && path === "/v1/merchant-risk/onboard") {
        const b = await readBody(req), mer = parseMerchant(b), appetite = String(b.appetite || "balanced"); if (!POLICY[appetite]) throw bad(400, "invalid_request", "appetite must be conservative, balanced or aggressive");
        const d = decide(mer, appetite, overridesOf(b.overrides));
        t.did.onboard_run = true; if (d.decision === "reject") t.did.onboard_reject = true; if (d.actions.some((a) => actName(a) === "reserve")) t.did.onboard_reserve = true; if (d.override) t.did.onboard_override = true; save(acc);
        send(res, 200, { score: d.score, band: d.band, decision: d.decision, actions: d.actions, override: d.override, drivers: d.contributions.slice(0, 5).map((c) => ({ code: c.code, label: c.label, points: c.points })), audit: { merchant_id: "demo-merchant", risk_score: d.score, band: d.band, decision: d.decision.toUpperCase(), model_version: MODEL, policy: appetite, timestamp: new Date().toISOString() } }); return true;
      }
      if (m === "POST" && path === "/v1/merchant-risk/monitor") {
        const b = await readBody(req) || {}, scenario = String(b.scenario || "bust_out"); if (!SCENARIOS[scenario]) throw bad(400, "invalid_request", "scenario must be one of " + Object.keys(SCENARIOS).join(", "));
        const appetite = String(b.appetite || "balanced"); if (!POLICY[appetite]) throw bad(400, "invalid_request", "appetite must be conservative, balanced or aggressive");
        const out = monitor({ scenario }, appetite, Math.round(num(b.onboarding_score, "onboarding_score", 0, 100, 35)), Math.round(num(b.settlement_delay_days, "settlement_delay_days", 0, 14, 2)), Math.round(num(b.chargeback_lag_days, "chargeback_lag_days", 0, 30, 10)));
        t.did.monitor_run = true; if (scenario === "bust_out") { t.did.monitor_bustout = true; if (out.loss_avoided > 0) t.did.monitor_caught = true; } save(acc); send(res, 200, out); return true;
      }
      if (m === "POST" && path === "/v1/merchant-risk/thresholds") {
        const b = await readBody(req) || {}, rj = num(b.reject_at, "reject_at", 1, 101, 75), rv = num(b.review_at, "review_at", 0, 100, 50); if (rv > rj) throw bad(400, "invalid_request", "review_at cannot be above reject_at");
        const o = thresholds(rj, rv); t.did.thr_run = true; if (o.recall_reject_or_review >= 0.85 && o.false_positive_rate_reject <= 0.1) t.did.thr_good = true; save(acc); send(res, 200, o); return true;
      }
      if (m === "POST" && path === "/v1/merchant-risk/drift") {
        const b = await readBody(req) || {}, o = psi(String(b.feature || "ticket"), String(b.shift || "mild")); t.did.drift_run = true; if (o.status === "retrain") t.did.drift_retrain = true; if (o.status === "stable") t.did.drift_stable = true; save(acc); send(res, 200, o); return true;
      }
      if (m === "POST" && path === "/v1/merchant-risk/scenarios/score") {
        const a = (await readBody(req)).answers; if (!a || typeof a !== "object") throw bad(400, "invalid_request", "answers must be an object of scenario id to action");
        let ok = 0; const rows = []; for (const s of SCEN) { const v = a[s.id] || a[String(s.id)]; if (v !== undefined && v !== "" && !OPT[v]) throw bad(400, "invalid_request", `Scenario ${s.id}: unknown action '${v}'`); const c = v === s.answer; if (c) ok++; rows.push({ id: s.id, correct: c, why: s.why }); }
        const passed = ok >= 8; t.did.scen_done = true; if (passed) t.did.scen_pass = true; save(acc); send(res, 200, { correct: ok, total: SCEN.length, passed, rows }); return true;
      }
      return false;
    },
  };
};
