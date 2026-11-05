"use strict";
// Tokenization lab: simulated network tokens with a lifecycle, domain controls and single-use cryptograms. Test cards only; nothing real.
module.exports = function ({ html, ctx, UI, esc }) {
  const crypto = require("crypto"), SCH = require("../schemes");
  const { send, bad, readBody, rnd, save } = ctx;
  const TEST = new Map(SCH.TEST_CARDS.map((c) => [c.number, c]));
  const MAX_TOKENS = 8, MAX_AUDIT = 50, CRYPTO_TTL = 5 * 60e3, SECRET = crypto.randomBytes(16);
  const stats = (acc) => (acc.tok = acc.tok || { provisioned: 0, activated: 0, paid: 0, domain_blocked: 0, replay_blocked: 0, state_blocked: 0, reissued: 0 });
  const audit = (t, event, detail) => { t.audit.unshift({ at: new Date().toISOString(), event, detail: detail || "" }); if (t.audit.length > MAX_AUDIT) t.audit.length = MAX_AUDIT; };
  const pub = (t) => ({ id: t.id, token: t.token, state: t.state, requestor: t.requestor, domain: t.domain, card: { scheme: t.scheme, last4: t.last4 }, expires: t.expires, created_at: t.created_at });
  const find = (acc, id) => { const t = (acc.tokens || []).find((x) => x.id === id); if (!t) throw bad(404, "not_found", "No such token"); return t; };
  const tokenNumber = () => "9" + String(crypto.randomBytes(8).readBigUInt64BE() % 10n ** 15n).padStart(15, "0"); // starts with 9: not a real card network range

  function page() {
    const opts = SCH.TEST_CARDS.filter((c) => /approv|succe/i.test(c.outcome || c.label || "")).slice(0, 6).map((c) => `<option value="${esc(c.number)}">${esc(c.scheme)} ${esc(c.number.slice(-4))}</option>`).join("") || '<option value="4111111111111111">visa 1111</option>';
    const body = `<style>.k select,.k input{width:auto;display:inline-block}</style><div class="crumbs"><a href="/labs">Payment Labs</a> / Tokenization</div><h1>Tokenization lab</h1>
<p class="lede">A <strong>token</strong> stands in for a card number. A network token is tied to one wallet or merchant, can be suspended or deleted without cancelling the card, and each payment carries a one-time cryptogram. So a stolen token is far less useful than a stolen card number. This lab simulates that with test cards only.</p>
<div class="panel k"><strong>1. Provision a token</strong><p>Test card <select id="pan">${opts}</select> Requestor <select id="req"><option>wallet</option><option>merchant</option></select> Allowed channel <select id="chn"><option>online</option><option>pos</option><option>any</option></select> Merchant ID <input id="mid" size="10" value="shop-1"> <button class="primary" type="button" id="mk">Provision</button></p>
<p id="tk" class="hint">No token yet.</p><p>Verification code <input id="otp" size="6" placeholder="123456"> <button type="button" id="act" class="small">Activate</button> <span class="hint">test code: 123456</span></p></div>
<div class="panel k"><strong>2. Pay with the token</strong><p>Amount <input id="am" size="6" value="25"> Merchant ID <input id="pm" size="10" value="shop-1"> Channel <select id="pc"><option>online</option><option>pos</option></select> <label><input type="checkbox" id="reuse"> reuse the previous cryptogram</label> <button type="button" class="primary" id="pay">Pay</button></p><p id="res" class="hint"></p>
<p class="hint">Try paying from a different merchant ID, reusing a cryptogram, or paying while the token is suspended.</p></div>
<div class="panel"><strong>3. Lifecycle</strong><p><button type="button" id="sus" class="small">Suspend</button> <button type="button" id="rsm" class="small">Resume</button> <button type="button" id="rei" class="small">Card reissued (new last 4)</button> <button type="button" id="del" class="small">Delete token</button></p><div id="log" class="hint">Nothing yet.</div></div>
<h2>What to notice</h2><ul><li>The merchant stores the token, never the card number.</li><li>The token only works in its domain: the requestor, merchant and channel it was issued for.</li><li>Each payment needs a fresh cryptogram, so recording one and replaying it fails.</li><li>When the card is reissued, the token keeps working. With stored card numbers every merchant would need new details.</li></ul>
<p class="hint">Related: <a href="/knowledge/tokenization">Tokenization guide</a>, <a href="/academy/tokenization">Tokenization course</a>.</p>`;
    const script = `var tok=null,last=null;function $(i){return document.getElementById(i);}
function show(){$("tk").textContent=tok?tok.id+" · "+tok.token+" · "+tok.state+" · card ••"+tok.card.last4+" · "+tok.domain.channel+" / "+(tok.domain.merchant_id||"any merchant"):"No token yet.";}
async function refresh(){if(!tok)return;var r=await Z.api("GET","/v1/tokens/"+tok.id);if(r.status===200){tok=r.body.token;show();$("log").innerHTML=r.body.audit.slice(0,12).map(function(a){return "<div>"+Z.esc(a.at.slice(11,19))+" · <strong>"+Z.esc(a.event)+"</strong> "+Z.esc(a.detail)+"</div>";}).join("")||"Nothing yet.";}}
(async function(){if(Z.hasKey()){var r=await Z.api("GET","/v1/tokens");if(r.status===200&&r.body.data.length){tok=r.body.data[0];show();refresh();}}})();
$("mk").onclick=async function(){if(!(await Z.ensureKey()))return;var r=await Z.api("POST","/v1/tokens",{card_number:$("pan").value,requestor:$("req").value,domain:{channel:$("chn").value,merchant_id:$("mid").value}});if(r.status===201){tok=r.body.token;last=null;show();refresh();}else $("tk").textContent=Z.msg(r);};
$("act").onclick=async function(){if(!tok)return;var r=await Z.api("POST","/v1/tokens/"+tok.id+"/activate",{code:$("otp").value});$("res").textContent=r.status===200?"Token activated.":Z.msg(r);refresh();};
async function act(a){if(!tok)return;var r=await Z.api("POST","/v1/tokens/"+tok.id+"/"+a);$("res").textContent=r.status===200?"Done: "+a:Z.msg(r);refresh();}
$("sus").onclick=function(){act("suspend");};$("rsm").onclick=function(){act("resume");};$("del").onclick=function(){act("delete");};$("rei").onclick=function(){act("card-update");};
$("pay").onclick=async function(){if(!tok){$("res").textContent="Provision a token first.";return;}var amount=+$("am").value,c;
if($("reuse").checked&&last){c=last;}else{var cr=await Z.api("POST","/v1/tokens/"+tok.id+"/cryptogram",{amount:amount,merchant_id:$("pm").value});if(cr.status!==200){$("res").textContent=Z.msg(cr);refresh();return;}c=cr.body.cryptogram;}
last=c;var r=await Z.api("POST","/v1/tokens/"+tok.id+"/pay",{amount:amount,merchant_id:$("pm").value,channel:$("pc").value,cryptogram:c});
$("res").textContent=r.status===200?(r.body.approved?"Approved "+r.body.amount+" on card ••"+r.body.card_last4:"Declined: "+r.body.reason_code+" - "+r.body.reason):Z.msg(r);refresh();};`;
    return UI.shell({ title: "Tokenization lab – Zanboxx", description: "Provision, use, suspend and delete a simulated network token with domain controls and cryptograms.", active: "labs", body, script });
  }

  return {
    async handle(req, res, path, m) {
      if (m === "GET" && path === "/labs/tokens") { html(res, 200, page()); return true; }
      if (!path.startsWith("/v1/tokens")) return false;
      const acc = ctx.authed(req); acc.tokens = acc.tokens || []; let mt;
      if (m === "GET" && path === "/v1/tokens") { send(res, 200, { data: acc.tokens.map(pub) }); return true; }
      if (m === "POST" && path === "/v1/tokens") {
        const b = (await readBody(req)) || {}, n = String(b.card_number || "").replace(/\s/g, "");
        if (!TEST.has(n)) throw bad(400, "test_card_only", "Only Zanboxx test cards can be tokenized here. Never enter a real card number.");
        if (acc.tokens.filter((t) => t.state !== "deleted").length >= MAX_TOKENS) throw bad(409, "limit", `At most ${MAX_TOKENS} active tokens per account`);
        const req2 = b.requestor === "merchant" ? "merchant" : b.requestor === "wallet" || b.requestor === undefined ? "wallet" : (() => { throw bad(400, "invalid_request", "requestor must be wallet or merchant"); })();
        const d = b.domain || {}, channel = ["online", "pos", "any"].includes(d.channel) ? d.channel : (d.channel === undefined ? "any" : (() => { throw bad(400, "invalid_request", "domain.channel must be online, pos or any"); })());
        const mid = d.merchant_id === undefined || d.merchant_id === "" ? null : String(d.merchant_id);
        if (mid !== null && !/^[A-Za-z0-9_-]{1,32}$/.test(mid)) throw bad(400, "invalid_request", "domain.merchant_id must be 1 to 32 letters, digits, - or _");
        const c = TEST.get(n), exp = new Date(Date.now() + 3 * 365 * 864e5);
        const t = { id: "tok_" + rnd(6), token: tokenNumber(), state: "pending_activation", requestor: req2, domain: { channel, merchant_id: mid }, scheme: c.scheme, last4: n.slice(-4), expires: `${String(exp.getUTCMonth() + 1).padStart(2, "0")}/${exp.getUTCFullYear()}`, counter: 0, cryptograms: [], audit: [], created_at: new Date().toISOString() };
        audit(t, "token.provisioned", `${req2}, ${channel}, ${mid || "any merchant"}`); acc.tokens.push(t); stats(acc).provisioned++; save(acc); send(res, 201, { token: pub(t) }); return true;
      }
      if (!(mt = path.match(/^\/v1\/tokens\/(tok_[a-f0-9]+)(?:\/(activate|suspend|resume|delete|card-update|cryptogram|pay))?$/))) return false;
      const t = find(acc, mt[1]), what = mt[2], st = stats(acc);
      if (m === "GET" && !what) { send(res, 200, { token: pub(t), audit: t.audit.slice(0, 20) }); return true; }
      if (m !== "POST") return false;
      if (what === "activate") {
        if (t.state !== "pending_activation") throw bad(409, "invalid_state", `Token is ${t.state}`);
        const b = (await readBody(req)) || {}; if (String(b.code) !== "123456") { audit(t, "token.activation.failed"); save(acc); throw bad(400, "wrong_code", "Wrong verification code. In this lab the test code is 123456."); }
        t.state = "active"; st.activated++; audit(t, "token.activated", "identity verified (simulated)"); save(acc); send(res, 200, { token: pub(t) }); return true;
      }
      if (t.state === "deleted") throw bad(409, "invalid_state", "Token is deleted");
      if (what === "suspend" || what === "resume") {
        const want = what === "suspend" ? "suspended" : "active", from = what === "suspend" ? "active" : "suspended";
        if (t.state !== from) throw bad(409, "invalid_state", `Token is ${t.state}`);
        t.state = want; audit(t, "token." + what); save(acc); send(res, 200, { token: pub(t) }); return true;
      }
      if (what === "delete") { t.state = "deleted"; t.cryptograms = []; audit(t, "token.deleted"); save(acc); send(res, 200, { token: pub(t) }); return true; }
      if (what === "card-update") {
        t.last4 = String(1000 + (crypto.randomBytes(2).readUInt16BE() % 9000)); st.reissued++; audit(t, "card.reissued", `new last 4 ${t.last4}; the token number did not change`); save(acc); send(res, 200, { token: pub(t) }); return true;
      }
      const b = (await readBody(req)) || {}, amount = Number(b.amount);
      if (!(amount > 0 && amount <= 100000)) throw bad(400, "invalid_request", "amount must be greater than 0");
      if (what === "cryptogram") {
        if (t.state !== "active") throw bad(409, "invalid_state", `Token is ${t.state}`);
        const mid = String(b.merchant_id || ""); t.counter++;
        const value = crypto.createHmac("sha256", SECRET).update(`${t.id}|${t.counter}|${amount}|${mid}`).digest("hex").slice(0, 16).toUpperCase();
        t.cryptograms = t.cryptograms.filter((c) => Date.now() - c.at < CRYPTO_TTL).slice(-9); t.cryptograms.push({ value, amount, at: Date.now(), used: false });
        save(acc); send(res, 200, { cryptogram: value, expires_in_s: CRYPTO_TTL / 1000, single_use: true }); return true;
      }
      if (what === "pay") {
        const mid = String(b.merchant_id || ""), channel = String(b.channel || "online"), decl = (code, why, counter) => { if (counter) st[counter]++; audit(t, "payment.declined", `${code}`); save(acc); send(res, 200, { approved: false, reason_code: code, reason: why, amount }); return true; };
        if (t.state !== "active") return decl("TOKEN_" + t.state.toUpperCase(), `The token is ${t.state.replace("_", " ")}`, "state_blocked");
        if (t.domain.channel !== "any" && t.domain.channel !== channel) return decl("DOMAIN_CHANNEL", `This token is limited to ${t.domain.channel} payments`, "domain_blocked");
        if (t.domain.merchant_id && t.domain.merchant_id !== mid) return decl("DOMAIN_MERCHANT", "This token was issued for a different merchant", "domain_blocked");
        const cg = t.cryptograms.find((c) => c.value === String(b.cryptogram || ""));
        if (!cg || Date.now() - cg.at > CRYPTO_TTL) return decl("CRYPTOGRAM_INVALID", "Missing, unknown or expired cryptogram");
        if (cg.used) return decl("CRYPTOGRAM_REUSED", "This cryptogram was already used. Each payment needs a new one", "replay_blocked");
        if (cg.amount !== amount) return decl("CRYPTOGRAM_AMOUNT", "The cryptogram was created for a different amount");
        cg.used = true; st.paid++; audit(t, "payment.approved", `${amount} at ${mid || "?"} via ${channel}`); save(acc);
        send(res, 200, { approved: true, amount, card_last4: t.last4, scheme: t.scheme }); return true;
      }
      return false;
    },
  };
};
