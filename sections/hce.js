"use strict";
// Cloud payments lab: a simulated phone wallet that pays with batches of limited-use keys (host card emulation style).
// A simulated device is provisioned after an identity check, holds a small batch of keys, makes one-time cryptograms, and the lab shows
// replay, cloned-device, over-limit, exhausted-keys and suspended-token cases. All keys and values are invented; no real card data.

module.exports = function ({ html, ctx, UI, esc }) {
  const crypto = require("crypto");
  const { send, bad, readBody, save } = ctx;
  const BATCH = 3, USES = 2, STEP_UP = 100, HARD_CAP = 1000, MAX_LOG = 14;
  const st = (acc) => (acc.hce = acc.hce || { dev: null, did: {}, log: [] });
  const log = (t, ev, detail) => { t.log.unshift({ at: new Date().toISOString().slice(11, 19), ev, detail: detail || "" }); if (t.log.length > MAX_LOG) t.log.length = MAX_LOG; };
  const mkBatch = () => Array.from({ length: BATCH }, () => ({ k: crypto.randomBytes(16).toString("hex"), left: USES }));
  const cg = (key, counter, amount, merchant) => crypto.createHmac("sha256", key).update(`${counter}|${amount}|${merchant}`).digest("hex").slice(0, 12).toUpperCase();
  const view = (d) => d && { id: d.id, name: d.name, state: d.state, fingerprint: d.fp.slice(0, 8), keys_left: d.keys.reduce((s, k) => s + k.left, 0), batches: d.batches, counter: d.counter, step_up_over: STEP_UP };
  const risk = (v) => (["green", "yellow", "red"].includes(v) ? v : "green");

  function page() {
    const body = `<style>.k select,.k input{width:auto;display:inline-block}.t td,.t th{padding:5px 8px;border-bottom:1px solid var(--line,#e3e7ef);text-align:left;vertical-align:top}.good{color:#1b7a3d}.bad{color:#b3261e}.mono{font-family:ui-monospace,Menlo,monospace;overflow-wrap:anywhere}</style>
<div class="crumbs"><a href="/labs">Payment Labs</a> / Cloud payments</div><h1>Cloud payments lab</h1>
<p class="lede">A phone wallet without a secure chip holds a small batch of <strong>limited-use keys</strong> and asks a server for more. Each key makes a few one-time payment codes, so a copied key is worth little. This lab simulates the device and the server with invented values.</p>
<div class="panel k"><strong>1. Add a card to the phone</strong><p>The wallet's identity check result <select id="rk"><option value="green">green: confident</option><option value="yellow">yellow: needs a code</option><option value="red">red: refuse</option></select> Phone name <input id="nm" size="12" value="my phone"> <button class="primary" type="button" id="pv">Provision</button> <span id="pm" class="hint"></span></p>
<p id="stp" hidden>Enter the activation code (test code 123456) <input id="cd" size="8" value="123456"> <button type="button" id="vf">Verify</button></p></div>
<div class="panel k"><strong>2. The device</strong><div id="dev" class="hint">No device yet.</div>
<p>Amount <input id="am" size="6" value="25"> Merchant <input id="mc" size="10" value="cafe-1"> <label><input type="checkbox" id="vu"> phone unlocked and verified</label></p>
<p><button class="primary" type="button" id="pay">Tap to pay</button> <button type="button" id="rp">Replay the last payment</button> <button type="button" id="cl">Pay from a cloned phone</button> <button type="button" id="rf">Ask server for new keys</button> <button type="button" id="sp">Suspend</button> <button type="button" id="rs">Resume</button></p>
<div id="res" class="hint"></div></div>
<div class="panel"><strong>3. Event log</strong><div id="lg" class="hint">Nothing yet.</div></div>
<p class="hint">Related: <a href="/academy/courses/mobile-wallets-hce">Mobile wallets and HCE course</a>, <a href="/labs/tokens">Tokenization lab</a>, <a href="/labs">Payment Labs</a>.</p></div>`;
    const script = `function $(i){return document.getElementById(i);}async function call(a,b,c){if(!(await Z.ensureKey()))return {status:0,body:{}};return Z.api(a,b,c);}
function show(d){$('dev').innerHTML=d?'<strong>'+Z.esc(d.name)+'</strong> · state '+Z.esc(d.state)+' · fingerprint <span class="mono">'+Z.esc(d.fingerprint)+'</span> · keys left '+d.keys_left+' · payments so far '+d.counter+' · key batches '+d.batches+' · ask for a code above '+d.step_up_over:'No device yet.';}
function logs(l){$('lg').innerHTML=l&&l.length?l.map(function(x){return '<div>'+Z.esc(x.at)+' · <strong>'+Z.esc(x.ev)+'</strong> '+Z.esc(x.detail)+'</div>';}).join(''):'Nothing yet.';}
async function refresh(){var r=await call('GET','/v1/hce');if(r.status===200){show(r.body.device);logs(r.body.log);}}
function out(r){if(r.status!==200){$('res').textContent=Z.msg(r);return;}var b=r.body;$('res').innerHTML=b.approved?'<span class="good">Approved</span> '+Z.esc(b.amount)+' · code <span class="mono">'+Z.esc(b.cryptogram)+'</span> · counter '+b.counter:'<span class="bad">Declined</span>: '+Z.esc(b.reason_code)+' - '+Z.esc(b.reason);refresh();}
$('pv').onclick=async function(){var r=await call('POST','/v1/hce/provision',{identity_check:$('rk').value,name:$('nm').value});if(r.status!==200&&r.status!==201){$('pm').textContent=Z.msg(r);return;}$('pm').textContent=r.body.message;$('stp').hidden=r.body.status!=='step_up_required';refresh();};
$('vf').onclick=async function(){var r=await call('POST','/v1/hce/verify',{code:$('cd').value});$('pm').textContent=r.status===200?r.body.message:Z.msg(r);if(r.status===200)$('stp').hidden=true;refresh();};
$('pay').onclick=async function(){out(await call('POST','/v1/hce/pay',{amount:Number($('am').value),merchant:$('mc').value,verified:$('vu').checked}));};
$('rp').onclick=async function(){out(await call('POST','/v1/hce/pay',{replay:true,merchant:$('mc').value}));};
$('cl').onclick=async function(){out(await call('POST','/v1/hce/pay',{amount:Number($('am').value),merchant:$('mc').value,verified:$('vu').checked,clone:true}));};
$('rf').onclick=async function(){var r=await call('POST','/v1/hce/replenish');$('res').textContent=r.status===200?r.body.message:Z.msg(r);refresh();};
$('sp').onclick=async function(){var r=await call('POST','/v1/hce/suspend');$('res').textContent=r.status===200?r.body.message:Z.msg(r);refresh();};
$('rs').onclick=async function(){var r=await call('POST','/v1/hce/resume');$('res').textContent=r.status===200?r.body.message:Z.msg(r);refresh();};
if(Z.hasKey())refresh();`;
    return UI.shell({ title: "Cloud payments lab – Zanboxx", description: "Simulate a phone wallet that pays with limited-use keys: provisioning, one-time codes, replay and clone checks, key refills and suspension.", active: "labs", body, script });
  }

  return {
    async handle(req, res, path, m) {
      if (m === "GET" && path === "/labs/hce") { html(res, 200, page()); return true; }
      if (!path.startsWith("/v1/hce")) return false;
      const acc = ctx.authed(req), t = st(acc), d = t.dev;
      if (m === "GET" && path === "/v1/hce") { send(res, 200, { device: view(d), log: t.log, did: t.did }); return true; }
      if (m === "POST" && path === "/v1/hce/provision") {
        const b = await readBody(req), rk = risk(b.identity_check); if (b.identity_check !== undefined && rk !== b.identity_check) throw bad(400, "invalid_request", "identity_check must be green, yellow or red");
        const name = String(b.name || "phone").slice(0, 24);
        if (rk === "red") { t.did.prov_decline = true; log(t, "provision.declined", "identity check red"); save(acc); send(res, 200, { status: "declined", message: "The issuer refused: the identity check was too weak." }); return true; }
        t.dev = { id: "dev_" + crypto.randomBytes(4).toString("hex"), name, fp: crypto.randomBytes(16).toString("hex"), state: rk === "yellow" ? "pending" : "active", keys: [], batches: 0, counter: 0, last: null, highest: 0 };
        if (rk === "green") { t.dev.keys = mkBatch(); t.dev.batches = 1; t.did.prov_green = true; log(t, "provision.active", "no step-up needed, first key batch loaded"); }
        else log(t, "provision.pending", "activation code required");
        save(acc); send(res, 201, { status: rk === "green" ? "active" : "step_up_required", message: rk === "green" ? "Active. The device holds " + BATCH + " keys." : "Pending: ask the cardholder for the activation code sent to the contact the issuer holds." }); return true;
      }
      if (!d) throw bad(409, "no_device", "Provision a device first");
      if (m === "POST" && path === "/v1/hce/verify") {
        const b = await readBody(req); if (d.state !== "pending") throw bad(409, "not_pending", "The device is not waiting for a code");
        if (String(b.code) !== "123456") { log(t, "verify.failed", "wrong code"); save(acc); throw bad(400, "wrong_code", "That code is wrong. The test code is 123456."); }
        d.state = "active"; d.keys = mkBatch(); d.batches = 1; t.did.prov_stepup = true; log(t, "verify.ok", "activated, first key batch loaded"); save(acc); send(res, 200, { message: "Code accepted. The device is active." }); return true;
      }
      if (m === "POST" && path === "/v1/hce/pay") {
        const b = await readBody(req); const merchant = String(b.merchant || "shop").slice(0, 24);
        const dec = (code, reason) => { log(t, "payment.declined", code); save(acc); send(res, 200, { approved: false, reason_code: code, reason }); return true; };
        if (d.state === "pending") return dec("not_active", "The card is not active yet.");
        if (d.state !== "active") return dec("token_suspended", "The issuer or cardholder suspended this token.");
        if (b.replay) {
          if (!d.last) return dec("nothing_to_replay", "Make a payment first.");
          if (d.last.counter <= d.highest) { t.did.replay_blocked = true; return dec("replay", "That one-time code was already used, so the server refused it."); }
        }
        const amount = Number(b.amount); if (!(amount > 0) || amount > HARD_CAP) throw bad(400, "invalid_request", "amount must be between 0 and " + HARD_CAP);
        const fp = b.clone ? crypto.randomBytes(16).toString("hex") : d.fp;
        if (fp !== d.fp) { t.did.clone_blocked = true; return dec("device_mismatch", "The device fingerprint does not match the one registered at provisioning."); }
        if (amount > STEP_UP && !b.verified) return dec("verification_required", "Large payment: unlock the phone and verify the cardholder, then tap again.");
        const key = d.keys.find((k) => k.left > 0);
        if (!key) { t.did.exhausted = true; return dec("no_keys", "No keys left. The phone must go online and ask for a new batch."); }
        key.left--; d.counter++; const code = cg(key.k, d.counter, amount, merchant); d.last = { counter: d.counter, code }; d.highest = d.counter;
        t.did.paid = true; log(t, "payment.approved", `${amount} at ${merchant}, counter ${d.counter}`); save(acc); send(res, 200, { approved: true, amount, cryptogram: code, counter: d.counter }); return true;
      }
      if (m === "POST" && path === "/v1/hce/replenish") {
        if (d.state !== "active") throw bad(409, "not_active", "Only an active device can receive new keys");
        d.keys = d.keys.filter((k) => k.left > 0).concat(mkBatch()); d.batches++; t.did.replenished = true; log(t, "keys.replenished", "new batch loaded"); save(acc);
        send(res, 200, { message: "New batch loaded. Keys left: " + d.keys.reduce((s, k) => s + k.left, 0) }); return true;
      }
      if (m === "POST" && path === "/v1/hce/suspend") { if (d.state !== "active") throw bad(409, "not_active", "Only an active device can be suspended"); d.state = "suspended"; t.did.suspended = true; log(t, "token.suspended", "remote suspend"); save(acc); send(res, 200, { message: "Suspended. The card itself is untouched." }); return true; }
      if (m === "POST" && path === "/v1/hce/resume") { if (d.state !== "suspended") throw bad(409, "not_suspended", "The device is not suspended"); d.state = "active"; t.did.resumed = true; log(t, "token.resumed", ""); save(acc); send(res, 200, { message: "Resumed." }); return true; }
      return false;
    },
  };
};
