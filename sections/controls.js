"use strict";
// Card controls and idempotency lab: virtual test cards with cardholder controls, an audit log, and Idempotency-Key handling with a simulated timeout.
module.exports = function ({ html, ctx, UI, esc }) {
  const crypto = require("crypto");
  const { send, bad, readBody, rnd, save } = ctx;
  const CHANNELS = ["pos", "online", "atm", "contactless"], MAX_CARDS = 5, MAX_AUDIT = 60, MAX_KEYS = 200, KEY_TTL = 24 * 3600e3;
  const today = () => new Date().toISOString().slice(0, 10);
  const stats = (acc) => (acc.ctl = acc.ctl || { replays: 0, mismatches: 0, blocked: 0, timeouts: 0, recovered: 0, doubled: 0 });
  const pubCard = (c) => ({ id: c.id, last4: c.last4, state: c.state, home_country: c.home_country, controls: c.controls, spent_today: c.spent.day === today() ? c.spent.amount : 0, created_at: c.created_at });
  const audit = (c, event, detail) => { c.audit.unshift({ at: new Date().toISOString(), event, ...detail }); if (c.audit.length > MAX_AUDIT) c.audit.length = MAX_AUDIT; };
  const find = (acc, id) => { const c = (acc.cards || []).find((x) => x.id === id); if (!c) throw bad(404, "not_found", "No such card"); return c; };

  function cleanControls(b, cur) {
    const c = { ...cur };
    for (const ch of CHANNELS) if (b[ch] !== undefined) { if (typeof b[ch] !== "boolean") throw bad(400, "invalid_request", `${ch} must be true or false`); c[ch] = b[ch]; }
    if (b.international !== undefined) { if (typeof b.international !== "boolean") throw bad(400, "invalid_request", "international must be true or false"); c.international = b.international; }
    if (b.daily_limit !== undefined) { const n = Number(b.daily_limit); if (!(n >= 0 && n <= 100000)) throw bad(400, "invalid_request", "daily_limit must be 0 to 100000"); c.daily_limit = n; }
    if (b.blocked_mcc !== undefined) { if (!Array.isArray(b.blocked_mcc) || b.blocked_mcc.length > 20 || !b.blocked_mcc.every((m) => /^\d{4}$/.test(String(m)))) throw bad(400, "invalid_request", "blocked_mcc must be up to 20 four-digit merchant category codes"); c.blocked_mcc = b.blocked_mcc.map(String); }
    return c;
  }
  function evaluate(c, a) {
    if (c.state === "frozen") return ["CARD_FROZEN", "The card is frozen"];
    if (!c.controls[a.channel]) return ["CHANNEL_OFF", `The ${a.channel} channel is switched off`];
    if (!c.controls.international && a.country !== c.home_country) return ["INTERNATIONAL_OFF", "International use is switched off"];
    if (c.controls.blocked_mcc.includes(a.mcc)) return ["MCC_BLOCKED", `Merchant category ${a.mcc} is blocked`];
    const spent = c.spent.day === today() ? c.spent.amount : 0;
    if (c.controls.daily_limit > 0 && spent + a.amount > c.controls.daily_limit) return ["DAILY_LIMIT", `This would take today's spend to ${Math.round((spent + a.amount) * 100) / 100}, over the limit of ${c.controls.daily_limit}`];
    return null;
  }

  // Idempotency: same key + same request returns the stored response; same key + different request is an error.
  async function idem(acc, req, res, scope, bodyObj, run) {
    const key = req.headers["idempotency-key"];
    const respond = (out) => send(res, out.timeout ? 504 : out.status, out.timeout ? { error: { code: "SBX-5040", message: "Gateway timeout. The outcome is unknown: retry with the same Idempotency-Key, or look the payment up." } } : out.body);
    if (key === undefined) return respond(await run(false));
    if (!/^[A-Za-z0-9_.:-]{8,64}$/.test(key)) throw bad(400, "invalid_request", "Idempotency-Key must be 8 to 64 letters, digits or - _ . :");
    const store = acc.idem = acc.idem || {}, now = Date.now();
    for (const [k, v] of Object.entries(store)) if (now - v.at > KEY_TTL) delete store[k];
    const sig = crypto.createHash("sha256").update(scope + JSON.stringify(bodyObj || {})).digest("hex"), k = scope + "|" + key, hit = store[k];
    if (hit) {
      if (hit.sig !== sig) { stats(acc).mismatches++; save(acc); throw bad(422, "idempotency_key_reused", "This Idempotency-Key was already used with a different request"); }
      stats(acc).replays++; if (hit.timeout) stats(acc).recovered++; save(acc);
      return send(res, hit.timeout ? 200 : hit.status, hit.body, { "idempotent-replayed": "true" });
    }
    if (Object.keys(store).length >= MAX_KEYS) throw bad(429, "too_many_keys", "Too many stored idempotency keys; they expire after 24 hours");
    const out = await run(true); store[k] = { sig, at: now, status: out.status, body: out.body, timeout: !!out.timeout }; save(acc);
    return respond(out);
  }

  function page() {
    const body = `<style>.k select,.k input{width:auto;display:inline-block}</style><div class="crumbs"><a href="/labs">Payment Labs</a> / Card controls and idempotency</div><h1>Card controls and idempotency lab</h1>
<p class="lede">Two things every payments API needs. <strong>Controls</strong> let a cardholder limit how a card can be used. <strong>Idempotency keys</strong> make it safe to retry a request that timed out, so nobody is charged twice. Everything here uses a made-up test card.</p>
<div class="panel"><strong>1. A virtual test card</strong><p id="card" class="hint">No card yet.</p><button class="primary" id="mk" type="button">Create a test card</button> <button type="button" id="fr">Freeze / unfreeze</button></div>
<div class="panel k"><strong>2. Controls</strong><p><label><input type="checkbox" data-ch="pos"> POS</label> <label><input type="checkbox" data-ch="online"> Online</label> <label><input type="checkbox" data-ch="atm"> ATM</label> <label><input type="checkbox" data-ch="contactless"> Contactless</label> <label><input type="checkbox" id="intl"> International</label></p>
<p>Daily limit <input id="lim" size="6" value="0" aria-label="daily limit"> (0 = none) · Blocked merchant categories <input id="mcc" size="14" placeholder="7995, 5967" aria-label="blocked MCC"> <button type="button" id="sv" class="small">Save controls</button></p></div>
<div class="panel k"><strong>3. Try a payment</strong><p>Amount <input id="am" size="6" value="40"> Channel <select id="chn"><option>online</option><option>pos</option><option>atm</option><option>contactless</option></select> Country <select id="cty"><option>PL</option><option>US</option></select> MCC <input id="mc" size="5" value="5411"> <button type="button" id="go" class="primary">Authorize</button></p>
<p><strong>Retry safety:</strong> <label><input type="checkbox" id="ik" checked> send an Idempotency-Key</label> <label><input type="checkbox" id="to"> simulate a timeout after the server did the work</label></p>
<p class="hint">Try: tick the timeout box, press Authorize, then press it again with the same settings. With the key, the retry returns the first result and the spend is counted once. Without it, the retry charges again.</p><p id="res" class="hint"></p></div>
<div class="panel"><strong>Audit log</strong><div id="log" class="hint">Nothing yet.</div></div>
<h2>What to notice</h2><ul><li>Every control has a reason code, so the app can say why a payment was refused.</li><li>The key must stay the same on the retry and the request must not change. A different request with the same key is refused.</li><li>Keys expire after 24 hours. Real APIs differ, so read your provider's rules.</li></ul>
<p class="hint">Related: <a href="/knowledge/idempotency-and-retries">Idempotency and retries</a>, <a href="/academy/api-security">API security and idempotency course</a>.</p>`;
    const script = `var card=null,seq=0,keyFor=null;function $(i){return document.getElementById(i);}
function show(){if(!card){$("card").textContent="No card yet.";return;}$("card").textContent=card.id+" · •••• "+card.last4+" · "+card.state+" · spent today "+card.spent_today;
document.querySelectorAll("[data-ch]").forEach(function(c){c.checked=!!card.controls[c.dataset.ch];});$("intl").checked=!!card.controls.international;$("lim").value=card.controls.daily_limit;$("mcc").value=card.controls.blocked_mcc.join(", ");}
async function refresh(){if(!card)return;var r=await Z.api("GET","/v1/cards/"+card.id);if(r.status===200){card=r.body.card;show();$("log").innerHTML=r.body.audit.length?r.body.audit.slice(0,12).map(function(a){return "<div>"+Z.esc(a.at.slice(11,19))+" · <strong>"+Z.esc(a.event)+"</strong> "+Z.esc(a.detail||"")+"</div>";}).join(""):"Nothing yet.";}}
async function api(m,p,b,h){if(!(await Z.ensureKey()))return {status:0,body:{}};return Z.api(m,p,b);}
(async function(){if(Z.hasKey()){var r=await Z.api("GET","/v1/cards");if(r.status===200&&r.body.data.length){card=r.body.data[0];show();refresh();}}})();
$("mk").onclick=async function(){var r=await api("POST","/v1/cards",{});if(r.status===201){card=r.body.card;show();refresh();}else $("card").textContent=Z.msg(r);};
$("fr").onclick=async function(){if(!card)return;var r=await Z.api("POST","/v1/cards/"+card.id+"/"+(card.state==="frozen"?"unfreeze":"freeze"));if(r.status===200){card=r.body.card;show();refresh();}};
$("sv").onclick=async function(){if(!card)return;var b={international:$("intl").checked,daily_limit:+$("lim").value||0,blocked_mcc:$("mcc").value.split(/[ ,]+/).filter(Boolean)};document.querySelectorAll("[data-ch]").forEach(function(c){b[c.dataset.ch]=c.checked;});var r=await Z.api("PUT","/v1/cards/"+card.id+"/controls",b);$("res").textContent=r.status===200?"Controls saved.":Z.msg(r);refresh();};
$("go").onclick=async function(){if(!card){$("res").textContent="Create a card first.";return;}var b={amount:+$("am").value,channel:$("chn").value,country:$("cty").value,mcc:$("mc").value,simulate_timeout:$("to").checked};
var sig=JSON.stringify(b);if(keyFor===null||keyFor.sig!==sig){keyFor={sig:sig,key:"lab-"+Math.random().toString(36).slice(2,12)};}
var h={"content-type":"application/json"};var k=Z.hasKey()?localStorage.getItem("dryrun_key"):null;h.authorization="Bearer "+k;if($("ik").checked)h["idempotency-key"]=keyFor.key;
var r=await fetch("/v1/cards/"+card.id+"/authorize",{method:"POST",headers:h,body:JSON.stringify(b)});var j={};try{j=await r.json();}catch(e){}
var replay=r.headers.get("idempotent-replayed")==="true";
$("res").textContent=r.status+" "+(j.error?j.error.message:(j.approved?"Approved":"Declined: "+j.reason_code+" - "+j.reason))+(replay?" (replayed: same result as the first request, nothing charged again)":"");refresh();};`;
    return UI.shell({ title: "Card controls and idempotency lab – Zanboxx", description: "Cardholder controls, an audit log and safe retries with idempotency keys.", active: "labs", body, script });
  }

  return {
    async handle(req, res, path, m) {
      if (m === "GET" && path === "/labs/controls") { html(res, 200, page()); return true; }
      if (!path.startsWith("/v1/cards")) return false;
      const acc = ctx.authed(req); acc.cards = acc.cards || []; let mt;
      if (m === "GET" && path === "/v1/cards") { send(res, 200, { data: acc.cards.map(pubCard) }); return true; }
      if (m === "POST" && path === "/v1/cards") {
        if (acc.cards.length >= MAX_CARDS) throw bad(409, "limit", `At most ${MAX_CARDS} test cards per account`);
        const b = (await readBody(req)) || {}, home = /^[A-Z]{2}$/.test(String(b.home_country || "PL")) ? String(b.home_country || "PL") : (() => { throw bad(400, "invalid_request", "home_country must be a two-letter country code"); })();
        const c = { id: "crd_" + rnd(6), last4: String(1000 + (crypto.randomBytes(2).readUInt16BE() % 9000)), state: "active", home_country: home, controls: { pos: true, online: true, atm: true, contactless: true, international: true, daily_limit: 0, blocked_mcc: [] }, spent: { day: today(), amount: 0 }, audit: [], created_at: new Date().toISOString() };
        audit(c, "card.created", {}); acc.cards.push(c); save(acc); send(res, 201, { card: pubCard(c) }); return true;
      }
      if (!(mt = path.match(/^\/v1\/cards\/(crd_[a-f0-9]+)(?:\/(freeze|unfreeze|controls|authorize|audit))?$/))) return false;
      const c = find(acc, mt[1]), what = mt[2];
      if (m === "GET" && !what) { send(res, 200, { card: pubCard(c), audit: c.audit.slice(0, 20).map((a) => ({ at: a.at, event: a.event, detail: a.detail || "" })) }); return true; }
      if (m === "GET" && what === "audit") { send(res, 200, { data: c.audit }); return true; }
      if (m === "DELETE" && !what) { acc.cards = acc.cards.filter((x) => x !== c); save(acc); send(res, 200, { deleted: true }); return true; }
      if (m === "PUT" && what === "controls") {
        const b = await readBody(req); if (!b || typeof b !== "object") throw bad(400, "invalid_request", "Send a JSON body");
        c.controls = cleanControls(b, c.controls); audit(c, "controls.changed", { detail: JSON.stringify(c.controls) }); save(acc); send(res, 200, { card: pubCard(c) }); return true;
      }
      if (m === "POST" && (what === "freeze" || what === "unfreeze")) {
        await idem(acc, req, res, c.id + what, {}, async () => {
          const want = what === "freeze" ? "frozen" : "active";
          if (c.state !== want) { c.state = want; audit(c, "card." + what, {}); } else audit(c, "card." + what + ".noop", { detail: "already " + want });
          save(acc); return { status: 200, body: { card: pubCard(c) } };
        }); return true;
      }
      if (m === "POST" && what === "authorize") {
        const b = await readBody(req), amount = Number(b && b.amount);
        if (!b || !(amount > 0 && amount <= 100000) || !CHANNELS.includes(b.channel) || !/^[A-Z]{2}$/.test(String(b.country || "")) || !/^\d{4}$/.test(String(b.mcc || ""))) throw bad(400, "invalid_request", "Send amount (>0), channel (pos, online, atm, contactless), country (two letters) and mcc (four digits)");
        const a = { amount, channel: b.channel, country: b.country, mcc: String(b.mcc) };
        await idem(acc, req, res, c.id + "auth", b, async (keyed) => {
          const why = evaluate(c, a), st = stats(acc);
          let body;
          if (why) { st.blocked++; audit(c, "authorization.declined", { detail: `${a.amount} ${a.channel} ${a.country} mcc ${a.mcc}: ${why[0]}` }); body = { id: "auth_" + rnd(6), approved: false, reason_code: why[0], reason: why[1], amount }; }
          else {
            if (c.spent.day !== today()) c.spent = { day: today(), amount: 0 };
            const dup = c.audit.find((x) => x.event === "authorization.approved" && Date.now() - Date.parse(x.at) < 30000 && x.detail === `${a.amount} ${a.channel} ${a.country} mcc ${a.mcc}`);
            c.spent.amount = Math.round((c.spent.amount + amount) * 100) / 100; if (dup && !keyed) st.doubled++;
            audit(c, "authorization.approved", { detail: `${a.amount} ${a.channel} ${a.country} mcc ${a.mcc}` }); body = { id: "auth_" + rnd(6), approved: true, amount, spent_today: c.spent.amount };
          }
          if (b.simulate_timeout === true) st.timeouts++;
          save(acc); return { status: 200, body, timeout: b.simulate_timeout === true };
        });
        return true;
      }
      return false;
    },
  };
};
