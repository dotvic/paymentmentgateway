"use strict";
// 3DS Assurance lab: five hands-on exercises on EMV 3-D Secure. (1) flow explorer, (2) issuer decision desk,
// (3) merchant strategy simulator (with an out-of-band rescue option), (4) readiness check.
// Everything is a teaching model: every number, rate and transaction is invented. Answer keys stay on the server.

module.exports = function ({ html, ctx, UI, esc }) {
  const { send, bad, readBody, save } = ctx;
  const st = (acc) => (acc.assur = acc.assur || { did: {}, flows: {}, desk: null, strat: null, ready: null });

  // ---------- 1. flow explorer (written in our own words) ----------
  const FLOWS = [
    { id: "frictionless", title: "Frictionless", when: "The issuer sees low risk and does not need to ask the buyer anything.", steps: [
      ["Merchant", "3DS Server", "Start", "Your checkout sends the amount, card and as much buyer and device data as it can."],
      ["Browser", "Issuer ACS", "3DS Method", "A hidden page lets the issuer read device signals. Optional, but it helps the decision."],
      ["3DS Server", "Issuer ACS", "AReq", "The authentication request travels through the Directory Server to the right issuer."],
      ["Issuer ACS", "Issuer ACS", "Risk check", "The issuer compares the request with what it knows about the card and the device."],
      ["Issuer ACS", "3DS Server", "ARes (Y)", "Status Y with an authentication value and an ECI. The buyer saw nothing."],
      ["Merchant", "Acquirer", "Authorise", "Send the authorisation with the 3DS proof. Fraud liability moves to the issuer."]] },
    { id: "challenge-otp", title: "Challenge with a code", when: "The issuer wants proof. It shows a page that asks for a one-time code.", steps: [
      ["3DS Server", "Issuer ACS", "AReq", "Same request as before."],
      ["Issuer ACS", "3DS Server", "ARes (C)", "Status C: a challenge is needed. No authentication value yet."],
      ["Browser", "Issuer ACS", "CReq", "The buyer's browser opens the issuer page, in a frame or a full page."],
      ["Issuer ACS", "Browser", "CRes", "The page asks for the code that was sent to the buyer."],
      ["Browser", "Issuer ACS", "CReq + code", "The buyer types the code and it goes to the issuer."],
      ["Issuer ACS", "3DS Server", "RReq", "The final result arrives from the issuer directly. Trust this, not the browser."],
      ["Merchant", "Acquirer", "Authorise", "Only now, with the proof, if the status is Y."]] },
    { id: "oob-app", title: "Challenge in a banking app", when: "The buyer approves in their bank's app, on the same or another device.", steps: [
      ["Issuer ACS", "3DS Server", "ARes (C)", "A challenge is required and the method is out of band."],
      ["Issuer ACS", "Browser", "CRes", "The page tells the buyer to open their banking app. A push message is sent."],
      ["Buyer", "Bank app", "Approve", "The buyer checks the amount and merchant in the app and approves with a fingerprint or face."],
      ["Issuer ACS", "3DS Server", "RReq", "The result reaches the merchant side from the issuer."],
      ["Browser", "Issuer ACS", "Final CReq", "The page moves on once the buyer confirms or the page notices the approval."],
      ["Merchant", "Acquirer", "Authorise", "Continue with the proof."]] },
    { id: "oob-mobile-browser", title: "Out of band on a phone browser (the weak spot)", when: "The buyer is in a mobile browser and must jump to a banking app on the same phone.", steps: [
      ["Browser", "Issuer ACS", "Challenge frame", "The checkout page shows the issuer frame: open your app."],
      ["Buyer", "Bank app", "Switch app", "The browser goes to the background. Some phones pause or drop the page."],
      ["Buyer", "Bank app", "Approve", "The buyer approves, then has to find their way back."],
      ["Buyer", "Browser", "Press Complete", "A missed or late press means the page times out even though the buyer approved."],
      ["Issuer ACS", "3DS Server", "RReq (if sent)", "Better design: the issuer sends the result straight to the merchant, so the press is not needed."],
      ["Merchant", "Merchant", "Resume", "With the direct result the merchant can finish the order even if the buyer never comes back to the tab."]] },
    { id: "decoupled", title: "Decoupled authentication", when: "The usual challenge page cannot be used, or the buyer is not present.", steps: [
      ["Merchant", "3DS Server", "Preferences", "The merchant says it accepts decoupled and for how many minutes it will wait."],
      ["3DS Server", "Issuer ACS", "AReq", "The request carries the decoupled indicator."],
      ["Issuer ACS", "3DS Server", "ARes", "The issuer confirms it will use decoupled and may give the buyer a text to display."],
      ["Issuer ACS", "Buyer", "Out of band", "A push, text, email or call is used. This can happen minutes later."],
      ["Issuer ACS", "3DS Server", "RReq", "Result Y or N comes back whenever the buyer acts, within the wait time."],
      ["Merchant", "Acquirer", "Authorise", "Authorise on Y. If the time ran out, treat it as not authenticated."]] },
    { id: "3ri", title: "Merchant-initiated (3RI)", when: "The merchant authenticates without the buyer present, for example a later subscription payment.", steps: [
      ["Merchant", "3DS Server", "Request", "Reference the earlier authenticated payment. The channel is merchant-initiated."],
      ["3DS Server", "Issuer ACS", "AReq", "No browser data, since nobody is at a screen."],
      ["Issuer ACS", "3DS Server", "ARes", "Normally Y or N. A challenge is not possible here, so only decoupled can ask the buyer."],
      ["Merchant", "Acquirer", "Authorise", "Send the authorisation with the result and the link to the first payment."]] },
    { id: "fallback", title: "A challenge that falls back", when: "A normal challenge starts but cannot finish, for example a poor connection.", steps: [
      ["Issuer ACS", "3DS Server", "ARes (C)", "A challenge is needed."],
      ["Browser", "Issuer ACS", "CReq", "The buyer starts the challenge."],
      ["Issuer ACS", "3DS Server", "RReq (D)", "The issuer cannot finish and reports status D: switch to decoupled."],
      ["3DS Server", "Issuer ACS", "3RI request", "A merchant-initiated request follows with the decoupled preferences."],
      ["Issuer ACS", "Buyer", "Out of band", "The buyer is asked another way."],
      ["Issuer ACS", "3DS Server", "RReq (Y/N)", "The final result."]] },
  ];

  // ---------- 2. issuer decision desk ----------
  // g = genuine. cls: clear (obviously fine) | border (genuine but unusual) | fraud
  const TX = [
    { id: 1, amt: 12.5, sig: "Known device. Billing country matches. 14 earlier orders.", cls: "clear", why: "Textbook low risk. A challenge would only add friction." },
    { id: 2, amt: 45, sig: "Known device. Matches. 6 earlier orders. Phone-wallet token.", cls: "clear", why: "Known device and a token. Let it through." },
    { id: 3, amt: 899, sig: "New device. Country matches. 2 earlier orders. Amount is 4x the usual.", cls: "border", why: "Genuine, but new device plus a large jump. A challenge was a fair call." },
    { id: 4, amt: 1250, sig: "New device. Device country differs from billing. No history. 5 attempts in 3 minutes.", cls: "fraud", why: "Rapid attempts and a country mismatch point to a stolen card." },
    { id: 5, amt: 29.99, sig: "Known device. Third monthly renewal of a plan the buyer set up.", cls: "clear", why: "Recurring payment after an authenticated first payment. Low risk." },
    { id: 6, amt: 310, sig: "Known device. Matches. 9 earlier orders. Inside the usual range.", cls: "clear", why: "Normal behaviour for this card." },
    { id: 7, amt: 74, sig: "New device. Matches. No orders here, but a wallet token and an email 4 years old.", cls: "border", why: "A token and an aged email are strong comfort signals. Either choice is defensible." },
    { id: 8, amt: 540, sig: "New device. Country differs. Email created today. Ship-to differs from billing.", cls: "fraud", why: "Brand-new email, mismatched countries and a different ship-to." },
    { id: 9, amt: 15, sig: "Known device. Matches. Small amount.", cls: "clear", why: "Small amount, known device." },
    { id: 10, amt: 2200, sig: "Known device, BUT the password was reset 10 minutes ago and the delivery address was just changed. 5x the usual spend.", cls: "fraud", why: "Account takeover. A known device does not help when the account was just taken over." },
    { id: 11, amt: 60, sig: "New browser on a VPN. Matches. 11 earlier orders.", cls: "border", why: "Long history, odd network. Low stakes: approving or asking are both fine." },
    { id: 12, amt: 4, sig: "New device. Country differs. 12 attempts in 2 minutes on different cards.", cls: "fraud", why: "Card testing. Small amounts are how criminals check a stolen card works." },
    { id: 13, amt: 180, sig: "Known device. Matches. 4 earlier orders.", cls: "clear", why: "Normal." },
    { id: 14, amt: 95, sig: "Known device. Matches. Recurring plan.", cls: "clear", why: "Normal recurring payment." },
    { id: 15, amt: 650, sig: "New device. Matches. 1 earlier order. Phone-wallet token present.", cls: "border", why: "Token helps, amount is large for this buyer. Challenge is safe." },
    { id: 16, amt: 38, sig: "Known device. Matches. 8 earlier orders.", cls: "clear", why: "Normal." },
    { id: 17, amt: 1500, sig: "New device. Country differs. Ship-to is a freight-forwarding address. No history.", cls: "fraud", why: "Forwarding addresses and a first big order are a common fraud pattern." },
    { id: 18, amt: 22, sig: "Known device. Matches.", cls: "clear", why: "Normal." },
    { id: 19, amt: 120, sig: "New browser, same phone model. Matches. 8 earlier orders.", cls: "border", why: "Mostly familiar. A silent approval would also be reasonable." },
    { id: 20, amt: 49, sig: "Known device. Matches. 12 earlier orders.", cls: "clear", why: "Normal." },
  ];
  const PAY = { clear: { approve: 2, challenge: 1, decline: -3 }, border: { approve: 1, challenge: 1.5, decline: -3 }, fraud: { approve: -6, challenge: 2, decline: 2 } };
  const CH = ["approve", "challenge", "decline"];

  function scoreDesk(b) {
    const d = b && b.decisions; if (!d || typeof d !== "object") throw bad(400, "invalid_request", "decisions must be an object of transaction id to approve, challenge or decline");
    const rows = []; let pts = 0, max = 0, fraudApproved = 0, genChallenged = 0, genDeclined = 0, fraudStopped = 0, approvedValue = 0;
    for (const t of TX) {
      const c = d[t.id] || d[String(t.id)];
      if (!CH.includes(c)) throw bad(400, "invalid_request", `Choose approve, challenge or decline for transaction ${t.id}`);
      const p = PAY[t.cls][c]; pts += p; max += Math.max(...Object.values(PAY[t.cls]));
      if (t.cls === "fraud") { if (c === "approve") fraudApproved++; else fraudStopped++; } else { if (c === "challenge") genChallenged++; if (c === "decline") genDeclined++; }
      if (c === "approve") approvedValue += t.amt;
      rows.push({ id: t.id, decision: c, points: p, genuine: t.cls !== "fraud", why: t.why });
    }
    const n = TX.length, fraudN = TX.filter((t) => t.cls === "fraud").length;
    return { score: Math.round(((pts + 3 * n) / (max + 3 * n)) * 100), points: pts, rows, fraud_total: fraudN, fraud_approved: fraudApproved, fraud_stopped: fraudStopped, genuine_challenged: genChallenged, genuine_declined: genDeclined,
      clean: fraudApproved === 0 && genDeclined === 0 && genChallenged <= 7, summary: `You approved ${fraudApproved} of ${fraudN} fraudulent payments, challenged ${genChallenged} genuine buyers and declined ${genDeclined}.` };
  }

  // ---------- 3. merchant strategy simulator ----------
  const N = 10000, AVG = 60;
  const EX = { low_value: { share: 0.12, fraud: 0.005, label: "Low-value exemption" }, trusted: { share: 0.08, fraud: 0.001, label: "Trusted beneficiary" }, recurring: { share: 0.1, fraud: 0.002, label: "Recurring after first payment" }, corporate: { share: 0.03, fraud: 0.0005, label: "Secure corporate payment" } };
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  function strategy(b) {
    const dq = Number(b.data_quality); if (!Number.isFinite(dq) || dq < 0 || dq > 100) throw bad(400, "invalid_request", "data_quality must be a number from 0 to 100");
    const ver = String(b.version || "2.2"); if (!["2.1", "2.2", "2.3"].includes(ver)) throw bad(400, "invalid_request", "version must be 2.1, 2.2 or 2.3");
    const pref = String(b.challenge_pref || "none"); if (!["none", "prefer", "mandate"].includes(pref)) throw bad(400, "invalid_request", "challenge_pref must be none, prefer or mandate");
    const ex = b.exemptions && typeof b.exemptions === "object" ? b.exemptions : {};
    const direct = b.oob_direct === true, help = b.ux_help === true, bound = b.device_binding === true && ver === "2.3";
    let exShare = 0, exFraudCount = 0; const exRows = [];
    for (const k of Object.keys(EX)) if (ex[k] === true) { exShare += EX[k].share; const cnt = N * EX[k].share; exFraudCount += cnt * EX[k].fraud; exRows.push({ name: EX[k].label, transactions: Math.round(cnt), fraud_transactions: +(cnt * EX[k].fraud).toFixed(1) }); }
    exShare = Math.min(exShare, 0.3);
    const R = N * (1 - exShare);
    let frict = clamp(35 + 0.45 * dq + { "2.1": -8, "2.2": 0, "2.3": 4 }[ver] + (bound ? 6 : 0), 0, 92) / 100;
    if (pref === "prefer") frict *= 0.85; if (pref === "mandate") frict = Math.min(frict, 0.1);
    const challenged = R * (1 - frict), frictionless = R * frict;
    const abandon = clamp(0.22 - (direct ? 0.08 : 0) - (help ? 0.03 : 0) + (pref === "mandate" ? 0.04 : 0), 0.04, 0.4);
    const abandoned = challenged * abandon, completed = frictionless + challenged - abandoned + N * exShare;
    // fraud the merchant carries: exempt fraud (no liability shift) plus a sliver of the authenticated volume the issuer carries
    const merchantFraud = exFraudCount, issuerFraud = (frictionless * 0.001 + (challenged - abandoned) * 0.0005);
    const merchantLoss = merchantFraud * AVG, approval = completed / N, lost = abandoned * AVG;
    const net = completed * AVG * 0.12 - merchantLoss; const base = N * AVG * 0.12;
    const out = { transactions: N, average_order: AVG, exempt_share_percent: +(exShare * 100).toFixed(1), frictionless_percent_of_rest: +(frict * 100).toFixed(1), challenged: Math.round(challenged), abandoned_challenges: Math.round(abandoned), abandonment_percent: +(abandon * 100).toFixed(1),
      approval_rate_percent: +(approval * 100).toFixed(1), merchant_fraud_transactions: +merchantFraud.toFixed(1), issuer_fraud_transactions: +issuerFraud.toFixed(1), merchant_fraud_loss: Math.round(merchantLoss), sales_lost_to_abandonment: Math.round(lost),
      net_margin: Math.round(net), net_margin_vs_perfect_percent: +((net / base) * 100).toFixed(1), exemptions_used: exRows, device_binding_applied: bound };
    const tips = [];
    if (ver === "2.1") tips.push("Version 2.1 gives issuers less data than 2.2 or newer. Upgrading raises the frictionless share.");
    if (dq < 60) tips.push("Low data quality. Send the full cardholder and device data so the issuer can approve silently.");
    if (pref === "mandate") tips.push("Mandating a challenge on everything adds friction and abandonment. Reserve it for risky orders.");
    if (challenged > 0 && !direct) tips.push("Challenge completion drops when buyers must return and press Complete. Ask your provider whether the issuer can send the result directly.");
    if (challenged > 0 && !help) tips.push("Add a countdown timer and a 'did not get a push? open your app' prompt to reduce timeouts.");
    if (ex.low_value === true && merchantFraud * AVG > 0.0006 * N * AVG) tips.push("Exempted payments carry no liability shift, so exemption fraud is yours. Watch the fraud rate and be ready to stop using the exemption if it climbs.");
    out.tips = tips;
    out.grade = out.approval_rate_percent >= 92 && merchantLoss <= 0.0008 * N * AVG ? "strong" : out.approval_rate_percent >= 85 ? "fair" : "weak";
    return out;
  }

  // ---------- 4. readiness check ----------
  const READY = [
    ["version", "You use EMV 3DS version 2.2 or newer", 10, "Older versions give issuers less data and miss newer features. Plan the upgrade with your 3DS provider."],
    ["browser_data", "You send complete browser or app device data on every request", 10, "Missing device data pushes issuers to challenge more. Send the full set."],
    ["cardholder_data", "You send cardholder name, email, phone, billing and shipping address", 10, "More cardholder data means more silent approvals. Never send guesses or placeholders."],
    ["all_statuses", "Your code handles every status: Y, A, N, U, R, C, and D", 12, "Each status needs a decision: continue, stop, wait, or fall back. Do not treat unknown statuses as success."],
    ["server_verify", "You trust the issuer's result delivered to your server, not what the browser reports", 14, "A browser can be tampered with. Use the server-side result before you authorise."],
    ["pass_proof", "You pass the authentication value, ECI and directory server ID to your acquirer", 12, "Without them you get no liability shift even if the buyer authenticated."],
    ["no_retry_r", "You do not retry a rejected (R) card or keep asking after N", 6, "Retrying a rejected card looks like card testing and can harm your standing."],
    ["recurring", "You authenticate the first payment of a subscription and link later merchant-initiated payments to it", 8, "Later payments can use the merchant-initiated flow if they reference the first authenticated one."],
    ["oob_ready", "Your checkout copes with out-of-band challenges and a late return from a banking app", 8, "Handle time-outs, show a timer, and finish the order when the result arrives even if the tab was left."],
    ["responsive", "Your challenge frame or page works on small screens and with screen readers", 5, "Use the right window size, readable text and no fixed widths."],
    ["monitoring", "You track challenge rate, completion rate and abandonment by issuer", 5, "Without numbers you cannot tell which change helped."],
  ];
  function readiness(b) {
    const c = b && b.checks; if (!c || typeof c !== "object") throw bad(400, "invalid_request", "checks must be an object of check id to true or false");
    let pts = 0; const total = READY.reduce((a, r) => a + r[2], 0); const gaps = [], done = [];
    for (const [id, text, w, fix] of READY) { if (c[id] === true) { pts += w; done.push({ id, text }); } else gaps.push({ id, text, points: w, fix }); }
    gaps.sort((a, b2) => b2.points - a.points);
    const score = Math.round((pts / total) * 100);
    return { score, level: score >= 90 ? "assured" : score >= 70 ? "nearly ready" : score >= 40 ? "gaps to close" : "not ready", done, gaps, biggest_gap: gaps[0] || null };
  }

  function page() {
    const body = `<style>.k select,.k input[type=number],.k input[type=range]{width:auto;display:inline-block}.fl{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}.fl button.on{outline:2px solid var(--accent,#3b6cff)}.st{margin:6px 0;padding:8px 10px;border-left:3px solid var(--accent,#3b6cff);background:rgba(120,130,160,.07)}.st b{display:inline-block;min-width:110px}.row{display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line,#e3e7ef);flex-wrap:wrap}.row .sig{flex:1 1 280px}.row select{width:auto}.bad{color:#b3261e}.good{color:#1b7a3d}.t td,.t th{padding:5px 8px;border-bottom:1px solid var(--line,#e3e7ef);text-align:left;vertical-align:top}.chk{display:flex;gap:8px;align-items:flex-start;padding:5px 0}.chk input{margin-top:5px}</style><div class="wrap"><h1>3DS Assurance</h1>
<p class="lede">3-D Secure is how online card payments are authenticated. This lab lets you see every flow, play the issuer deciding who to challenge, run a merchant strategy and watch approval, fraud and abandonment move, then check your own integration. It is a teaching model: all numbers and transactions are invented, and you use test data only.</p>
<p class="hint" id="top"></p>
<div class="panel k"><strong>1. Flow explorer</strong><p class="hint">Pick a flow to read it step by step. Open all seven to finish this part.</p><div class="fl" id="fl"></div><div id="fb"></div></div>
<div class="panel k"><strong>2. Issuer decision desk</strong><p class="hint">You are the issuer's risk system. For each of 20 payments, choose approve silently, challenge, or decline. Approving fraud is costly, but so is annoying a genuine buyer.</p><div id="dk"></div><p><button type="button" id="dgo">Score my decisions</button> <span class="hint" id="dm"></span></p><div id="dres"></div></div>
<div class="panel k"><strong>3. Merchant strategy simulator</strong><p class="hint">10,000 orders a month at an average of 60.00. Change the settings and run it. Aim for approval of 92 percent or more with little fraud you carry yourself.</p>
<p>Data quality <input type="range" id="dq" min="0" max="100" value="40"> <b id="dqv">40</b> &nbsp; Version <select id="vr"><option>2.1</option><option selected>2.2</option><option>2.3</option></select> &nbsp; Challenge preference <select id="pf"><option value="none">let the issuer decide</option><option value="prefer">prefer a challenge</option><option value="mandate">mandate a challenge</option></select></p>
<p>Exemptions: <label><input type="checkbox" id="e_low_value"> low value</label> <label><input type="checkbox" id="e_trusted"> trusted beneficiary</label> <label><input type="checkbox" id="e_recurring"> recurring</label> <label><input type="checkbox" id="e_corporate"> secure corporate</label></p>
<p>Out of band rescue: <label><input type="checkbox" id="od"> issuer sends the result directly (no Complete button)</label> <label><input type="checkbox" id="uh"> timer and open-your-app prompt</label> <label><input type="checkbox" id="db"> device binding (version 2.3 only)</label></p>
<p><button type="button" id="sgo">Run a month</button> <span class="hint" id="sm"></span></p><div id="sres"></div></div>
<div class="panel k"><strong>4. Readiness check</strong><p class="hint">Tick what is true of your integration. You get a score and the order to fix the gaps.</p><div id="rd"></div><p><button type="button" id="rgo">Check readiness</button> <span class="hint" id="rm"></span></p><div id="rres"></div></div>
<p class="hint">Related: <a href="/knowledge/how-emv-3d-secure-works">How EMV 3-D Secure works</a>, <a href="/academy/3ds-assurance">3DS Assurance course</a>, <a href="/labs">Payment Labs</a> for live 3-D Secure test payments.</p></div>`;
    const script = `function $(i){return document.getElementById(i);}async function api(a,b,c){if(!(await Z.ensureKey()))return {status:0,body:{}};return Z.api(a,b,c);}
var F=[],TX=[],RD=[];
function bar(s){$("top").textContent=s||"";}
async function loadFlows(){var r=await api("GET","/v1/assurance/flows");if(r.status!==200){bar(Z.msg(r));return;}F=r.body.flows;$("fl").innerHTML=F.map(function(f){return '<button type="button" data-f="'+f.id+'">'+Z.esc(f.title)+(f.seen?" ✓":"")+"</button>";}).join("");}
$("fl").onclick=async function(e){var id=e.target.getAttribute&&e.target.getAttribute("data-f");if(!id)return;var r=await api("GET","/v1/assurance/flows/"+id);if(r.status!==200){bar(Z.msg(r));return;}var f=r.body;
$("fb").innerHTML="<p><b>"+Z.esc(f.title)+"</b>. "+Z.esc(f.when)+"</p>"+f.steps.map(function(s,i){return '<div class="st"><b>'+(i+1)+". "+Z.esc(s.name)+"</b> "+Z.esc(s.from)+" → "+Z.esc(s.to)+"<br>"+Z.esc(s.note)+"</div>";}).join("");loadFlows();};
async function loadDesk(){var r=await api("GET","/v1/assurance/desk");if(r.status!==200)return;TX=r.body.transactions;$("dk").innerHTML=TX.map(function(t){return '<div class="row"><span><b>#'+t.id+"</b> "+t.amount.toFixed(2)+'</span><span class="sig">'+Z.esc(t.signals)+'</span><select data-t="'+t.id+'"><option value="approve">approve</option><option value="challenge">challenge</option><option value="decline">decline</option></select></div>';}).join("");}
$("dgo").onclick=async function(){var d={};[].slice.call(document.querySelectorAll("#dk select")).forEach(function(s){d[s.getAttribute("data-t")]=s.value;});var r=await api("POST","/v1/assurance/desk/score",{decisions:d});if(r.status!==200){$("dm").textContent=Z.msg(r);return;}$("dm").textContent="";var j=r.body;
$("dres").innerHTML='<h3 class="'+(j.clean?"good":"bad")+'">Score '+j.score+" of 100</h3><p>"+Z.esc(j.summary)+'</p><table class="t"><tr><th>#</th><th>You chose</th><th>Points</th><th>What it was</th></tr>'+j.rows.map(function(x){return "<tr><td>"+x.id+"</td><td>"+x.decision+"</td><td>"+x.points+"</td><td>"+Z.esc(x.why)+"</td></tr>";}).join("")+"</table>";};
$("dq").oninput=function(){$("dqv").textContent=$("dq").value;};
$("sgo").onclick=async function(){var ex={};["low_value","trusted","recurring","corporate"].forEach(function(k){ex[k]=$("e_"+k).checked;});
var r=await api("POST","/v1/assurance/strategy",{data_quality:parseInt($("dq").value,10),version:$("vr").value,challenge_pref:$("pf").value,exemptions:ex,oob_direct:$("od").checked,ux_help:$("uh").checked,device_binding:$("db").checked});if(r.status!==200){$("sm").textContent=Z.msg(r);return;}$("sm").textContent="";var j=r.body;
$("sres").innerHTML='<h3 class="'+(j.grade==="strong"?"good":j.grade==="weak"?"bad":"")+'">Result: '+j.grade+'</h3><table class="t"><tr><td>Approval rate</td><td>'+j.approval_rate_percent+'%</td></tr><tr><td>Silent approvals (share of non-exempt)</td><td>'+j.frictionless_percent_of_rest+'%</td></tr><tr><td>Challenged</td><td>'+j.challenged+" orders, "+j.abandoned_challenges+" abandoned ("+j.abandonment_percent+'%)</td></tr><tr><td>Fraud you carry (exempted payments)</td><td>'+j.merchant_fraud_transactions+" orders, loss "+j.merchant_fraud_loss+'</td></tr><tr><td>Fraud the issuer carries</td><td>'+j.issuer_fraud_transactions+' orders</td></tr><tr><td>Sales lost to abandoned challenges</td><td>'+j.sales_lost_to_abandonment+'</td></tr><tr><td>Net margin</td><td>'+j.net_margin+" ("+j.net_margin_vs_perfect_percent+'% of the ideal)</td></tr></table>'+(j.tips.length?"<ul>"+j.tips.map(function(t){return "<li>"+Z.esc(t)+"</li>";}).join("")+"</ul>":"<p class=good>No obvious gaps.</p>");};
async function loadReady(){var r=await api("GET","/v1/assurance/readiness");if(r.status!==200)return;RD=r.body.checks;$("rd").innerHTML=RD.map(function(c){return '<label class="chk"><input type="checkbox" data-c="'+c.id+'"><span>'+Z.esc(c.text)+"</span></label>";}).join("");}
$("rgo").onclick=async function(){var c={};[].slice.call(document.querySelectorAll("#rd input")).forEach(function(x){c[x.getAttribute("data-c")]=x.checked;});var r=await api("POST","/v1/assurance/readiness",{checks:c});if(r.status!==200){$("rm").textContent=Z.msg(r);return;}$("rm").textContent="";var j=r.body;
$("rres").innerHTML='<h3 class="'+(j.score>=90?"good":j.score<40?"bad":"")+'">'+j.score+" of 100: "+Z.esc(j.level)+"</h3>"+(j.gaps.length?'<p><b>Fix in this order</b></p><ol>'+j.gaps.map(function(g){return "<li><b>"+Z.esc(g.text)+"</b> ("+g.points+" points). "+Z.esc(g.fix)+"</li>";}).join("")+"</ol>":"<p class=good>Nothing left to fix.</p>");};
if(Z.hasKey()){loadFlows();loadDesk();loadReady();}else bar("Create a test key to start.");`;
    return UI.shell({ title: "3DS Assurance lab – Zanboxx", description: "Explore every 3-D Secure flow, play the issuer, tune a merchant authentication strategy and check your readiness. Test data only.", active: "labs", body, script });
  }

  return {
    async handle(req, res, path, m) {
      if (m === "GET" && path === "/labs/3ds") { html(res, 200, page()); return true; }
      if (!path.startsWith("/v1/assurance")) return false;
      const acc = ctx.authed(req), t = st(acc);
      let g;
      if (m === "GET" && path === "/v1/assurance/flows") { send(res, 200, { flows: FLOWS.map((f) => ({ id: f.id, title: f.title, when: f.when, seen: !!t.flows[f.id] })) }); return true; }
      if (m === "GET" && (g = path.match(/^\/v1\/assurance\/flows\/([a-z0-9-]+)$/))) {
        const f = FLOWS.find((x) => x.id === g[1]); if (!f) throw bad(404, "not_found", "No such flow");
        t.flows[f.id] = true; t.did.flow_any = true; if (FLOWS.every((x) => t.flows[x.id])) t.did.flows_all = true; if (f.id === "decoupled") t.did.saw_decoupled = true; if (f.id === "oob-mobile-browser") t.did.saw_oob_weak = true;
        save(acc); send(res, 200, { id: f.id, title: f.title, when: f.when, steps: f.steps.map((s) => ({ from: s[0], to: s[1], name: s[2], note: s[3] })) }); return true;
      }
      if (m === "GET" && path === "/v1/assurance/desk") { send(res, 200, { transactions: TX.map((x) => ({ id: x.id, amount: x.amt, signals: x.sig })), choices: CH }); return true; }
      if (m === "POST" && path === "/v1/assurance/desk/score") {
        const r = scoreDesk(await readBody(req)); t.did.desk_done = true; if (r.clean) t.did.desk_clean = true; if (r.score >= 95) t.did.desk_top = true;
        if (r.fraud_approved === 0) t.did.desk_no_fraud = true; t.desk = { score: Math.max(r.score, t.desk ? t.desk.score : 0) }; save(acc); send(res, 200, r); return true;
      }
      if (m === "POST" && path === "/v1/assurance/strategy") {
        const b = await readBody(req), r = strategy(b); t.did.strategy_run = true; if (r.grade === "strong") t.did.strategy_strong = true; if (b.oob_direct === true) t.did.oob_direct = true;
        if (b.exemptions && b.exemptions.low_value === true) t.did.used_exemption = true; if (b.challenge_pref === "mandate") t.did.tried_mandate = true;
        save(acc); send(res, 200, r); return true;
      }
      if (m === "GET" && path === "/v1/assurance/readiness") { send(res, 200, { checks: READY.map((r) => ({ id: r[0], text: r[1] })) }); return true; }
      if (m === "POST" && path === "/v1/assurance/readiness") {
        const r = readiness(await readBody(req)); t.did.readiness_done = true; if (r.score >= 90) t.did.readiness_full = true; save(acc); send(res, 200, r); return true;
      }
      return false;
    },
  };
};
