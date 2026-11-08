"use strict";
// Account-to-account transfers lab: account number check, payee name check, batch versus instant credit transfers,
// recall, direct debit with a mandate, payment initiation with consent, and seven transfer-scam scenarios.
// Fictional banks, names and rules, test data only. Amounts are in minor units (cents).

module.exports = function ({ html, ctx, UI, esc }) {
  const { send, bad, readBody, save } = ctx;
  const INSTANT_LIMIT = 50000, BATCH_LIMIT = 500000, SCAM_WARN_FROM = 30000, REFUND_DAYS = 56, CONSENT_MIN = 15;
  const mod97 = (s) => Number(BigInt(s) % 97n);
  const mkAcct = (bank, acct) => { const cd = String(98 - mod97(bank + acct + "351100")).padStart(2, "0"); return "ZB" + cd + bank + acct; };
  const validAcct = (n) => /^ZB\d{16}$/.test(n) && mod97(n.slice(4) + "3511" + n.slice(2, 4)) === 1;
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
  const PAYEES = [
    { key: "amber", name: "Amber Property Ltd", bank: "1000", acct: "0000000011", kind: "business", instant: true },
    { key: "north", name: "Northwind Utilities", bank: "1000", acct: "0000000022", kind: "business", instant: true },
    { key: "dana", name: "Dana Whitfield", bank: "2000", acct: "0000000033", kind: "person", instant: true },
    { key: "closed", name: "Old Wharf Cafe", bank: "2000", acct: "0000000044", kind: "business", instant: true, closed: true },
    { key: "save", name: "Sky Savings Society", bank: "3000", acct: "0000000055", kind: "business", instant: false, no_name_check: true },
    { key: "new", name: "J Kowal Trading", bank: "4000", acct: "0000000066", kind: "business", instant: true, is_new: true },
  ].map((p) => ({ ...p, number: mkAcct(p.bank, p.acct) }));
  const OWN = mkAcct("1000", "0000000001");
  const byNumber = (n) => PAYEES.find((p) => p.number === n);
  const st = (acc) => (acc.xfer = acc.xfer || { balance: 100000, cycle: 1, seq: 0, transfers: [], mandates: [], debits: [], inits: [], did: {}, answers: {}, lost: 0 });
  const nid = (t, p) => p + ++t.seq;
  const money = (c) => (c / 100).toFixed(2);

  function nameCheck(number, name) {
    if (!validAcct(number)) throw bad(400, "invalid_account_number", "That account number fails its check digits. A mistyped digit is caught here before any money moves.");
    const p = byNumber(number);
    if (!p) return { result: "unavailable", note: "The receiving bank is not known to this lab, so no name can be checked." };
    if (p.no_name_check) return { result: "unavailable", note: "This bank does not offer name checking." };
    const a = norm(name), b = norm(p.name);
    if (!a) return { result: "unavailable", note: "No name was given." };
    if (a === b) return { result: "match" };
    const ta = a.split(" "), tb = b.split(" ");
    if (ta[ta.length - 1] === tb[tb.length - 1] && ta[0][0] === tb[0][0]) return { result: "close_match", actual_name: p.name, note: "Close, but not exact. Check with the payee before you send." };
    return { result: "no_match", note: "The name does not match the account holder. Do not send until you have confirmed the details another way." };
  }

  function settle(t) {
    for (const x of t.transfers) if (x.status === "submitted") {
      const p = byNumber(x.to);
      if (p && p.closed) { x.status = "returned"; x.reason = "account_closed"; t.balance += x.amount; } else x.status = "completed";
    }
    t.cycle++; t.did.advanced = true;
  }

  function sendTransfer(t, b) {
    const to = String(b.to_number || "").replace(/\s+/g, "").toUpperCase();
    if (!validAcct(to)) throw bad(400, "invalid_account_number", "The account number fails its check digits. Re-check every digit with the payee.");
    if (to === OWN) throw bad(422, "same_account", "That is your own account.");
    const speed = b.speed === "instant" ? "instant" : b.speed === "batch" ? "batch" : null; if (!speed) throw bad(400, "invalid_request", "speed must be batch or instant");
    if (!Number.isInteger(b.amount_cents) || b.amount_cents < 1) throw bad(400, "invalid_request", "amount_cents must be a positive whole number");
    const p = byNumber(to), a = b.amount_cents;
    if (speed === "instant" && a > INSTANT_LIMIT) throw bad(422, "over_instant_limit", `Instant transfers are limited to ${money(INSTANT_LIMIT)}. Use a batch transfer for more.`);
    if (a > BATCH_LIMIT) throw bad(422, "over_limit", `The limit is ${money(BATCH_LIMIT)}.`);
    if (a > t.balance) throw bad(422, "insufficient_funds", "Not enough money in the account.");
    if (speed === "instant" && p && !p.instant) throw bad(422, "instant_not_supported", "The receiving bank does not accept instant transfers. Use a batch transfer.");
    if (b.to_name) {
      const nc = nameCheck(to, b.to_name); t.did.name_check = true;
      if ((nc.result === "no_match" || nc.result === "close_match") && !b.confirm_name_mismatch) throw bad(409, "name_" + nc.result, nc.note + " Send again with confirm_name_mismatch only if you are sure." + (nc.actual_name ? " The account holder is shown as " + nc.actual_name + "." : ""));
      if (nc.result === "no_match") t.did.sent_despite_mismatch = true;
    } else t.did.skipped_name_check = true;
    const fresh = !p || p.is_new;
    if (fresh && a >= SCAM_WARN_FROM && !b.acknowledge_warning) throw bad(409, "scam_warning", "This is a new payee and a large amount. Scammers ask people to move money to 'safe' or 'investment' accounts. Stop if anyone is rushing you or told you to ignore this warning. Send again with acknowledge_warning only if you are certain.");
    const x = { id: nid(t, "T"), to, to_name: p ? p.name : null, amount: a, speed, reference: String(b.reference || "").slice(0, 35), status: "completed", cycle: t.cycle };
    if (speed === "instant" && p && p.closed) { x.status = "rejected"; x.reason = "account_closed"; t.transfers.push(x); t.did.instant = true; return x; }
    t.balance -= a;
    if (speed === "instant") { x.status = "completed"; t.did.instant = true; if (p && p.is_new) { t.lost += a; t.did.scam_lost = true; } }
    else { x.status = "submitted"; t.did.batch = true; }
    t.transfers.push(x); return x;
  }

  const SCEN = [
    { id: "s1", title: "Rent to the landlord", context: "You pay rent of 650.00 to Amber Property Ltd every month. The account number is the one on your tenancy agreement.", number: PAYEES[0].number, entered: "Amber Property Ltd", amount: 65000, send: true, why: "Known payee, number from your own agreement, and the name check matches. This is an ordinary payment." },
    { id: "s2", title: "The 'fraud team' call", context: "A caller says they are your bank's fraud team and that your money is at risk. They ask you to move 1,200.00 to a 'safe account' now and not to tell branch staff why.", number: PAYEES[5].number, entered: "Your name", amount: 120000, send: false, why: "A bank never asks you to move money to keep it safe, and never tells you to hide the reason. The name on the account is not yours. Hang up and call the number on your card." },
    { id: "s3", title: "Supplier changes bank details", context: "An email from a supplier you trust says 'we have changed our bank'. It gives a new account for the 3,400.00 invoice. The name on the new account is not the supplier's.", number: PAYEES[5].number, entered: "Northwind Utilities", amount: 340000, send: false, why: "Changed bank details by email is a classic invoice fraud. The name check also fails. Confirm by phoning the supplier on a number you already have." },
    { id: "s4", title: "Splitting a bill with a friend", context: "Your friend Dana asked you to send 42.00 for dinner. You have paid her before at this number, and she has just confirmed it face to face.", number: PAYEES[2].number, entered: "Dana Whitfield", amount: 4200, send: true, why: "Known payee, small amount, details confirmed in person, name check matches." },
    { id: "s5", title: "Guaranteed returns", context: "A stranger online promises 'guaranteed' investment returns if you transfer 500.00 today to 'secure your place'. They say there are only two spots left.", number: PAYEES[5].number, entered: "J Kowal Trading", amount: 50000, send: false, why: "Guaranteed returns, urgency and a stranger are all warning signs. A new payee plus a large amount is exactly what the warning screen exists for." },
    { id: "s6", title: "The electricity bill", context: "Your usual utility bill is 87.40. The reference matches your bill and you have paid this account before.", number: PAYEES[1].number, entered: "Northwind Utilities", amount: 8740, send: true, why: "Known payee, matching name and the usual amount." },
    { id: "s7", title: "A bargain on a marketplace", context: "A seller offers a games console for far below the usual price, but only if you pay by bank transfer 'to hold it'. They refuse to meet or use the marketplace's payment.", number: PAYEES[2].number, entered: "Dana Whitfield", amount: 25000, send: false, why: "Refusing protected payment and pushing a transfer is a common purchase scam. A transfer cannot be disputed like a card payment, so insist on a method with protection." },
  ];

  function page() {
    const body = `<style>.k select,.k input{width:auto;display:inline-block}pre{white-space:pre-wrap;word-break:break-word;font-size:13px}.t td,.t th{padding:5px 8px;border-bottom:1px solid var(--line,#e3e7ef);text-align:left;vertical-align:top}</style><div class="wrap"><h1>Account-to-account transfers lab</h1>
<p class="lede">Move money straight from one bank account to another, with no card in between. Send a batch transfer and an instant one, lose money to a scam, recall it, set up a direct debit, approve a payment started by an app, and judge seven requests for money. Banks, names and rules are fictional. Test data only.</p>
<div class="panel k"><strong>Your account</strong> <span id="bal"></span> <span class="hint" id="acct"></span><p class="hint">Fictional payees (their numbers pass the check digits): </p><div id="pay"></div></div>
<div class="panel k"><strong>1. Send a transfer</strong>
<p>To <input id="to" size="22"> name <input id="nm" size="18"> amount <input id="am" size="7" value="25.00"> speed <select id="sp"><option>batch</option><option>instant</option></select> reference <input id="rf" size="10" value="Invoice 12"></p>
<p><label><input type="checkbox" id="cm"> I confirm despite a name warning</label> <label><input type="checkbox" id="aw"> I acknowledge the scam warning</label> <button type="button" id="sd">Send</button> <button type="button" id="nc" class="small">Check the name only</button></p><pre id="r1"></pre>
<p>Settlement: batch transfers wait for the next cut-off. <button type="button" id="ad" class="small">Run the next settlement cycle</button> <span class="hint" id="cy"></span></p><div id="tx"></div>
<p>Cancel or recall a transfer <input id="tid" size="4" placeholder="T1"> <button type="button" id="cn" class="small">Cancel (before cut-off)</button> <button type="button" id="rc" class="small">Recall: error</button> <button type="button" id="rf2" class="small">Recall: fraud</button></p><pre id="r2"></pre></div>
<div class="panel k"><strong>2. Direct debit</strong><p class="hint">A payee pulls money under a mandate you signed.</p>
<p>Creditor <select id="cr"><option>Northwind Utilities</option><option>Amber Property Ltd</option></select> monthly maximum <input id="mx" size="6" value="100.00"> <button type="button" id="mm" class="small">Sign a mandate</button></p>
<p>Mandate <input id="mi" size="3" placeholder="M1"> collect <input id="da" size="6" value="87.40"> <button type="button" id="dd" class="small">Creditor collects</button> <button type="button" id="mc" class="small">Cancel mandate</button> refund debit <input id="di" size="3" placeholder="D1"> after <input id="dd2" size="3" value="10"> days <button type="button" id="dr" class="small">Ask for a refund</button></p><pre id="r3"></pre></div>
<div class="panel k"><strong>3. A payment started by an app</strong><p class="hint">A shop's app asks your bank to pay it. You approve at the bank, and the app never sees your bank login.</p>
<p>Pay <input id="ia" size="6" value="39.90"> to <select id="ip"></select> <button type="button" id="ib" class="small">App requests payment</button> then <button type="button" id="iy" class="small">Approve at my bank</button> <button type="button" id="in" class="small">Refuse</button> <label class="hint">minutes later <input id="il" size="2" value="0"></label></p><pre id="r4"></pre></div>
<div class="panel k"><strong>4. Would you send it?</strong><div id="scn"></div></div>
<h2>What to notice</h2><ul><li>A <b>batch</b> transfer waits for a cut-off and can be cancelled before it. An <b>instant</b> transfer is final within seconds, at any hour, so checks must come first.</li><li>The account number's check digits catch typing mistakes. The <b>name check</b> catches the wrong account holder. Neither stops a customer who has been talked into paying a criminal.</li><li>A direct debit lets the payee pull money. The mandate and a no-questions refund window protect the payer.</li><li>With a payment started by an app, the bank asks for your consent. The app never holds your credentials.</li></ul>
<p class="hint">Related: <a href="/knowledge/account-to-account-payments">Account-to-account payments</a>, <a href="/knowledge/open-banking-payments-and-transfer-fraud">Open banking payments and transfer fraud</a>, <a href="/academy/account-to-account-payments">Course</a>.</p></div>`;
    const script = `function $(i){return document.getElementById(i);}function m(c){return (c/100).toFixed(2);}function cents(s){return Math.round(parseFloat(String(s).replace(",","."))*100);}
var S=null;async function api(a,b,c){if(!(await Z.ensureKey()))return {status:0,body:{}};return Z.api(a,b,c);}
function show(id,r){$(id).textContent="HTTP "+r.status+"\\n"+JSON.stringify(r.body,null,1);}
async function load(){var r=await api("GET","/v1/transfers");if(r.status!==200)return;S=r.body;$("bal").textContent="Balance "+m(S.balance_cents)+" ("+S.own_number+")";
$("pay").innerHTML='<table class="t"><tr><th>Name</th><th>Number</th><th>Notes</th></tr>'+S.payees.map(function(p){return "<tr><td>"+Z.esc(p.name)+"</td><td><code>"+p.number+"</code></td><td>"+Z.esc(p.note)+"</td></tr>";}).join("")+"</table>";
$("ip").innerHTML=S.payees.map(function(p){return '<option value="'+p.number+'">'+Z.esc(p.name)+"</option>";}).join("");$("cy").textContent="Cycle "+S.cycle;
$("tx").innerHTML=S.transfers.length?'<table class="t"><tr><th>Id</th><th>To</th><th>Amount</th><th>Speed</th><th>Status</th></tr>'+S.transfers.map(function(x){return "<tr><td>"+x.id+"</td><td>"+Z.esc(x.to_name||x.to)+"</td><td>"+m(x.amount)+"</td><td>"+x.speed+"</td><td>"+x.status+(x.reason?" ("+x.reason+")":"")+"</td></tr>";}).join("")+"</table>":"";}
$("sd").onclick=async function(){var r=await api("POST","/v1/transfers/send",{to_number:$("to").value,to_name:$("nm").value||undefined,amount_cents:cents($("am").value),speed:$("sp").value,reference:$("rf").value,confirm_name_mismatch:$("cm").checked,acknowledge_warning:$("aw").checked});show("r1",r);load();};
$("nc").onclick=async function(){show("r1",await api("POST","/v1/transfers/name-check",{number:$("to").value,name:$("nm").value}));};
$("ad").onclick=async function(){show("r2",await api("POST","/v1/transfers/advance",{}));load();};
$("cn").onclick=async function(){show("r2",await api("POST","/v1/transfers/"+$("tid").value+"/cancel",{}));load();};
$("rc").onclick=async function(){show("r2",await api("POST","/v1/transfers/"+$("tid").value+"/recall",{reason:"error"}));load();};$("rf2").onclick=async function(){show("r2",await api("POST","/v1/transfers/"+$("tid").value+"/recall",{reason:"fraud"}));load();};
$("mm").onclick=async function(){show("r3",await api("POST","/v1/transfers/mandates",{creditor:$("cr").value,max_cents:cents($("mx").value)}));};
$("dd").onclick=async function(){show("r3",await api("POST","/v1/transfers/debits",{mandate_id:$("mi").value||undefined,amount_cents:cents($("da").value)}));load();};
$("mc").onclick=async function(){show("r3",await api("POST","/v1/transfers/mandates/"+$("mi").value+"/cancel",{}));};
$("dr").onclick=async function(){show("r3",await api("POST","/v1/transfers/debits/"+$("di").value+"/refund",{days_since:parseInt($("dd2").value,10)}));load();};
var IID=null;$("ib").onclick=async function(){var r=await api("POST","/v1/transfers/initiations",{app:"ShopApp",payee_number:$("ip").value,amount_cents:cents($("ia").value),reference:"Order 77"});if(r.body&&r.body.id)IID=r.body.id;show("r4",r);};
$("iy").onclick=async function(){if(!IID){$("r4").textContent="Press 'App requests payment' first.";return;}show("r4",await api("POST","/v1/transfers/initiations/"+IID+"/consent",{approve:true,minutes_later:parseInt($("il").value,10)||0}));load();};
$("in").onclick=async function(){if(!IID){$("r4").textContent="Press 'App requests payment' first.";return;}show("r4",await api("POST","/v1/transfers/initiations/"+IID+"/consent",{approve:false}));};
async function scen(){var r=await api("GET","/v1/transfers/scenarios");if(r.status!==200)return;$("scn").innerHTML=r.body.scenarios.map(function(s){return '<div class="panel"><strong>'+Z.esc(s.title)+'</strong><p>'+Z.esc(s.context)+'</p><p class="hint">Amount '+m(s.amount_cents)+'. Name entered: '+Z.esc(s.entered)+'. Bank name check: <b>'+Z.esc(s.name_check)+'</b>.</p><button type="button" class="small" data-i="'+s.id+'" data-d="send">Send</button> <button type="button" class="small" data-i="'+s.id+'" data-d="stop">Stop</button> <span id="a-'+s.id+'" class="hint">'+(s.answered?(s.answered.correct?"Answered correctly.":"Answered wrongly. Try again to see why."):"")+'</span></div>';}).join("");}
$("scn").onclick=async function(e){var b=e.target.closest("button");if(!b)return;var r=await api("POST","/v1/transfers/scenarios/"+b.dataset.i+"/answer",{decision:b.dataset.d});$("a-"+b.dataset.i).innerHTML=r.status===200?("<b>"+(r.body.correct?"Correct. ":"Not quite. ")+"</b>"+Z.esc(r.body.why)):Z.esc(Z.msg(r));};
if(Z.hasKey()){load();scen();}else $("bal").textContent="Create a test key to start.";`;
    return UI.shell({ title: "Account-to-account transfers lab – Zanboxx", description: "Send batch and instant bank transfers, recall them, set up a direct debit, approve an app-initiated payment and judge seven transfer-scam scenarios.", active: "labs", body, script });
  }

  return {
    async handle(req, res, path, m) {
      if (m === "GET" && path === "/labs/transfers") { html(res, 200, page()); return true; }
      if (!path.startsWith("/v1/transfers")) return false;
      const acc = ctx.authed(req), t = st(acc);
      if (m === "GET" && path === "/v1/transfers") {
        send(res, 200, { own_number: OWN, balance_cents: t.balance, cycle: t.cycle, limits: { instant_cents: INSTANT_LIMIT, batch_cents: BATCH_LIMIT, scam_warning_from_cents: SCAM_WARN_FROM }, payees: PAYEES.map((p) => ({ name: p.name, number: p.number, note: p.closed ? "account closed" : p.no_name_check ? "batch only, no name check" : p.is_new ? "opened 2 days ago" : p.kind })), transfers: t.transfers, mandates: t.mandates, debits: t.debits, lost_to_fraud_cents: t.lost }); return true;
      }
      if (m === "POST" && path === "/v1/transfers/name-check") { const b = await readBody(req), out = nameCheck(String(b.number || "").replace(/\s+/g, "").toUpperCase(), b.name); t.did.name_check = true; if (out.result === "no_match") t.did.mismatch_seen = true; save(acc); send(res, 200, out); return true; }
      if (m === "POST" && path === "/v1/transfers/send") { const x = sendTransfer(t, await readBody(req)); save(acc); send(res, 200, { ...x, balance_cents: t.balance }); return true; }
      if (m === "POST" && path === "/v1/transfers/advance") { settle(t); save(acc); send(res, 200, { cycle: t.cycle, balance_cents: t.balance, transfers: t.transfers.map((x) => ({ id: x.id, status: x.status, reason: x.reason || null })) }); return true; }
      let g = path.match(/^\/v1\/transfers\/(T\d+)\/(cancel|recall)$/);
      if (m === "POST" && g) {
        const x = t.transfers.find((y) => y.id === g[1]); if (!x) throw bad(404, "not_found", "No such transfer");
        if (g[2] === "cancel") {
          if (x.status !== "submitted") throw bad(409, "too_late", x.status === "completed" ? "This transfer has already settled. Ask for a recall instead; the payee's bank decides." : "Only a submitted batch transfer can be cancelled.");
          x.status = "cancelled"; t.balance += x.amount; t.did.cancelled = true; save(acc); send(res, 200, { ...x, balance_cents: t.balance }); return true;
        }
        const reason = (await readBody(req)).reason; if (!["error", "fraud"].includes(reason)) throw bad(400, "invalid_request", "reason must be error or fraud");
        if (x.status !== "completed") throw bad(409, "not_recallable", "Only a completed transfer can be recalled.");
        const p = byNumber(x.to);
        if (p && p.is_new) { x.status = "recall_failed"; x.reason = reason === "fraud" ? "funds_already_moved_on" : "payee_bank_refused_without_consent"; t.did.recall_failed = true; save(acc); send(res, 200, { ...x, recovered_cents: 0, note: "The money had already left the receiving account. Recovery after instant fraud is often partial or nil, so report within minutes." }); return true; }
        x.status = "recalled"; t.balance += x.amount; t.did.recalled = true; save(acc); send(res, 200, { ...x, recovered_cents: x.amount, balance_cents: t.balance, note: "The payee's bank agreed and returned the money." }); return true;
      }
      if (m === "POST" && path === "/v1/transfers/mandates") {
        const b = await readBody(req); if (!["Northwind Utilities", "Amber Property Ltd"].includes(b.creditor)) throw bad(400, "invalid_request", "creditor must be Northwind Utilities or Amber Property Ltd");
        if (!Number.isInteger(b.max_cents) || b.max_cents < 1) throw bad(400, "invalid_request", "max_cents must be a positive whole number");
        const mm = { id: nid(t, "M"), creditor: b.creditor, max_cents: b.max_cents, status: "active" }; t.mandates.push(mm); t.did.mandate = true; save(acc); send(res, 200, mm); return true;
      }
      g = path.match(/^\/v1\/transfers\/mandates\/(M\d+)\/cancel$/);
      if (m === "POST" && g) { const mm = t.mandates.find((y) => y.id === g[1]); if (!mm) throw bad(404, "not_found", "No such mandate"); mm.status = "cancelled"; t.did.mandate_cancelled = true; save(acc); send(res, 200, mm); return true; }
      if (m === "POST" && path === "/v1/transfers/debits") {
        const b = await readBody(req); if (!Number.isInteger(b.amount_cents) || b.amount_cents < 1) throw bad(400, "invalid_request", "amount_cents must be a positive whole number");
        if (!b.mandate_id) { t.did.no_mandate = true; save(acc); throw bad(422, "no_mandate", "A debit needs a mandate. Without one the collection is rejected, and if it slipped through you could claim it back as unauthorised."); }
        const mm = t.mandates.find((y) => y.id === b.mandate_id); if (!mm) throw bad(404, "not_found", "No such mandate");
        if (mm.status !== "active") { t.did.cancelled_blocked = true; save(acc); throw bad(422, "mandate_cancelled", "The mandate was cancelled, so the collection is rejected."); }
        if (b.amount_cents > mm.max_cents) throw bad(422, "above_mandate_limit", "The amount is above the maximum you agreed in the mandate.");
        if (b.amount_cents > t.balance) throw bad(422, "insufficient_funds", "Not enough money. The debit is returned unpaid.");
        t.balance -= b.amount_cents; const d = { id: nid(t, "D"), mandate_id: mm.id, creditor: mm.creditor, amount: b.amount_cents, status: "collected" }; t.debits.push(d); t.did.debit = true; save(acc); send(res, 200, { ...d, balance_cents: t.balance }); return true;
      }
      g = path.match(/^\/v1\/transfers\/debits\/(D\d+)\/refund$/);
      if (m === "POST" && g) {
        const d = t.debits.find((y) => y.id === g[1]); if (!d) throw bad(404, "not_found", "No such debit"); const days = (await readBody(req)).days_since;
        if (!Number.isInteger(days) || days < 0 || days > 1000) throw bad(400, "invalid_request", "days_since must be a whole number of days");
        if (d.status !== "collected") throw bad(409, "not_refundable", "Already refunded.");
        if (days > REFUND_DAYS) throw bad(422, "outside_refund_window", `The no-questions refund window is ${REFUND_DAYS} days. After that you can only claim if the debit was unauthorised.`);
        d.status = "refunded"; t.balance += d.amount; t.did.refunded = true; save(acc); send(res, 200, { ...d, balance_cents: t.balance }); return true;
      }
      if (m === "POST" && path === "/v1/transfers/initiations") {
        const b = await readBody(req), n = String(b.payee_number || "").replace(/\s+/g, "").toUpperCase(); if (!validAcct(n)) throw bad(400, "invalid_account_number", "The payee account number fails its check digits.");
        if (!Number.isInteger(b.amount_cents) || b.amount_cents < 1) throw bad(400, "invalid_request", "amount_cents must be a positive whole number");
        const p = byNumber(n), i = { id: nid(t, "I"), app: String(b.app || "ShopApp").slice(0, 30), payee_number: n, payee_name: p ? p.name : null, amount: b.amount_cents, reference: String(b.reference || "").slice(0, 35), status: "awaiting_consent", expires_in_minutes: CONSENT_MIN };
        t.inits.push(i); t.did.initiated = true; save(acc); send(res, 200, { ...i, consent_screen: `${i.app} asks to pay ${money(i.amount)} to ${i.payee_name || i.payee_number}, once. It will not see your login or balance.` }); return true;
      }
      g = path.match(/^\/v1\/transfers\/initiations\/(I\d+)\/consent$/);
      if (m === "POST" && g) {
        const i = t.inits.find((y) => y.id === g[1]); if (!i) throw bad(404, "not_found", "No such request"); if (i.status !== "awaiting_consent") throw bad(409, "already_decided", "This request was already decided: " + i.status);
        const b = await readBody(req), later = Math.min(Math.max(Number(b.minutes_later) || 0, 0), 600);
        if (later > CONSENT_MIN) { i.status = "expired"; t.did.consent_expired = true; save(acc); send(res, 200, i); return true; }
        if (!b.approve) { i.status = "refused"; t.did.consent_refused = true; save(acc); send(res, 200, i); return true; }
        if (i.amount > t.balance) { i.status = "failed"; i.reason = "insufficient_funds"; save(acc); send(res, 200, i); return true; }
        t.balance -= i.amount; i.status = "paid"; const x = { id: nid(t, "T"), to: i.payee_number, to_name: i.payee_name, amount: i.amount, speed: "instant", reference: i.reference, status: "completed", cycle: t.cycle, via: i.app }; t.transfers.push(x); t.did.initiation_paid = true; save(acc); send(res, 200, { ...i, transfer_id: x.id, balance_cents: t.balance }); return true;
      }
      if (m === "GET" && path === "/v1/transfers/scenarios") {
        send(res, 200, { scenarios: SCEN.map((s) => ({ id: s.id, title: s.title, context: s.context, amount_cents: s.amount, entered: s.entered, name_check: nameCheck(s.number, s.entered).result === "match" ? "match" : nameCheck(s.number, s.entered).result, answered: t.answers[s.id] || null })) }); return true;
      }
      g = path.match(/^\/v1\/transfers\/scenarios\/(s\d)\/answer$/);
      if (m === "POST" && g) {
        const s = SCEN.find((x) => x.id === g[1]); if (!s) throw bad(404, "not_found", "No such scenario");
        const d = (await readBody(req)).decision; if (!["send", "stop"].includes(d)) throw bad(400, "invalid_request", "decision must be send or stop");
        const correct = (d === "send") === s.send; t.answers[s.id] = { decision: d, correct };
        const ok = Object.values(t.answers).filter((x) => x.correct).length; if (ok >= SCEN.length) t.did.all_correct = true;
        save(acc); send(res, 200, { correct, should: s.send ? "send" : "stop", why: s.why, scenarios_correct: ok, of: SCEN.length }); return true;
      }
      return false;
    },
  };
};
