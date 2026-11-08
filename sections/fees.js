"use strict";
// Fees lab: how an interchange fee is built (flat, percentage, combined, min/max), what the acquirer is credited,
// blended versus interchange-plus pricing, and what a late settlement costs. All rates are INVENTED for teaching and
// are not any card scheme's rates. Amounts are in minor units (cents).

module.exports = function ({ html, ctx, UI, esc }) {
  const { send, bad, readBody, save } = ctx;
  const REGION = { PL: "EU", DE: "EU", FR: "EU", ES: "EU", IT: "EU", NL: "EU", GB: "UK", US: "US", CA: "NA", AU: "APAC", SG: "APAC", AE: "MEA", ZA: "MEA" };
  const ENTRY = { chip: { bps: -5, label: "Chip and PIN or signature" }, contactless: { bps: -5, label: "Contactless" }, online_authenticated: { bps: -3, label: "Online with strong authentication" }, online: { bps: 10, label: "Online, no authentication" }, manual: { bps: 15, label: "Manually keyed" } };
  // Invented tables. bps = basis points (1 bp = 0.01%).
  const LEVEL = {
    domestic: { debit: { kind: "percentage", bps: 20 }, credit: { kind: "percentage", bps: 30 } },
    intraregional: { debit: { kind: "combined", flat: 5, bps: 35 }, credit: { kind: "combined", flat: 5, bps: 55 } },
    interregional: { debit: { kind: "minmax", bps: 110, min: 20, max: 200 }, credit: { kind: "minmax", bps: 150, min: 25, max: 250 } },
  };
  const CASH = { kind: "combined", flat: 50, bps: 15 };
  const SCHEME = { bps: 12, min: 2 };
  const money = (c) => (c / 100).toFixed(2);
  const r = (x) => Math.round(x);
  const pos = (v) => Number.isInteger(v) && v > 0 && v < 1e9;
  const st = (acc) => (acc.fees = acc.fees || { did: {} });

  function level(m, i) { return m === i ? "domestic" : REGION[m] && REGION[m] === REGION[i] ? "intraregional" : "interregional"; }
  function structure(s, amount, entryBps) {
    // entryBps shifts only the percentage part. A rate can never go below zero.
    const bps = Math.max((s.bps || 0) + entryBps, 0);
    if (s.kind === "flat") return { fee: s.flat, steps: [`flat fee ${money(s.flat)}`] };
    if (s.kind === "percentage") return { fee: r(amount * bps / 1e4), steps: [`${(bps / 100).toFixed(2)}% of ${money(amount)} = ${money(r(amount * bps / 1e4))}`] };
    if (s.kind === "combined") { const p = r(amount * bps / 1e4); return { fee: s.flat + p, steps: [`flat ${money(s.flat)} + ${(bps / 100).toFixed(2)}% of ${money(amount)} (${money(p)}) = ${money(s.flat + p)}`] }; }
    const raw = r(amount * bps / 1e4), fee = Math.min(Math.max(raw, s.min), s.max);
    return { fee, steps: [`${(bps / 100).toFixed(2)}% of ${money(amount)} = ${money(raw)}`, `limited to the minimum ${money(s.min)} and maximum ${money(s.max)} = ${money(fee)}`] };
  }

  function quote(b) {
    if (!pos(b.amount)) throw bad(400, "invalid_request", "amount must be a positive whole number of cents");
    const mc = String(b.merchant_country || "").toUpperCase(), ic = String(b.issuer_country || "").toUpperCase();
    if (!REGION[mc] || !REGION[ic]) throw bad(400, "invalid_request", "merchant_country and issuer_country must be one of " + Object.keys(REGION).join(", "));
    const entry = ENTRY[b.entry || "chip"]; if (!entry) throw bad(400, "invalid_request", "entry must be one of " + Object.keys(ENTRY).join(", "));
    const kind = b.transaction === "cash" ? "cash" : "purchase", card = b.card === "debit" ? "debit" : "credit";
    const lvl = level(mc, ic), table = kind === "cash" ? CASH : LEVEL[lvl][card];
    const ic_fee = structure(table, b.amount, kind === "cash" ? 0 : entry.bps);
    const sch = Math.max(r(b.amount * SCHEME.bps / 1e4), SCHEME.min);
    const mk = { bps: Number.isFinite(b.markup_percent) ? Math.min(Math.max(b.markup_percent, 0), 5) * 100 : 25, flat: Number.isInteger(b.markup_flat) ? Math.min(Math.max(b.markup_flat, 0), 100) : 5 };
    const markup = r(b.amount * mk.bps / 1e4) + mk.flat;
    const out = {
      level: lvl, region: { merchant: REGION[mc], issuer: REGION[ic] }, transaction: kind, card, entry: entry.label,
      interchange: { structure: table.kind, cents: ic_fee.fee, how: ic_fee.steps, rate_designator: `${lvl.slice(0, 3).toUpperCase()}-${kind === "cash" ? "CASH" : card.toUpperCase()}-${table.kind.slice(0, 3).toUpperCase()}` },
      scheme_fee_cents: sch, acquirer_markup_cents: markup,
      // The acquirer pays interchange to the issuer. On a purchase the issuer keeps it out of the amount it sends; on cash the issuer is owed it on top.
      acquirer_credited_cents: kind === "cash" ? b.amount + ic_fee.fee : b.amount - ic_fee.fee,
      acquirer_credited_how: kind === "cash" ? `${money(b.amount)} cash paid out + fee ${money(ic_fee.fee)}` : `${money(b.amount)} − interchange ${money(ic_fee.fee)}`,
    };
    out.interchange_plus = { merchant_fee_cents: ic_fee.fee + sch + markup, merchant_receives_cents: kind === "cash" ? null : b.amount - (ic_fee.fee + sch + markup) };
    if (pos(b.blended_bps)) { const bl = r(b.amount * b.blended_bps / 1e4); out.blended = { merchant_fee_cents: bl, merchant_receives_cents: b.amount - bl, difference_vs_interchange_plus_cents: bl - out.interchange_plus.merchant_fee_cents }; }
    return out;
  }

  function lateAssessment(b) {
    if (!pos(b.unpaid_cents)) throw bad(400, "invalid_request", "unpaid_cents must be a positive whole number of cents");
    if (!Number.isInteger(b.days) || b.days < 1 || b.days > 365) throw bad(400, "invalid_request", "days must be a whole number from 1 to 365");
    const small = b.unpaid_cents < 10000000; // invented threshold: 100,000.00
    const per = small ? 20000 : r(b.unpaid_cents * 20 / 1e4); // invented: flat 200.00 a day, or 0.20% a day for large amounts
    return { rule: small ? "Below 100,000.00 unpaid: a flat 200.00 for every day." : "100,000.00 or more unpaid: 0.20% of the unpaid amount for every day.", per_day_cents: per, days: b.days, total_cents: per * b.days, note: "Charged once the account has been funded, so the bill arrives after the debt is cleared. All figures are invented." };
  }

  function page() {
    const body = `<style>.k select,.k input{width:auto;display:inline-block}.t td,.t th{padding:6px 8px;border-bottom:1px solid var(--line,#e3e7ef);text-align:left}.t td:last-child,.t th:last-child{text-align:right}</style><div class="wrap"><h1>Fees lab</h1>
<p class="lede">Follow the money on one card payment. Choose where the merchant and the card are from and how the card was read, and see how the interchange fee is built, what the acquirer is credited, and what the merchant keeps under two pricing styles. <b>All rates here are invented for teaching and are not any scheme's real rates.</b> Test data only.</p>
<div class="panel k"><strong>1. Build an interchange fee</strong>
<p>Amount <input id="am" size="8" value="100.00"> Merchant country <select id="mc"></select> Card issued in <select id="ic"></select></p>
<p>Entry <select id="en"></select> Card <select id="cd"><option value="credit">credit</option><option value="debit">debit</option></select> Type <select id="tx"><option value="purchase">purchase</option><option value="cash">cash withdrawal</option></select></p>
<p>Acquirer markup <input id="mp" size="4" value="0.25">% + <input id="mf" size="3" value="5"> cents. Blended rate to compare <input id="bl" size="4" value="1.60">% <button type="button" id="go">Calculate</button> <span id="sm" class="hint"></span></p><div id="out"></div></div>
<div class="panel k"><strong>2. What a late settlement costs</strong><p class="hint">A participant in a net debit position must fund its settlement account by the value date.</p>
<p>Unpaid <input id="up" size="9" value="30000.00"> for <input id="dy" size="3" value="20"> days <button type="button" id="lb" class="small">Calculate</button></p><div id="lo" class="hint"></div></div>
<h2>What to notice</h2><ul><li>The rate depends on <b>where</b> the merchant and the issuer are, not only on the card. Domestic is cheapest, and crossing a region costs most.</li><li>Four fee shapes exist: flat, percentage, combined (flat plus percentage) and percentage with a minimum and maximum. On small payments the minimum bites; on large ones the maximum.</li><li>Lower rates for chip, contactless and authenticated online payments are incentives to use safer ways to pay.</li><li>Under <b>interchange-plus</b> the merchant sees each cost. Under <b>blended</b> pricing one rate hides them, so the merchant pays more on cheap payments and less on dear ones.</li></ul>
<p class="hint">Related: <a href="/knowledge/how-interchange-and-fees-work">How interchange and fees work</a>, <a href="/academy/fees-clearing-reconciliation">Fees, clearing and reconciliation course</a>, <a href="/labs/clearing">Clearing and reconciliation lab</a>.</p></div>`;
    const script = `function $(i){return document.getElementById(i);}function m(c){return (c/100).toFixed(2);}
var C=${JSON.stringify(Object.keys(REGION))},E=${JSON.stringify(Object.fromEntries(Object.entries(ENTRY).map(([k, v]) => [k, v.label])))};
$("mc").innerHTML=C.map(function(c){return "<option"+(c==="PL"?" selected":"")+">"+c+"</option>";}).join("");$("ic").innerHTML=C.map(function(c){return "<option"+(c==="PL"?" selected":"")+">"+c+"</option>";}).join("");
$("en").innerHTML=Object.keys(E).map(function(k){return "<option value="+k+">"+Z.esc(E[k])+"</option>";}).join("");
function cents(s){return Math.round(parseFloat(String(s).replace(",","."))*100);}
$("go").onclick=async function(){if(!(await Z.ensureKey()))return;var b={amount:cents($("am").value),merchant_country:$("mc").value,issuer_country:$("ic").value,entry:$("en").value,card:$("cd").value,transaction:$("tx").value,markup_percent:parseFloat($("mp").value),markup_flat:parseInt($("mf").value,10),blended_bps:Math.round(parseFloat($("bl").value)*100)};
var r=await Z.api("POST","/v1/fees/interchange",b);if(r.status!==200){$("sm").textContent=Z.msg(r);return;}$("sm").textContent="";var j=r.body;
$("out").innerHTML='<p><b>'+Z.esc(j.level)+'</b> ('+Z.esc(j.region.merchant)+' merchant, '+Z.esc(j.region.issuer)+' issuer), '+Z.esc(j.transaction)+', '+Z.esc(j.entry)+'. Rate designator <code>'+Z.esc(j.interchange.rate_designator)+'</code></p><table class="t"><tr><th>Step</th><th>Amount</th></tr>'
+'<tr><td>Interchange ('+Z.esc(j.interchange.structure)+'): '+j.interchange.how.map(Z.esc).join('; ')+'</td><td>'+m(j.interchange.cents)+'</td></tr>'
+'<tr><td>Acquirer is credited: '+Z.esc(j.acquirer_credited_how)+'</td><td>'+m(j.acquirer_credited_cents)+'</td></tr>'
+'<tr><td>Scheme fee</td><td>'+m(j.scheme_fee_cents)+'</td></tr><tr><td>Acquirer markup</td><td>'+m(j.acquirer_markup_cents)+'</td></tr>'
+'<tr><td><b>Interchange-plus: merchant pays in total</b></td><td><b>'+m(j.interchange_plus.merchant_fee_cents)+'</b></td></tr>'
+(j.blended?'<tr><td><b>Blended: merchant pays</b> ('+(j.blended.difference_vs_interchange_plus_cents>=0?'costs '+m(j.blended.difference_vs_interchange_plus_cents)+' more':'saves '+m(-j.blended.difference_vs_interchange_plus_cents))+' than interchange-plus)</td><td><b>'+m(j.blended.merchant_fee_cents)+'</b></td></tr>':'')+'</table>';};
$("lb").onclick=async function(){if(!(await Z.ensureKey()))return;var r=await Z.api("POST","/v1/fees/late-assessment",{unpaid_cents:cents($("up").value),days:parseInt($("dy").value,10)});$("lo").innerHTML=r.status===200?(Z.esc(r.body.rule)+" "+m(r.body.per_day_cents)+" a day for "+r.body.days+" days = <b>"+m(r.body.total_cents)+"</b>. "+Z.esc(r.body.note)):Z.esc(Z.msg(r));};`;
    return UI.shell({ title: "Fees lab – Zanboxx", description: "Build an interchange fee from flat, percentage, combined and min/max structures, compare blended and interchange-plus pricing, and see what a late settlement costs.", active: "labs", body, script });
  }

  return {
    async handle(req, res, path, m) {
      if (m === "GET" && path === "/labs/fees") { html(res, 200, page()); return true; }
      if (!path.startsWith("/v1/fees")) return false;
      if (m === "POST" && path === "/v1/fees/interchange") {
        const acc = ctx.authed(req), b = await readBody(req), out = quote(b), t = st(acc);
        t.did.quote = true; t.did[out.level] = true; if (b.transaction === "cash") t.did.cash = true; if (out.blended) t.did.compare = true; t.did[out.interchange.structure] = true;
        save(acc); send(res, 200, out); return true;
      }
      if (m === "POST" && path === "/v1/fees/late-assessment") {
        const acc = ctx.authed(req), out = lateAssessment(await readBody(req)); st(acc).did.late = true; save(acc); send(res, 200, out); return true;
      }
      return false;
    },
  };
};
