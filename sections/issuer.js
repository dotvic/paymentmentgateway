"use strict";
// Wallet provisioning lab, issuer's view: decide on token requests (approve, step up, decline), run the activation
// code step, and see what the issuer receives at payment time. Simulated; test data only; teaching model, not a real network.
module.exports = function ({ html, ctx, UI, esc }) {
  const { send, bad, readBody, save } = ctx;
  const METHODS = { 1: "Masked mobile number (text)", 2: "Masked email address", 3: "Automated call", 4: "Call centre", 5: "Website", 6: "Banking app", 7: "Voice call" };
  const TEST_CODE = "123456", MAX_ATTEMPTS = 3;
  // expected: approve | step_up | decline. Signals are what the wallet provider and the customer supplied.
  const SCEN = [
    { id: "s1", title: "Long-time customer adds a card to their usual phone", wallet: "Wallet A", device: "Phone", device_score: 5, account_score: 5, location_matches: true, tokens_on_card: 1, security_code: "match", address: "match", expected: "approve", why: "Strong device and account signals, location matches, nothing unusual: let it through without friction." },
    { id: "s2", title: "New wallet account, trusted device", wallet: "Wallet A", device: "Phone", device_score: 4, account_score: 2, location_matches: true, tokens_on_card: 1, security_code: "match", address: "match", expected: "step_up", why: "The account is young, so confirm the real cardholder with an activation code sent to a contact you already hold." },
    { id: "s3", title: "Eight tokens requested on one card in a day", wallet: "Wallet B", device: "Phone", device_score: 4, account_score: 5, location_matches: true, tokens_on_card: 8, security_code: "match", address: "match", expected: "step_up", why: "Good scores but an unusual number of tokens on one card. Verify before adding another." },
    { id: "s4", title: "Address does not match, everything else clean", wallet: "Wallet A", device: "Watch", device_score: 5, account_score: 4, location_matches: true, tokens_on_card: 2, security_code: "match", address: "mismatch", expected: "step_up", why: "One weak signal alone is a reason to verify, not to refuse. A recent move is common." },
    { id: "s5", title: "New device abroad, wrong security code", wallet: "Wallet B", device: "Phone", device_score: 1, account_score: 1, location_matches: false, tokens_on_card: 6, security_code: "mismatch", address: "mismatch", expected: "decline", why: "Weak device and account, far from the cardholder, wrong code and address, many tokens. Several signals agree: decline." },
    { id: "s6", title: "Low scores but the cardholder is travelling", wallet: "Wallet A", device: "Phone", device_score: 2, account_score: 5, location_matches: false, tokens_on_card: 1, security_code: "match", address: "match", expected: "step_up", why: "Location and device are weak, but the account and the card details are strong. Verify instead of refusing a travelling customer." },
  ];
  const pubScen = (s) => { const { expected, why, ...r } = s; return r; };
  const st = (acc) => (acc.issuer = acc.issuer || { answers: {}, act: null, completed: 0, locked: 0 });
  const PAYMENT_VIEW = {
    acquirer_sends: ["Token number instead of the card number", "Token expiry date", "How the card was read (contactless chip, contactless stripe, in-app)", "Chip data (for contactless chip and in-app)"],
    token_service_does: ["Maps the token back to the real card number", "Checks only the token's expiry", "Checks the transaction counter", "Validates the cryptogram (the chip data is not forwarded to the issuer)", "Checks the dynamic code for contactless stripe-style payments"],
    issuer_receives: ["The real card number and its expiry", "The wallet identifier", "Flags: a token was used, the token service converted it, and the cryptogram was valid", "The token number and its expiry, for reference"],
    issuer_does_not_receive: ["Chip data", "Track data", "Card sequence number"],
    issuer_still_must: ["Check the real card's expiry", "Check the card's standing (blocked, limits, funds)", "Approve or decline"],
    clearing: "In clearing the issuer sees the real number again, a marker that a token was used, the assurance level and which party requested the token. Retrievals and chargebacks use the real number.",
  };

  function page() {
    const body = `<style>.k select,.k input{width:auto;display:inline-block}.sc{border-left:4px solid #3b82f6;padding-left:12px;margin:10px 0}</style><div class="crumbs"><a href="/labs">Payment Labs</a> / Wallet provisioning, issuer view</div><h1>Wallet provisioning: the issuer's view</h1>
<p class="lede">When someone adds a card to a phone wallet, the issuer is asked to decide: <strong>approve</strong> (green path), <strong>approve but verify first</strong> (yellow path) or <strong>decline</strong> (red path). You get the wallet's risk signals and the details the customer typed. Decide, then see what a sensible issuer would do. Test data only.</p>
<div class="panel k"><strong>1. Decide on each request</strong><div id="sc"></div><p id="sm" class="hint"></p></div>
<div class="panel k"><strong>2. The yellow path: activation code</strong><p>Start a verification, then enter the code. The test code is <code>123456</code>. Three wrong entries deactivate the token.</p>
<p><select id="am"></select> <button type="button" id="as" class="small">Send activation code</button> Code <input id="ac" size="6"> <button type="button" id="ae" class="small">Enter code</button></p><p id="am2" class="hint"></p></div>
<div class="panel"><strong>3. A payment with a token: who sees what</strong><div id="pv"></div></div>
<h2>What to notice</h2><ul><li>One weak signal calls for verification, not refusal. Several signals that agree call for a decline.</li><li>The activation method matters: use a contact you already hold, never one typed in the request.</li><li>At payment time the token service does the cryptogram work and the issuer still decides on the real card.</li></ul>
<p class="hint">Related: <a href="/knowledge/wallet-provisioning-issuer-view">Wallet provisioning guide</a>, <a href="/academy/tokenization">Tokenization course</a>, <a href="/labs/tokens">Tokenization lab</a>.</p>`;
    const script = `var M=${JSON.stringify(METHODS)};function $(i){return document.getElementById(i);}
$("am").innerHTML=Object.keys(M).map(function(k){return '<option value="'+k+'">'+Z.esc(M[k])+'</option>';}).join("");
function card(s,a){var h='<div class="sc"><strong>'+Z.esc(s.title)+'</strong><br><span class="hint">'+Z.esc(s.wallet)+' · '+Z.esc(s.device)+' · device score '+s.device_score+'/5 · account score '+s.account_score+'/5 · location '+(s.location_matches?"matches":"does not match")+' · tokens on card '+s.tokens_on_card+' · security code '+s.security_code+' · address '+s.address+'</span><br>';
if(a){h+='<em>'+(a.correct?"Good call. ":"Not quite. ")+'You chose '+Z.esc(a.decision.replace("_"," "))+'; expected '+Z.esc(a.expected.replace("_"," "))+'.</em> '+Z.esc(a.why);}
else h+='<button type="button" class="small" data-d="approve" data-s="'+s.id+'">Approve</button> <button type="button" class="small" data-d="step_up" data-s="'+s.id+'">Approve, verify first</button> <button type="button" class="small" data-d="decline" data-s="'+s.id+'">Decline</button>';
return h+'</div>';}
async function load(){if(!(await Z.ensureKey()))return;var r=await Z.api("GET","/v1/issuer");if(r.status!==200){$("sm").textContent=Z.msg(r);return;}$("sc").innerHTML=r.body.scenarios.map(function(s){return card(s,r.body.answers[s.id]);}).join("");$("sm").textContent=Object.keys(r.body.answers).length+" of "+r.body.scenarios.length+" decided";}
$("sc").onclick=async function(e){var b=e.target.closest("button[data-d]");if(!b)return;var r=await Z.api("POST","/v1/issuer/decide",{scenario:b.dataset.s,decision:b.dataset.d,method:+$("am").value});if(r.status!==200){$("sm").textContent=Z.msg(r);return;}load();};
$("as").onclick=async function(){var r=await Z.api("POST","/v1/issuer/activation/start",{method:+$("am").value});$("am2").textContent=r.status===200?"Code sent via "+r.body.method+". Enter it below.":Z.msg(r);};
$("ae").onclick=async function(){var r=await Z.api("POST","/v1/issuer/activation/enter",{code:$("ac").value});$("am2").textContent=r.status===200?(r.body.event+": "+r.body.detail):Z.msg(r);};
(async function(){var r=await fetch("/v1/issuer/payment-view");var p=await r.json();function ul(a){return "<ul>"+a.map(function(x){return "<li>"+Z.esc(x)+"</li>";}).join("")+"</ul>";}
$("pv").innerHTML="<p><b>The acquirer sends</b></p>"+ul(p.acquirer_sends)+"<p><b>The token service does for the issuer</b></p>"+ul(p.token_service_does)+"<p><b>The issuer receives</b></p>"+ul(p.issuer_receives)+"<p><b>The issuer does not receive</b></p>"+ul(p.issuer_does_not_receive)+"<p><b>The issuer still must</b></p>"+ul(p.issuer_still_must)+"<p class=hint>"+Z.esc(p.clearing)+"</p>";})();
if(Z.hasKey())load();else $("sm").textContent="Create a test key to start.";`;
    return UI.shell({ title: "Wallet provisioning, issuer view – Zanboxx", description: "Play the issuer: approve, verify or decline wallet token requests, run the activation step and see what the issuer receives at payment time.", active: "labs", body, script });
  }

  return {
    async handle(req, res, path, m) {
      if (m === "GET" && path === "/labs/issuer") { html(res, 200, page()); return true; }
      if (m === "GET" && path === "/v1/issuer/payment-view") { send(res, 200, PAYMENT_VIEW); return true; }
      if (!path.startsWith("/v1/issuer")) return false;
      const acc = ctx.authed(req), s = st(acc);
      if (m === "GET" && path === "/v1/issuer") { send(res, 200, { scenarios: SCEN.map(pubScen), answers: s.answers, methods: METHODS }); return true; }
      if (m === "POST" && path === "/v1/issuer/decide") {
        const b = await readBody(req), sc = SCEN.find((x) => x.id === b.scenario);
        if (!sc) throw bad(400, "invalid_request", "Unknown scenario");
        if (!["approve", "step_up", "decline"].includes(b.decision)) throw bad(400, "invalid_request", "decision must be approve, step_up or decline");
        if (b.decision === "step_up" && !METHODS[b.method]) throw bad(400, "invalid_request", "Pick an activation method (1 to 7) when verifying first");
        if (s.answers[sc.id]) throw bad(409, "already_decided", "You already decided this one");
        s.answers[sc.id] = { decision: b.decision, expected: sc.expected, correct: b.decision === sc.expected, why: sc.why, method: b.decision === "step_up" ? b.method : undefined };
        save(acc); send(res, 200, s.answers[sc.id]); return true;
      }
      if (m === "POST" && path === "/v1/issuer/activation/start") {
        const b = await readBody(req); if (!METHODS[b.method]) throw bad(400, "invalid_request", "method must be 1 to 7");
        s.act = { method: b.method, attempts: 0, state: "pending" }; save(acc);
        send(res, 200, { method: METHODS[b.method], note: "Test code is " + TEST_CODE }); return true;
      }
      if (m === "POST" && path === "/v1/issuer/activation/enter") {
        const b = await readBody(req);
        if (!s.act || s.act.state !== "pending") throw bad(409, "no_pending_activation", "Send an activation code first");
        if (String(b.code) === TEST_CODE) { s.act.state = "complete"; s.completed++; save(acc); send(res, 200, { event: "tokenization_complete", detail: "Token active. It expires in three years unless renewed." }); return true; }
        s.act.attempts++;
        if (s.act.attempts >= MAX_ATTEMPTS) { s.act.state = "deactivated"; s.locked++; save(acc); send(res, 200, { event: "token_deactivated", detail: "Activation code retries exceeded. The token is deactivated; start again." }); return true; }
        save(acc); send(res, 200, { event: "activation_code_incorrect", detail: `Wrong code entered (${s.act.attempts} of ${MAX_ATTEMPTS}).` }); return true;
      }
      return false;
    },
  };
};
