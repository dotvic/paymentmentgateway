"use strict";
// QR payments lab: build and decode a merchant-presented QR payload (tag-length-value fields with a CRC-16 checksum),
// scan and pay it (dynamic codes are single use and expire), and judge seven scanning scenarios. The layout follows the
// open merchant-presented QR convention in simplified form. All names, accounts and amounts are fictional test data.
const { encode, toSvg } = require("./qrcode");

module.exports = function ({ html, ctx, UI, esc }) {
  const { send, bad, readBody, save } = ctx;
  const SCHEME_ID = "ZANBOXX.TEST", LIFE_MIN = 15;
  const NAMES = { "00": "Payload format version", "01": "Initiation method", "52": "Merchant category code", "53": "Currency (numeric)", "54": "Amount", "58": "Country", "59": "Payee name", "60": "Payee city", "62": "Additional data", "63": "Checksum (CRC-16)" };
  const SUB = { "26": { "00": "Scheme identifier", "01": "Payee account" }, "62": { "01": "Bill number", "05": "Reference label" } };
  const st = (acc) => (acc.qr = acc.qr || { did: {}, invoices: {}, answers: {} });
  const tlv = (t, v) => t + String(v.length).padStart(2, "0") + v;

  function crc16(s) { let c = 0xffff; for (const b of Buffer.from(s, "latin1")) { c ^= b << 8; for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; } return c.toString(16).toUpperCase().padStart(4, "0"); }

  function build(b) {
    const dynamic = !!b.dynamic, name = String(b.name || "").trim(), city = String(b.city || "").trim(), acct = String(b.account || "").trim(), ref = String(b.reference || "").trim();
    if (!name || name.length > 25) throw bad(400, "invalid_request", "name is required, up to 25 characters");
    if (!city || city.length > 15) throw bad(400, "invalid_request", "city is required, up to 15 characters");
    if (!/^[A-Za-z0-9-]{3,20}$/.test(acct)) throw bad(400, "invalid_request", "account must be 3 to 20 letters, digits or hyphens");
    if (!/^\d{4}$/.test(String(b.mcc || "5812"))) throw bad(400, "invalid_request", "mcc must be 4 digits");
    if (!/^\d{3}$/.test(String(b.currency || "978"))) throw bad(400, "invalid_request", "currency must be 3 digits, for example 978");
    if (!/^[A-Z]{2}$/.test(String(b.country || "PL"))) throw bad(400, "invalid_request", "country must be 2 capital letters");
    if (ref && !/^[A-Za-z0-9-]{1,25}$/.test(ref)) throw bad(400, "invalid_request", "reference may hold letters, digits and hyphens, up to 25");
    let amount = b.amount === undefined || b.amount === "" ? null : String(b.amount);
    if (amount !== null && !/^\d{1,9}(\.\d{1,2})?$/.test(amount)) throw bad(400, "invalid_request", "amount must look like 12 or 12.50");
    if (dynamic && (amount === null || !ref)) throw bad(400, "invalid_request", "A dynamic code needs an amount and a reference, because it stands for one specific invoice");
    let p = tlv("00", "01") + tlv("01", dynamic ? "12" : "11") + tlv("26", tlv("00", SCHEME_ID) + tlv("01", acct)) + tlv("52", String(b.mcc || "5812")) + tlv("53", String(b.currency || "978"));
    if (amount !== null) p += tlv("54", amount);
    p += tlv("58", String(b.country || "PL")) + tlv("59", name) + tlv("60", city);
    if (ref) p += tlv("62", tlv("05", ref));
    p += "6304"; return p + crc16(p);
  }

  function parse(s) {
    const out = []; let i = 0;
    while (i < s.length) {
      const tag = s.slice(i, i + 2), len = s.slice(i + 2, i + 4);
      if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(len)) return { fields: out, error: `Position ${i}: a tag and a two-digit length were expected here.` };
      const n = parseInt(len, 10), v = s.slice(i + 4, i + 4 + n);
      if (v.length < n) return { fields: out, error: `Tag ${tag} says its value is ${n} characters long but only ${v.length} remain.` };
      out.push({ tag, length: n, value: v }); i += 4 + n;
    }
    return { fields: out, error: null };
  }

  function decode(raw) {
    const s = String(raw || "").trim();
    if (!s) throw bad(400, "invalid_request", "payload is required");
    if (s.length > 600) throw bad(400, "invalid_request", "payload is too long for this lab");
    const { fields, error } = parse(s), warnings = [], list = [];
    for (const f of fields) {
      const e = { tag: f.tag, name: NAMES[f.tag] || (+f.tag >= 26 && +f.tag <= 51 ? "Payee account information" : "Other field"), length: f.length, value: f.value };
      const subKey = +f.tag >= 26 && +f.tag <= 51 ? "26" : f.tag;
      if (SUB[subKey]) { const sub = parse(f.value); e.children = sub.fields.map((c) => ({ tag: c.tag, name: SUB[subKey][c.tag] || "Other", length: c.length, value: c.value })); if (sub.error) warnings.push({ level: "error", text: `Inside tag ${f.tag}: ${sub.error}` }); }
      list.push(e);
    }
    if (error) warnings.push({ level: "error", text: error });
    const get = (t) => (fields.find((f) => f.tag === t) || {}).value;
    const crcField = fields.find((f) => f.tag === "63"), crcOk = !!crcField && crcField.length === 4 && crc16(s.slice(0, s.length - 4)) === crcField.value && s.slice(-8, -4) === "6304" && fields[fields.length - 1] === crcField;
    if (!crcField) warnings.push({ level: "error", text: "No checksum field (tag 63). A scanner cannot tell whether the text was altered." });
    else if (!crcOk) warnings.push({ level: "error", text: `The checksum does not match (the text says ${crcField.value}, the content gives ${crc16(s.slice(0, Math.max(0, s.length - 4)))}). The code was damaged or edited after it was made.` });
    if (get("00") !== "01") warnings.push({ level: "error", text: "Payload format version must be 01." });
    const init = get("01"); if (!["11", "12"].includes(init)) warnings.push({ level: "error", text: "Initiation method must be 11 (static) or 12 (dynamic)." });
    const acct = list.find((e) => +e.tag >= 26 && +e.tag <= 51); const acctId = acct && acct.children && (acct.children.find((c) => c.tag === "01") || {}).value;
    if (!acct || !acctId) warnings.push({ level: "error", text: "No payee account (tags 26 to 51 with an account inside)." });
    if (!get("59")) warnings.push({ level: "error", text: "No payee name. A customer's app cannot show who is being paid." });
    const amount = get("54"); if (amount !== undefined && !/^\d{1,9}(\.\d{1,2})?$/.test(amount)) warnings.push({ level: "error", text: "The amount is not a plain decimal number." });
    if (get("53") !== undefined && !/^\d{3}$/.test(get("53"))) warnings.push({ level: "error", text: "Currency must be 3 digits." }); else if (get("53") === undefined) warnings.push({ level: "error", text: "No currency." });
    if (get("58") !== undefined && !/^[A-Z]{2}$/.test(get("58"))) warnings.push({ level: "error", text: "Country must be 2 capital letters." });
    const refLabel = (() => { const a = list.find((e) => e.tag === "62"); return a && a.children && (a.children.find((c) => c.tag === "05") || {}).value; })();
    if (init === "12" && (amount === undefined || !refLabel)) warnings.push({ level: "error", text: "A dynamic code must carry an amount and a reference." });
    if (init === "11" && amount !== undefined) warnings.push({ level: "info", text: "A static code with a fixed amount is unusual: it is printed once, so everyone is asked for the same amount." });
    if (init === "11" && amount === undefined) warnings.push({ level: "info", text: "No amount: the customer types it. Easy to mistype and impossible to match to one invoice." });
    if (init === "12") warnings.push({ level: "info", text: "Dynamic: made for one invoice. The payee should accept it once and let it expire." });
    return { valid: !warnings.some((w) => w.level === "error"), checksum_ok: crcOk, kind: init === "12" ? "dynamic" : init === "11" ? "static" : "unknown", payee: { name: get("59") || null, city: get("60") || null, account: acctId || null }, amount: amount === undefined ? null : amount, reference: refLabel || null, fields: list, warnings };
  }

  function image(text, level) { try { const q = encode(text, level); return { svg: toSvg(q.matrix), version: q.version, size: q.size }; } catch (e) { if (e.code === "too_long") throw bad(400, "too_long", e.message); throw e; } }

  // ---- scanning scenarios (answers stay on the server)
  const mk = (o) => build({ name: "BLUE BEAN CAFE", city: "WARSAW", account: "CAFE-7731", mcc: "5812", currency: "978", country: "PL", ...o });
  const crcBroken = (p) => { const base = p.slice(0, -4), c = parseInt(p.slice(-4), 16); return base + ((c ^ 0x00ff) & 0xffff).toString(16).toUpperCase().padStart(4, "0"); };
  const SCEN = [
    { id: "s1", title: "Sticker at the till", context: "The code is printed on a stand at the café's till. The café's own website lists its payee account as CAFE-7731. You owe 6.40.", payload: () => mk({}), pay: true, why: "The payee name and the account both match what the café publishes. A static code asks you to type the amount, so type 6.40." },
    { id: "s2", title: "A sticker over the sticker", context: "A code is stuck over the printed one at the same café's till. The café's website lists its payee account as CAFE-7731. The code shows the same café name.", payload: () => mk({ account: "CAFE-9902" }), pay: false, why: "A name is easy to copy; the account is where the money goes. This code pays account CAFE-9902, not the café's. Refuse and tell the staff." },
    { id: "s3", title: "Invoice and code disagree", context: "A web shop shows invoice INV-2041 for 42.00 and a QR code to pay it.", payload: () => mk({ dynamic: true, amount: "420.00", reference: "INV-2041" }), pay: false, why: "The code asks for 420.00, ten times the invoice. Always compare the amount in your app with the invoice before you confirm." },
    { id: "s4", title: "A fresh invoice", context: "The café's till screen shows invoice INV-2043 for 18.50 and a QR code. It was created a minute ago.", payload: () => mk({ dynamic: true, amount: "18.50", reference: "INV-2043" }), pay: true, why: "Payee, account, amount and reference all agree, and the code is new. This is how a dynamic code should look." },
    { id: "s5", title: "An old invoice", context: "A message asks you to settle invoice INV-2040 with the attached code. The invoice was issued at 14:00 and is valid for 15 minutes. Your phone clock says 14:31.", payload: () => mk({ dynamic: true, amount: "27.00", reference: "INV-2040" }), pay: false, why: "The invoice expired 16 minutes ago. A payee that honours old dynamic codes can be paid twice or tricked, and you cannot be sure the request is still real." },
    { id: "s6", title: "Urgent message, odd code", context: "A message says 'pay now or your service stops' and attaches a code. Your app warns that the code looks damaged.", payload: () => crcBroken(mk({ dynamic: true, amount: "89.00", reference: "INV-7710" })), pay: false, why: "The checksum fails, so the text was changed after it was made, and the message uses pressure. Do not pay; contact the company by a number you already trust." },
    { id: "s7", title: "Your own phone code", kind: "consumer", context: "At the till, the cashier asks you to show your wallet app's payment code. Your code stands on the screen, but you opened it 12 minutes ago. These codes last 2 minutes.", payload: () => "ZBXTKN:8F3A19C2D4E7:ISSUED=12:02:00:LIFE=120S", pay: false, why: "A customer-presented code holds a short-lived token, not your card number. After two minutes it is useless, so refresh it. That is exactly why a photo of the code is not worth stealing." },
  ];

  function view(t) {
    return SCEN.map((s) => { const p = s.payload(); return { id: s.id, title: s.title, kind: s.kind || "merchant", context: s.context, payload: p, svg: image(p, "M").svg, answered: t.answers[s.id] ? { decision: t.answers[s.id].decision, correct: t.answers[s.id].correct } : null }; });
  }

  function pay(t, b) {
    const d = decode(b.payload); const out = { status: "rejected" };
    if (!d.checksum_ok) { out.reason = "The checksum does not match, so the code is refused."; t.did.bad_crc_refused = true; return out; }
    if (!d.valid) { out.reason = "The code is malformed: " + d.warnings.filter((w) => w.level === "error")[0].text; return out; }
    if (d.kind === "static") {
      if (!(Number(b.amount) > 0)) { out.reason = "A static code carries no amount, so the payer must enter one."; return out; }
      t.did.paid_static = true; return { status: "paid", amount: String(b.amount), note: "Paid. Nothing ties this payment to one invoice, so matching it to an order depends on the amount and time." };
    }
    const inv = t.invoices[d.reference];
    if (!inv) { out.reason = "Unknown reference: this payee never issued that invoice."; return out; }
    if (inv.account !== d.payee.account || inv.amount !== d.amount) { out.reason = "The code does not match the invoice the payee issued (account or amount differs)."; t.did.tamper_blocked = true; return out; }
    if (inv.used) { out.reason = "This invoice was already paid. A dynamic code works once."; t.did.replay_blocked = true; return out; }
    const later = Math.min(Math.max(Number(b.minutes_later) || 0, 0), 600);
    if (Date.now() + later * 60000 > inv.expires_at) { out.reason = `This invoice expired (valid ${LIFE_MIN} minutes).`; t.did.expired_blocked = true; return out; }
    inv.used = true; t.did.paid_dynamic = true; return { status: "paid", amount: inv.amount, reference: d.reference, note: "Paid and matched to the invoice. Scanning the same code again will be refused." };
  }

  function page() {
    const body = `<style>.k select,.k input,.k textarea{width:auto;display:inline-block}textarea{width:100%!important;font-family:ui-monospace,monospace;min-height:80px}.qr{width:200px;max-width:100%;border:1px solid var(--line,#e3e7ef);border-radius:8px}.t td,.t th{padding:5px 8px;border-bottom:1px solid var(--line,#e3e7ef);text-align:left;vertical-align:top}.sc{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start}.sc .qr{width:150px}.w-error{color:#b3261e}.w-info{color:var(--mute,#5b6478)}</style><div class="wrap"><h1>QR payments lab</h1>
<p class="lede">A merchant's QR code is just text: short tag-length-value fields that say who is being paid, how much and in what currency, closed by a checksum. Build one, take one apart, pay one, then judge seven codes you might meet in real life. Names, accounts and amounts are fictional. Test data only.</p>
<div class="panel k"><strong>1. Build a code</strong>
<p>Payee <input id="nm" size="18" value="BLUE BEAN CAFE"> City <input id="ct" size="12" value="WARSAW"> Account <input id="ac" size="12" value="CAFE-7731"> Amount <input id="am" size="7" value="18.50"> Reference <input id="rf" size="10" value="INV-2043"></p>
<p><label><input type="checkbox" id="dy" checked> Dynamic (one invoice, one use)</label> <button type="button" id="bb">Build</button> <span id="bm" class="hint"></span></p>
<div class="sc"><div id="bi"></div><div><p><strong>Text inside the code</strong></p><textarea id="bp" spellcheck="false" readonly></textarea><p><button type="button" id="dc" class="small">Take apart</button> <button type="button" id="py" class="small">Scan and pay</button> <label class="hint">pretend <input id="ml" size="2" value="0"> minutes have passed</label></p><div id="po" class="hint"></div></div></div></div>
<div class="panel k"><strong>2. Take a code apart</strong><p class="hint">Paste any payload, or press Take apart above. Edit one character to see the checksum fail.</p><textarea id="dp" spellcheck="false"></textarea><p><button type="button" id="db" class="small">Decode</button></p><div id="do"></div></div>
<div class="panel k"><strong>3. Would you pay?</strong><p class="hint">Read the situation, then press Pay or Refuse. Use the decoder on any payload you want to inspect.</p><div id="scn"></div></div>
<h2>What to notice</h2><ul><li>The code is only text. Anyone can print one, so what matters is <b>who it pays</b>: the payee account, not the name or the logo.</li><li>The checksum catches damage and careless edits, not a forger who recomputes it. It is not a signature.</li><li>A <b>static</b> code is printed once and the payer types the amount. A <b>dynamic</b> code stands for one invoice and should work once and expire.</li><li>Codes shown by the customer should carry a short-lived token, never the card number.</li></ul>
<p class="hint">Related: <a href="/knowledge/how-qr-payments-work">How QR payments work</a>, <a href="/knowledge/qr-payment-fraud-and-safe-scanning">QR fraud and safe scanning</a>, <a href="/academy/qr-payments">QR payments course</a>.</p></div>`;
    const script = `function $(i){return document.getElementById(i);}
async function api(m,p,b){if(!(await Z.ensureKey()))return {status:0,body:{}};return Z.api(m,p,b);}
$("bb").onclick=async function(){var r=await api("POST","/v1/qr/build",{name:$("nm").value,city:$("ct").value,account:$("ac").value,amount:$("am").value,reference:$("rf").value,dynamic:$("dy").checked});if(r.status!==200){$("bm").textContent=Z.msg(r);return;}$("bm").textContent="";$("bi").innerHTML=r.body.svg.replace("<svg ",'<svg class="qr" ');$("bp").value=r.body.payload;$("dp").value=r.body.payload;$("po").textContent="";};
function show(d){var h='<p><b>'+(d.valid?"Valid":"Not valid")+'</b>, '+Z.esc(d.kind)+(d.payee.name?', pays <b>'+Z.esc(d.payee.name)+'</b> account <b>'+Z.esc(d.payee.account||"?")+'</b>':"")+(d.amount?', amount '+Z.esc(d.amount):"")+'</p><table class="t"><tr><th>Tag</th><th>Meaning</th><th>Length</th><th>Value</th></tr>'+d.fields.map(function(f){return "<tr><td>"+f.tag+"</td><td>"+Z.esc(f.name)+"</td><td>"+f.length+"</td><td>"+Z.esc(f.value)+(f.children?"<br>"+f.children.map(function(c){return "&nbsp;&nbsp;"+c.tag+" "+Z.esc(c.name)+": "+Z.esc(c.value);}).join("<br>"):"")+"</td></tr>";}).join("")+"</table><ul>"+d.warnings.map(function(w){return '<li class="w-'+w.level+'">'+Z.esc(w.text)+"</li>";}).join("")+"</ul>";return h;}
async function dec(txt,el){var r=await api("POST","/v1/qr/decode",{payload:txt});el.innerHTML=r.status===200?show(r.body):Z.esc(Z.msg(r));}
$("db").onclick=function(){dec($("dp").value,$("do"));};$("dc").onclick=function(){$("dp").value=$("bp").value;dec($("bp").value,$("do"));};
$("py").onclick=async function(){var r=await api("POST","/v1/qr/pay",{payload:$("bp").value,amount:$("am").value,minutes_later:parseInt($("ml").value,10)||0});$("po").innerHTML=r.status===200?('<b>'+Z.esc(r.body.status)+'</b>. '+Z.esc(r.body.reason||r.body.note||"")):Z.esc(Z.msg(r));};
async function scen(){var r=await api("GET","/v1/qr/scenarios");if(r.status!==200){$("scn").textContent=Z.msg(r);return;}$("scn").innerHTML=r.body.scenarios.map(function(s){return '<div class="panel"><strong>'+Z.esc(s.title)+'</strong><div class="sc"><div>'+s.svg.replace("<svg ",'<svg class="qr" ')+'</div><div style="flex:1;min-width:220px"><p>'+Z.esc(s.context)+'</p><p><button type="button" class="small" data-i="'+s.id+'" data-d="pay">Pay</button> <button type="button" class="small" data-i="'+s.id+'" data-d="refuse">Refuse</button> <button type="button" class="small" data-x="'+s.id+'">Inspect</button></p><div id="r-'+s.id+'" class="hint">'+(s.answered?(s.answered.correct?"You answered correctly.":"You answered wrongly. Answer again to see why."):"")+'</div></div></div><textarea id="p-'+s.id+'" hidden>'+Z.esc(s.payload)+'</textarea></div>';}).join("");}
$("scn").onclick=async function(e){var b=e.target.closest("button");if(!b)return;if(b.dataset.x){var p=$("p-"+b.dataset.x).value;$("dp").value=p;dec(p,$("do"));$("do").scrollIntoView({behavior:"smooth"});return;}var r=await api("POST","/v1/qr/scenarios/"+b.dataset.i+"/answer",{decision:b.dataset.d});$("r-"+b.dataset.i).innerHTML=r.status===200?("<b>"+(r.body.correct?"Correct. ":"Not quite. ")+"</b>"+Z.esc(r.body.why)):Z.esc(Z.msg(r));};
if(Z.hasKey())scen();else $("bm").textContent="Create a test key to start.";`;
    return UI.shell({ title: "QR payments lab – Zanboxx", description: "Build and take apart a QR payment code, pay a dynamic invoice once, and judge seven codes for tampering, expiry and swapped payees.", active: "labs", body, script });
  }

  return {
    async handle(req, res, path, m) {
      if (m === "GET" && path === "/labs/qr") { html(res, 200, page()); return true; }
      if (!path.startsWith("/v1/qr")) return false;
      const acc = ctx.authed(req), t = st(acc);
      if (m === "POST" && path === "/v1/qr/build") {
        const b = await readBody(req), payload = build(b), img = image(payload, "M");
        if (b.dynamic) { t.invoices[String(b.reference)] = { account: String(b.account).trim(), amount: String(b.amount), expires_at: Date.now() + LIFE_MIN * 60000, used: false }; t.did.dynamic = true; } else t.did.static = true;
        save(acc); send(res, 200, { payload, kind: b.dynamic ? "dynamic" : "static", crc: payload.slice(-4), qr_version: img.version, svg: img.svg, valid_minutes: b.dynamic ? LIFE_MIN : null }); return true;
      }
      if (m === "POST" && path === "/v1/qr/decode") {
        const d = decode((await readBody(req)).payload); t.did.decoded = true; if (!d.checksum_ok) t.did.bad_crc = true; if (d.valid) t.did.decoded_valid = true; save(acc); send(res, 200, d); return true;
      }
      if (m === "POST" && path === "/v1/qr/pay") { const out = pay(t, await readBody(req)); save(acc); send(res, 200, out); return true; }
      if (m === "GET" && path === "/v1/qr/scenarios") { send(res, 200, { scenarios: view(t) }); return true; }
      const a = path.match(/^\/v1\/qr\/scenarios\/(s\d)\/answer$/);
      if (m === "POST" && a) {
        const s = SCEN.find((x) => x.id === a[1]); if (!s) throw bad(404, "not_found", "No such scenario");
        const d = (await readBody(req)).decision; if (!["pay", "refuse"].includes(d)) throw bad(400, "invalid_request", "decision must be pay or refuse");
        const correct = (d === "pay") === s.pay; t.answers[s.id] = { decision: d, correct };
        const ok = Object.values(t.answers).filter((x) => x.correct).length;
        if (ok >= SCEN.length) t.did.all_correct = true; if (SCEN.filter((x) => !x.pay && t.answers[x.id] && t.answers[x.id].correct).length >= 3) t.did.spotted3 = true;
        save(acc); send(res, 200, { correct, should: s.pay ? "pay" : "refuse", why: s.why, scenarios_correct: ok, of: SCEN.length }); return true;
      }
      return false;
    },
  };
};
