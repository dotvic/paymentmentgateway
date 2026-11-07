"use strict";
// Risk engine lab: an explainable score from transaction signals, a rules layer, and a fixed practice dataset with hidden fraud labels.
// Everything here is a teaching model with made-up weights. It is not a real fraud model.
const FIELDS = { amount: "n", ratio: "n", velocity_1h: "n", account_age_days: "n", hour: "n", minutes_since_last: "n", device_known: "b", country_matches_home: "b", merchant_known: "b", authenticated: "b", travel_flag: "b", avs_mismatch: "b", cvv_mismatch: "b", ship_bill_mismatch: "b", ip_country_mismatch: "b", negative_file_hit: "b", cards_per_ip_1h: "n" };
const OPS = { ">": (a, b) => a > b, ">=": (a, b) => a >= b, "<": (a, b) => a < b, "<=": (a, b) => a <= b, "==": (a, b) => a === b };
const DECISIONS = ["approve", "review", "decline"];

function derive(s) {
  const ratio = s.typical_amount > 0 ? s.amount / s.typical_amount : 1;
  const travel = !s.country_matches_home && s.minutes_since_last != null && s.minutes_since_last <= 90 && s.last_country_matches_home === true;
  return { avs_mismatch: false, cvv_mismatch: false, ship_bill_mismatch: false, ip_country_mismatch: false, negative_file_hit: false, cards_per_ip_1h: 0, ...s, ratio: Math.round(ratio * 10) / 10, travel_flag: !!travel };
}
function score(sig) {
  const s = derive(sig), f = [];
  const add = (points, why) => { if (points) f.push({ points, why }); };
  add(s.ratio > 10 ? 30 : s.ratio > 4 ? 18 : s.ratio > 2 ? 8 : 0, `Amount is ${s.ratio}x this customer's usual`);
  add(s.device_known ? -5 : 18, s.device_known ? "Known device" : "New device");
  add(s.country_matches_home ? 0 : 12, "Card used outside the home country");
  add(s.travel_flag ? 30 : 0, "Impossible travel: home country a short time ago, abroad now");
  add(s.velocity_1h >= 6 ? 25 : s.velocity_1h >= 3 ? 12 : 0, `${s.velocity_1h} payments in the last hour`);
  add(s.account_age_days < 7 ? 15 : s.account_age_days < 30 ? 6 : 0, `Account is ${s.account_age_days} days old`);
  add(s.merchant_known ? 0 : 6, "First time at this merchant");
  add(s.hour >= 0 && s.hour < 5 ? 6 : 0, "Late-night payment");
  add(s.authenticated ? -15 : 0, "Customer passed strong authentication");
  add(s.avs_mismatch ? 14 : 0, "Billing address check did not match");
  add(s.cvv_mismatch ? 14 : 0, "Security code check did not match");
  add(s.ship_bill_mismatch ? 8 : 0, "Shipping address differs from billing address");
  add(s.ip_country_mismatch ? 10 : 0, "Network location country differs from billing country");
  add(s.cards_per_ip_1h >= 3 ? 20 : s.cards_per_ip_1h >= 2 ? 8 : 0, `${s.cards_per_ip_1h} different cards from one network address in the last hour`);
  add(s.negative_file_hit ? 40 : 0, "Matches your own list of confirmed fraud (negative file)");
  const raw = f.reduce((a, x) => a + x.points, 0);
  return { score: Math.max(0, Math.min(100, raw)), factors: f, derived: { ratio: s.ratio, travel_flag: s.travel_flag } };
}
function cleanRules(rules) {
  if (rules === undefined) return [];
  if (!Array.isArray(rules) || rules.length > 8) throw new Error("rules must be a list of at most 8");
  return rules.map((r, i) => {
    if (!r || !(r.field in FIELDS) || !(r.op in OPS) || !DECISIONS.includes(r.then)) throw new Error(`rule ${i + 1}: needs field, op and then (approve, review or decline)`);
    const value = FIELDS[r.field] === "b" ? (r.value === true || r.value === "true") : Number(r.value);
    if (FIELDS[r.field] === "n" && !Number.isFinite(value)) throw new Error(`rule ${i + 1}: value must be a number`);
    if (FIELDS[r.field] === "b" && r.op !== "==") throw new Error(`rule ${i + 1}: yes/no fields use ==`);
    return { field: r.field, op: r.op, value, then: r.then };
  });
}
function cleanThresholds(t) {
  const a = t && t.approve_max !== undefined ? Number(t.approve_max) : 30, d = t && t.decline_min !== undefined ? Number(t.decline_min) : 71;
  if (!Number.isFinite(a) || !Number.isFinite(d) || a < 0 || d > 100 || a >= d) throw new Error("thresholds need 0 <= approve_max < decline_min <= 100");
  return { approve_max: a, decline_min: d };
}
function decide(sig, thresholds, rules) {
  const sc = score(sig), s = derive(sig);
  for (const r of rules) if (OPS[r.op](s[r.field], r.value)) return { ...sc, decision: r.then, decided_by: `rule: ${r.field} ${r.op} ${r.value} → ${r.then}` };
  const decision = sc.score <= thresholds.approve_max ? "approve" : sc.score >= thresholds.decline_min ? "decline" : "review";
  return { ...sc, decision, decided_by: `score ${sc.score} against thresholds ${thresholds.approve_max} / ${thresholds.decline_min}` };
}

// ---- practice dataset: deterministic, 60 payments, about one in five is fraud
function lcg(seed) { let x = seed >>> 0; return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296; }
const DATASET = (() => {
  const r = lcg(20261105), pick = (a) => a[Math.floor(r() * a.length)], between = (a, b) => Math.round(a + r() * (b - a)), out = [];
  const mk = (kind, fraud, o) => out.push({ kind, fraud, typical_amount: o.typical_amount, amount: o.amount, device_known: o.device_known, country_matches_home: o.country_matches_home, merchant_known: o.merchant_known, velocity_1h: o.velocity_1h, account_age_days: o.account_age_days, hour: o.hour, minutes_since_last: o.minutes_since_last, last_country_matches_home: o.last_country_matches_home, authenticated: o.authenticated });
  for (let i = 0; i < 30; i++) { const t = between(20, 90); mk("everyday", false, { typical_amount: t, amount: Math.round(t * (0.4 + r() * 1.6)), device_known: true, country_matches_home: true, merchant_known: r() > 0.3, velocity_1h: pick([0, 0, 1, 1, 2]), account_age_days: between(60, 900), hour: between(8, 22), minutes_since_last: between(200, 4000), last_country_matches_home: true, authenticated: r() > 0.5 }); }
  for (let i = 0; i < 6; i++) { const t = between(30, 80); mk("big-purchase", false, { typical_amount: t, amount: t * between(5, 12), device_known: true, country_matches_home: true, merchant_known: r() > 0.5, velocity_1h: 1, account_age_days: between(200, 900), hour: between(10, 20), minutes_since_last: between(500, 3000), last_country_matches_home: true, authenticated: true }); }
  for (let i = 0; i < 4; i++) { const t = between(40, 90); mk("holiday", false, { typical_amount: t, amount: Math.round(t * (0.8 + r())), device_known: true, country_matches_home: false, merchant_known: false, velocity_1h: pick([1, 2]), account_age_days: between(200, 900), hour: between(9, 22), minutes_since_last: between(1500, 5000), last_country_matches_home: false, authenticated: r() > 0.4 }); }
  for (let i = 0; i < 4; i++) { const t = between(30, 70); mk("new-customer", false, { typical_amount: t, amount: t, device_known: false, country_matches_home: true, merchant_known: false, velocity_1h: 1, account_age_days: between(1, 6), hour: between(10, 21), minutes_since_last: 99999, last_country_matches_home: true, authenticated: false }); }
  for (let i = 0; i < 5; i++) { const t = between(30, 90); mk("account-takeover", true, { typical_amount: t, amount: t * between(8, 30), device_known: false, country_matches_home: false, merchant_known: false, velocity_1h: between(2, 4), account_age_days: between(100, 800), hour: between(0, 4), minutes_since_last: between(20, 80), last_country_matches_home: true, authenticated: false }); }
  for (let i = 0; i < 4; i++) { mk("card-testing", true, { typical_amount: 50, amount: between(1, 3), device_known: false, country_matches_home: true, merchant_known: false, velocity_1h: between(6, 12), account_age_days: between(1, 5), hour: between(1, 5), minutes_since_last: 1, last_country_matches_home: true, authenticated: false }); }
  for (let i = 0; i < 3; i++) { const t = between(40, 80); mk("stolen-card", true, { typical_amount: t, amount: Math.round(t * between(3, 6)), device_known: false, country_matches_home: true, merchant_known: false, velocity_1h: between(1, 3), account_age_days: between(100, 500), hour: between(12, 23), minutes_since_last: between(300, 2000), last_country_matches_home: true, authenticated: false }); }
  for (let i = 0; i < 2; i++) { const t = between(40, 80); mk("sneaky-fraud", true, { typical_amount: t, amount: Math.round(t * 1.5), device_known: true, country_matches_home: true, merchant_known: true, velocity_1h: 1, account_age_days: between(300, 900), hour: between(10, 20), minutes_since_last: between(500, 3000), last_country_matches_home: true, authenticated: false }); }
  // deterministic shuffle
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  // Address, security-code and network signals are added by pattern, without touching the random stream above.
  const seen = {};
  return out.map((o, i) => {
    const n = (seen[o.kind] = (seen[o.kind] || 0) + 1), x = {};
    if (o.kind === "stolen-card") { x.avs_mismatch = true; x.cvv_mismatch = n % 2 === 1; x.ship_bill_mismatch = true; }
    if (o.kind === "card-testing") { x.cvv_mismatch = true; x.cards_per_ip_1h = 5; }
    if (o.kind === "account-takeover") { x.ip_country_mismatch = true; x.ship_bill_mismatch = true; }
    if (o.kind === "sneaky-fraud") x.ship_bill_mismatch = n % 2 === 1; // mostly clean fraud: it passes the usual checks
    if (o.kind === "holiday") x.avs_mismatch = n % 2 === 0; // foreign address formats: a false-alarm trap
    if (o.kind === "big-purchase") x.ship_bill_mismatch = n % 3 === 0; // gifts shipped elsewhere
    return { id: "t" + String(i + 1).padStart(2, "0"), ...o, ...x };
  });
})();
const publicTx = (t) => { const { fraud, kind, ...rest } = t; return rest; };

const REVIEW_COST = 4, REVIEW_ACCURACY = 0.9;
function evaluate(thresholds, rules) {
  const th = cleanThresholds(thresholds), rl = cleanRules(rules);
  let n = { approve: 0, review: 0, decline: 0 }, fraudN = 0, legitN = 0, fraudApproved = 0, fraudReview = 0, fraudDeclined = 0, legitApproved = 0, legitReview = 0, legitDeclined = 0, fraudLoss = 0, lostSales = 0;
  const rows = DATASET.map((t) => {
    const d = decide(t, th, rl); n[d.decision]++;
    if (t.fraud) { fraudN++; if (d.decision === "approve") { fraudApproved++; fraudLoss += t.amount; } else if (d.decision === "review") { fraudReview++; fraudLoss += t.amount * (1 - REVIEW_ACCURACY); } else fraudDeclined++; }
    else { legitN++; if (d.decision === "approve") legitApproved++; else if (d.decision === "review") { legitReview++; lostSales += t.amount * (1 - REVIEW_ACCURACY); } else { legitDeclined++; lostSales += t.amount; } }
    return { id: t.id, amount: t.amount, score: d.score, decision: d.decision, fraud: t.fraud, kind: t.kind, decided_by: d.decided_by };
  });
  const r2 = (x) => Math.round(x * 100) / 100, reviewCost = n.review * REVIEW_COST;
  return {
    thresholds: th, rules: rl, counts: n,
    metrics: {
      fraud_catch_rate: r2((fraudDeclined + fraudReview * REVIEW_ACCURACY) / fraudN), false_positive_rate: r2(legitDeclined / legitN), review_rate: r2(n.review / DATASET.length), approval_rate: r2(n.approve / DATASET.length),
      fraud_loss: r2(fraudLoss), lost_sales: r2(lostSales), review_cost: reviewCost, total_cost: r2(fraudLoss + lostSales + reviewCost),
    },
    totals: { transactions: DATASET.length, fraud: fraudN, legitimate: legitN },
    assumptions: `A review costs ${REVIEW_COST} and the analyst gets it right ${REVIEW_ACCURACY * 100}% of the time. Declined fraud is fully prevented; declined legitimate sales are lost.`,
    rows,
  };
}
module.exports = { score, decide, evaluate, cleanRules, cleanThresholds, DATASET, publicTx, FIELDS, OPS };
