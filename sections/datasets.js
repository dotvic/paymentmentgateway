"use strict";
// Practice datasets: three invented CSV files (merchants, transactions, chargebacks) generated deterministically from a fixed seed, with planted
// patterns, plus ten questions whose answers the learner works out in a spreadsheet, SQL or Python and checks here. All data is fictional.

module.exports = function ({ html, ctx, UI, esc }) {
  const { send, bad, readBody, save } = ctx;
  const st = (acc) => (acc.dsets = acc.dsets || { did: {} });
  const r2 = (n) => Math.round(n * 100) / 100;
  function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  const GROUPS = { retail: { mcc: "5411", w: 0.40, tk: [20, 120], cbm: 1, ecom: 0.4 }, subscriptions: { mcc: "5968", w: 0.15, tk: [8, 40], cbm: 3, ecom: 0.98 }, digital_goods: { mcc: "5815", w: 0.15, tk: [5, 60], cbm: 4, ecom: 0.99 }, travel: { mcc: "4722", w: 0.12, tk: [150, 900], cbm: 5, ecom: 0.9 }, money_services: { mcc: "6051", w: 0.08, tk: [100, 1500], cbm: 7, ecom: 0.9 }, gaming: { mcc: "7995", w: 0.10, tk: [15, 200], cbm: 9, ecom: 0.99 } };
  const COUNTRIES = ["DE", "FR", "ES", "IT", "NL", "PL", "UK"];
  const REASONS = ["fraud", "goods_not_received", "not_as_described", "duplicate_charge", "subscription_cancelled"];
  const DECLINES = ["insufficient_funds", "suspected_fraud", "expired_card", "do_not_honour"];
  const START = Date.UTC(2026, 0, 1), CUTOFF = Date.UTC(2026, 3, 30), DAY = 86400000, iso = (t) => new Date(t).toISOString().slice(0, 10);
  const N_MERCH = 500, N_TXN = 15000, BUST = 4;

  let CACHE = null;
  function build() {
    if (CACHE) return CACHE;
    const R = rng(918273645), pickG = () => { let x = R(), c = 0; for (const [g, d] of Object.entries(GROUPS)) { c += d.w; if (x < c) return g; } return "retail"; };
    const merchants = [];
    for (let i = 1; i <= N_MERCH; i++) {
      const g = pickG(), d = GROUPS[g], hi = d.cbm >= 5, avg = Math.round((d.tk[0] + R() * (d.tk[1] - d.tk[0])) * 100) / 100;
      merchants.push({ merchant_id: "M" + String(i).padStart(4, "0"), country: COUNTRIES[Math.floor(R() * COUNTRIES.length)], mcc: d.mcc, mcc_group: g, avg_ticket: avg, expected_monthly_volume: Math.round(5000 + R() * 195000), kyb_risk_score: Math.min(99, Math.floor(R() * 80 + (hi ? 15 : 0))), onboarded: iso(START - Math.floor(R() * 700) * DAY), bust: false });
    }
    const cand = merchants.filter((m) => m.mcc_group === "gaming" || m.mcc_group === "digital_goods"); for (let k = 0; k < BUST; k++) { let m; do { m = cand[Math.floor(R() * cand.length)]; } while (m.bust); m.bust = true; m.expected_monthly_volume = Math.round(20000 + R() * 20000); }
    const tot = merchants.reduce((s, m) => s + m.expected_monthly_volume, 0), txns = [], cbs = [];
    let tn = 0, cn = 0;
    for (const m of merchants) {
      const n = Math.max(8, Math.round(N_TXN * m.expected_monthly_volume / tot)), d = GROUPS[m.mcc_group], hi = d.cbm >= 5;
      for (let j = 0; j < n; j++) {
        let day = Math.floor(R() * 90); if (m.bust) { const u = R(); day = u < 0.1 ? Math.floor(R() * 31) : u < 0.25 ? 31 + Math.floor(R() * 28) : 59 + Math.floor(R() * 31); }
        const mar = day >= 59, ticket = m.avg_ticket * (m.bust && mar ? 1.6 : 1), amount = r2(Math.max(1, ticket * Math.exp((R() - 0.5) * 0.9)));
        const dom = R() < (hi ? 0.5 : 0.82), cardc = dom ? m.country : COUNTRIES[Math.floor(R() * COUNTRIES.length)], channel = R() < d.ecom ? "ecommerce" : "pos";
        const pDecl = 0.06 + (hi ? 0.04 : 0) + m.kyb_risk_score / 2000, declined = R() < pDecl; let status = declined ? "declined" : R() < 0.03 ? "refunded" : "approved";
        tn++; const id = "T" + String(tn).padStart(6, "0");
        txns.push({ transaction_id: id, merchant_id: m.merchant_id, date: iso(START + day * DAY), amount, currency: "EUR", card_country: cardc, channel, status, decline_reason: declined ? DECLINES[Math.floor(R() * DECLINES.length)] : "" });
        if (!declined) {
          const p = (m.bust ? (mar ? 0.2 : 0.01) : 0.004 * d.cbm * (1 + m.kyb_risk_score / 200)); const gate = R(), lag = 8 + Math.floor(R() * 33), opened = START + (day + lag) * DAY;
          if (gate < p && opened <= CUTOFF) {
            const rs = R(), reason = rs < (d.cbm >= 4 ? 0.55 : 0.3) ? "fraud" : REASONS[1 + Math.floor(R() * 4)], su = R(), recent = opened > CUTOFF - 20 * DAY, stt = recent && su < 0.6 ? "open" : su < 0.28 ? "won" : su < 0.85 ? "lost" : "open";
            cn++; cbs.push({ chargeback_id: "C" + String(cn).padStart(5, "0"), transaction_id: id, merchant_id: m.merchant_id, reason, amount, opened: iso(opened), lag, status: stt });
          }
        }
      }
    }
    CACHE = { merchants, txns, cbs }; return CACHE;
  }
  const csv = (rows, cols) => cols.join(",") + "\n" + rows.map((r) => cols.map((c) => { const v = r[c]; const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(",")).join("\n") + "\n";
  const FILES = {
    "merchants.csv": () => csv(build().merchants, ["merchant_id", "country", "mcc", "mcc_group", "avg_ticket", "expected_monthly_volume", "kyb_risk_score", "onboarded"]),
    "transactions.csv": () => csv(build().txns, ["transaction_id", "merchant_id", "date", "amount", "currency", "card_country", "channel", "status", "decline_reason"]),
    "chargebacks.csv": () => csv(build().cbs, ["chargeback_id", "transaction_id", "merchant_id", "reason", "amount", "opened", "status"]),
  };

  // ---------- answers ----------
  let ANS = null;
  function answers() {
    if (ANS) return ANS;
    const { merchants, txns, cbs } = build(), mg = Object.fromEntries(merchants.map((m) => [m.merchant_id, m.mcc_group])), approvedOf = (t) => t.status === "approved" || t.status === "refunded";
    const appr = txns.filter(approvedOf), nApproved = appr.length, declRate = r2(100 * txns.filter((t) => t.status === "declined").length / txns.length);
    const byG = {}, aG = {}; appr.forEach((t) => { const g = mg[t.merchant_id]; aG[g] = (aG[g] || 0) + 1; }); cbs.forEach((c) => { const g = mg[c.merchant_id]; byG[g] = (byG[g] || 0) + 1; });
    const ratios = Object.keys(GROUPS).map((g) => [g, (byG[g] || 0) / (aG[g] || 1)]).sort((a, b) => b[1] - a[1]), topG = ratios[0][0];
    const aM = {}, cM = {}; appr.forEach((t) => { aM[t.merchant_id] = (aM[t.merchant_id] || 0) + 1; }); cbs.forEach((c) => { cM[c.merchant_id] = (cM[c.merchant_id] || 0) + 1; });
    const over1 = merchants.filter((m) => (aM[m.merchant_id] || 0) >= 20 && (cM[m.merchant_id] || 0) / aM[m.merchant_id] >= 0.01).length;
    const jan = {}, mar = {}; appr.forEach((t) => { const mo = t.date.slice(5, 7); if (mo === "01") jan[t.merchant_id] = (jan[t.merchant_id] || 0) + t.amount; if (mo === "03") mar[t.merchant_id] = (mar[t.merchant_id] || 0) + t.amount; });
    const growth = merchants.filter((m) => (jan[m.merchant_id] || 0) >= 200).map((m) => [m.merchant_id, (mar[m.merchant_id] || 0) / jan[m.merchant_id]]).sort((a, b) => b[1] - a[1]);
    const ecom = appr.filter((t) => t.channel === "ecommerce"), ecomAvg = r2(ecom.reduce((s, t) => s + t.amount, 0) / ecom.length);
    const lostAmt = r2(cbs.filter((c) => c.status === "lost").reduce((s, c) => s + c.amount, 0)), lags = cbs.map((c) => c.lag).sort((a, b) => a - b), med = lags.length % 2 ? lags[(lags.length - 1) / 2] : (lags[lags.length / 2 - 1] + lags[lags.length / 2]) / 2;
    const fraudShare = r2(100 * cbs.filter((c) => c.reason === "fraud").length / cbs.length);
    ANS = [
      { q: "How many transactions were approved or later refunded (every row that is not declined)?", kind: "number", answer: nApproved, tol: 0, hint: "Count rows in the transactions file whose status is not 'declined'." },
      { q: "What is the overall decline rate, as a percentage of all transactions? Two decimals.", kind: "number", answer: declRate, tol: 0.05, hint: "Declined rows divided by all rows." },
      { q: "Which business type (mcc_group) has the highest chargeback ratio, meaning chargebacks divided by non-declined transactions?", kind: "text", answer: topG, options: Object.keys(GROUPS), hint: "Join chargebacks to merchants to get the business type, and count per type." },
      { q: "What is that highest ratio, as a percentage? Two decimals.", kind: "number", answer: r2(100 * ratios[0][1]), tol: 0.05, hint: "Chargebacks in that business type divided by its non-declined transactions, times 100." },
      { q: "How many merchants with at least 20 non-declined transactions have a chargeback ratio of 1 per cent or more?", kind: "number", answer: over1, tol: 0, hint: "Compute the ratio per merchant first, then filter." },
      { q: "Which merchant_id has the largest ratio of March to January approved volume (amounts, not counts), among merchants with at least 200 in January?", kind: "text", answer: growth[0][0], hint: "Sum amounts by month for each merchant. Ignore declined rows. Refunded rows count." },
      { q: "What is the average amount of non-declined ecommerce transactions? Two decimals.", kind: "number", answer: ecomAvg, tol: 0.05, hint: "Filter channel = ecommerce and status not declined, then average amount." },
      { q: "What is the total amount of chargebacks with status 'lost'? Two decimals.", kind: "number", answer: lostAmt, tol: 0.5, hint: "Sum the amount column for lost rows." },
      { q: "What is the median number of days between a transaction and its chargeback being opened?", kind: "number", answer: med, tol: 0.5, hint: "Join chargebacks to transactions on transaction_id and subtract dates, or use the lag in days between the two dates." },
      { q: "What share of chargebacks have the reason 'fraud', as a percentage? Two decimals.", kind: "number", answer: fraudShare, tol: 0.05, hint: "Fraud rows divided by all chargeback rows." },
    ];
    return ANS;
  }

  function page() {
    const files = Object.keys(FILES), sz = (f) => Math.round(FILES[f]().length / 1024);
    const body = `<style>.t td,.t th{padding:5px 8px;border-bottom:1px solid var(--line,#e3e7ef);text-align:left;vertical-align:top}.good{color:#1b7a3d}.bad{color:#b3261e}.dl a{display:inline-block;margin:4px 8px 4px 0;padding:8px 14px;border:1px solid #6b46f0;border-radius:8px;text-decoration:none}.q{padding:8px 0;border-bottom:1px solid var(--line,#e3e7ef)}.q input,.q select{max-width:100%;width:260px}#qres{overflow-x:auto}</style><div class="wrap"><h1>Practice datasets</h1>
<p class="lede">Three small, invented payment datasets for practising analysis in a spreadsheet, SQL or Python: merchants, transactions and chargebacks. Everything is fictional, nothing comes from a real merchant or card, and the patterns are planted so there is something to find. Download the files, work out the ten answers, then check them here.</p>
<div class="panel"><strong>1. Download</strong><p class="dl">${files.map((f) => `<a href="/datasets/${f}" download>${f} <span class="hint">${sz(f)} KB</span></a>`).join("")}</p>
<table class="t"><tr><th>File</th><th>What is in it</th></tr><tr><td>merchants.csv</td><td>${N_MERCH} merchants: id, country, business code and type, average ticket, expected monthly volume, business-checks score (higher is riskier), onboarding date.</td></tr><tr><td>transactions.csv</td><td>${build().txns.length.toLocaleString('en-US')} payments from January to March 2026: id, merchant, date, amount in euros, card country, channel, status (approved, declined, refunded), decline reason.</td></tr><tr><td>chargebacks.csv</td><td>Disputes opened by the end of April 2026: id, transaction, merchant, reason, amount, opened date, status (open, won, lost).</td></tr></table>
<p class="hint">Chargebacks are only listed once opened, and disputes on late-March sales mostly open after the data ends. That delay is real and it matters when you compute ratios.</p></div>
<div class="panel"><strong>2. Ten questions</strong><p class="hint" id="top"></p><div id="qs"></div><p><button type="button" id="go">Check my answers</button> <span class="hint" id="m"></span></p><div id="qres"></div></div>
<p class="hint">Related: <a href="/labs/merchant-risk">Merchant risk lab</a>, <a href="/labs/kpis">Payment KPIs</a>, <a href="/knowledge/analysing-payment-data-first-questions">Analysing payment data</a>, <a href="/labs">Payment Labs</a>.</p></div>`;
    const script = `function $(i){return document.getElementById(i);}async function api(a,b,c){if(!(await Z.ensureKey()))return {status:0,body:{}};return Z.api(a,b,c);}
async function init(){var r=await api('GET','/v1/datasets/questions');if(r.status!==200){$('top').textContent=Z.msg(r)||'Create a test key to start.';return;}
$('qs').innerHTML=r.body.questions.map(function(q){var f=q.options?'<select data-q="'+q.id+'"><option value="">Choose...</option>'+q.options.map(function(o){return '<option>'+Z.esc(o)+'</option>';}).join('')+'</select>':'<input data-q="'+q.id+'" inputmode="decimal" autocomplete="off">';return '<div class="q"><b>'+q.id+'.</b> '+Z.esc(q.text)+'<br>'+f+'</div>';}).join('');}
$('go').onclick=async function(){var a={};[].slice.call(document.querySelectorAll('#qs [data-q]')).forEach(function(e){if(e.value!=='')a[e.getAttribute('data-q')]=e.value;});var r=await api('POST','/v1/datasets/check',{answers:a});if(r.status!==200){$('m').textContent=Z.msg(r);return;}$('m').textContent='';var j=r.body;$('qres').innerHTML='<h3 class="'+(j.passed?'good':'bad')+'">'+j.correct+' of '+j.total+(j.passed?': passed':': keep going (8 to pass)')+'</h3><table class="t"><tr><th>#</th><th>Result</th><th>Hint</th></tr>'+j.rows.map(function(x){return '<tr><td>'+x.id+'</td><td class="'+(x.correct?'good':'bad')+'">'+(x.correct?'Correct':(x.answered?'Not yet':'Not answered'))+'</td><td>'+(x.correct?'':Z.esc(x.hint))+'</td></tr>';}).join('')+'</table>';};
if(Z.hasKey())init();else $('top').textContent='Create a test key to check your answers. The downloads work without one.';`;
    return UI.shell({ title: "Practice datasets – Zanboxx", description: "Download invented merchant, transaction and chargeback datasets and practise payment analysis in a spreadsheet, SQL or Python.", active: "labs", body, script });
  }

  return {
    async handle(req, res, path, m) {
      if (m === "GET" && path === "/labs/data") { html(res, 200, page()); return true; }
      if (m === "GET" && path.startsWith("/datasets/")) {
        const f = path.slice("/datasets/".length); if (!FILES[f]) return false;
        const out = FILES[f](); res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="zanboxx-${f}"`, "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff", "content-length": Buffer.byteLength(out) }); res.end(out); return true;
      }
      if (!path.startsWith("/v1/datasets")) return false;
      const acc = ctx.authed(req), t = st(acc);
      if (m === "GET" && path === "/v1/datasets/questions") { send(res, 200, { files: Object.keys(FILES).map((f) => "/datasets/" + f), questions: answers().map((a, i) => ({ id: i + 1, text: a.q, options: a.options || null })), note: "All data is invented." }); return true; }
      if (m === "POST" && path === "/v1/datasets/check") {
        const a = (await readBody(req)).answers; if (!a || typeof a !== "object") throw bad(400, "invalid_request", "answers must be an object of question number to your answer");
        let ok = 0; const rows = answers().map((q, i) => { const v = a[i + 1] !== undefined ? a[i + 1] : a[String(i + 1)]; const answered = v !== undefined && v !== ""; let c = false; if (answered) { if (q.kind === "number") { const n = Number(String(v).replace(",", ".")); c = isFinite(n) && Math.abs(n - q.answer) <= q.tol; } else c = String(v).trim().toLowerCase() === String(q.answer).toLowerCase(); } if (c) ok++; return { id: i + 1, correct: c, answered, hint: q.hint }; });
        const passed = ok >= 8; t.did.ds_checked = true; if (passed) t.did.ds_pass = true; if (ok === rows.length) t.did.ds_all = true; save(acc); send(res, 200, { correct: ok, total: rows.length, passed, rows }); return true;
      }
      return false;
    },
  };
};
