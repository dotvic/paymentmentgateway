"use strict";
// Messaging explorer: build and read card messages in a small teaching profile of the classic bitmap format (type code, bitmap, numbered
// fields), and see the same transaction as an XML-style document. The layout is a simplified teaching profile with invented choices,
// not any scheme's or processor's specification. Test card numbers only.

module.exports = function ({ html, ctx, UI, esc }) {
  const { send, bad, readBody, save } = ctx;
  const SCH = require("../schemes");
  const TEST = new Set(SCH.TEST_CARDS.map((c) => c.number));
  const st = (acc) => (acc.msgs = acc.msgs || { did: {} });

  // number: [name, kind, length, charset]; kind "fixed" or "var" (two-digit length prefix); charset n digits, an letters+digits, ans anything printable
  const F = { 2: ["Card number", "var", 19, "n"], 3: ["Processing code", "fixed", 6, "n"], 4: ["Amount (minor units)", "fixed", 12, "n"], 7: ["Date and time MMDDhhmmss", "fixed", 10, "n"], 11: ["Trace number", "fixed", 6, "n"], 12: ["Local time hhmmss", "fixed", 6, "n"], 13: ["Local date MMDD", "fixed", 4, "n"], 37: ["Retrieval reference", "fixed", 12, "an"], 38: ["Approval code", "fixed", 6, "an"], 39: ["Response code", "fixed", 2, "an"], 41: ["Terminal id", "fixed", 8, "ans"], 42: ["Merchant id", "fixed", 15, "ans"], 49: ["Currency (numeric)", "fixed", 3, "n"] };
  const NUMS = Object.keys(F).map(Number).sort((a, b) => a - b);
  const MTI = { "0100": ["Authorisation request", [2, 3, 4, 7, 11, 41, 42, 49]], "0110": ["Authorisation response", [11, 39]], "0200": ["Financial request", [2, 3, 4, 7, 11, 41, 42, 49]], "0210": ["Financial response", [11, 39]], "0400": ["Reversal request", [2, 3, 4, 7, 11, 41, 42, 49]], "0410": ["Reversal response", [11, 39]] };
  const RC = { "00": "approved", "05": "declined, do not honour", "14": "invalid card number", "51": "insufficient funds", "54": "expired card", "91": "issuer unavailable" };
  const CS = { n: /^[0-9]*$/, an: /^[A-Za-z0-9]*$/, ans: /^[\x20-\x7e]*$/ };
  const mask = (p) => (p.length > 10 ? p.slice(0, 6) + "*".repeat(p.length - 10) + p.slice(-4) : "*".repeat(p.length));
  const guardPan = (pan) => { if (pan && !TEST.has(pan)) throw bad(422, "real_card_data", "This explorer only works with Zanboxx test card numbers. Never type a real card number."); };

  function build(mti, fields) {
    if (!MTI[mti]) throw bad(400, "invalid_request", "Unknown message type. Use one of " + Object.keys(MTI).join(", "));
    const errs = [], used = [];
    for (const k of Object.keys(fields || {})) { const n = Number(k); if (!F[n]) errs.push(`Field ${k} is not part of this teaching profile`); }
    let bits = 0n, body = "";
    for (const n of NUMS) {
      let v = fields[n] !== undefined ? fields[n] : fields[String(n)]; if (v === undefined || v === "") continue; v = String(v);
      const [name, kind, len, cs] = F[n];
      if (!CS[cs].test(v)) { errs.push(`Field ${n} (${name}) has characters that are not allowed`); continue; }
      if (kind === "fixed" && v.length !== len) { errs.push(`Field ${n} (${name}) must be exactly ${len} characters`); continue; }
      if (kind === "var" && (v.length < 1 || v.length > len)) { errs.push(`Field ${n} (${name}) must be 1 to ${len} characters`); continue; }
      bits |= 1n << BigInt(64 - n); body += (kind === "var" ? String(v.length).padStart(2, "0") : "") + v; used.push(n);
    }
    for (const n of MTI[mti][1]) if (!used.includes(n) && !errs.length) errs.push(`Field ${n} (${F[n][0]}) is expected in this message type (${MTI[mti][0].toLowerCase()})`);
    if (errs.length) throw bad(400, "invalid_message", errs.join("; "));
    const bitmap = bits.toString(16).toUpperCase().padStart(16, "0");
    return mti + bitmap + body;
  }

  function parse(msg) {
    const errors = [], rows = [];
    msg = String(msg || "").trim();
    if (msg.length < 20) return { ok: false, errors: ["Message is too short to hold a type code and a bitmap"], rows };
    const mti = msg.slice(0, 4), bm = msg.slice(4, 20);
    if (!MTI[mti]) errors.push(`Message type ${mti.slice(0, 4)} is not valid in this profile`);
    if (!/^[0-9A-Fa-f]{16}$/.test(bm)) return { ok: false, mti, errors: errors.concat(["Bitmap is not 16 hexadecimal characters"]), rows };
    const bits = BigInt("0x" + bm); let pos = 20; const present = [];
    for (let n = 1; n <= 64; n++) if ((bits >> BigInt(64 - n)) & 1n) present.push(n);
    for (const n of present) {
      if (!F[n]) { errors.push(`Bitmap announces field ${n}, which is not in this profile, so reading stops`); break; }
      const [name, kind, len, cs] = F[n]; let L = len, start = pos;
      if (kind === "var") { const ll = msg.slice(pos, pos + 2); if (!/^[0-9]{2}$/.test(ll)) { errors.push(`Field ${n} (${name}) has a bad length prefix "${ll}"`); break; } L = Number(ll); if (L < 1 || L > len) { errors.push(`Field ${n} (${name}) length ${L} is outside 1 to ${len}`); break; } pos += 2; }
      const v = msg.slice(pos, pos + L);
      if (v.length < L) { errors.push(`Message ends inside field ${n} (${name}): expected ${L} characters, found ${v.length}`); rows.push({ n, name, offset: start, length: v.length, value: v, ok: false }); break; }
      const okc = CS[cs].test(v); if (!okc) errors.push(`Field ${n} (${name}) contains characters that are not allowed`);
      rows.push({ n, name, offset: start, length: L, value: n === 2 ? mask(v) : v, ok: okc, meaning: n === 39 ? RC[v] || "unknown code" : undefined, _raw: v });
      pos += L;
    }
    if (!errors.length && pos < msg.length) errors.push(`${msg.length - pos} extra characters after the last announced field. Is a bit missing from the bitmap?`);
    if (MTI[mti] && !errors.length) for (const n of MTI[mti][1]) if (!present.includes(n)) errors.push(`Field ${n} (${F[n][0]}) is expected in this message type (${MTI[mti][0].toLowerCase()}) but its bit is not set`);
    const pan = rows.find((r) => r.n === 2); if (pan && /^[0-9]{12,19}$/.test(pan._raw) && SCH.luhn(pan._raw)) guardPan(pan._raw);
    rows.forEach((r) => delete r._raw);
    return { ok: !errors.length, mti, type: MTI[mti] && MTI[mti][0], bitmap: bm.toUpperCase(), present, errors, rows };
  }

  function toXml(msg) {
    const p = parse(msg); if (!p.ok) throw bad(400, "invalid_message", "Fix the message first: " + p.errors[0]);
    const g = (n) => { const r = p.rows.find((x) => x.n === n); return r ? r.value : null; };
    const amt = g(4), cur = g(49), el = (t, v, a) => v === null ? "" : `    <${t}${a || ""}>${esc(String(v))}</${t}>\n`;
    const kind = { "0100": "AuthorisationRequest", "0110": "AuthorisationResponse", "0200": "PaymentRequest", "0210": "PaymentResponse", "0400": "ReversalRequest", "0410": "ReversalResponse" }[p.mti];
    const dt = g(7) ? `${g(7).slice(0, 2)}-${g(7).slice(2, 4)}T${g(7).slice(4, 6)}:${g(7).slice(6, 8)}:${g(7).slice(8, 10)}` : null;
    const xml = `<Message type="${kind}">\n  <Header>\n${el("TraceId", g(11))}${el("SentAt", dt)}${el("RetrievalRef", g(37))}  </Header>\n  <Body>\n${el("MaskedCard", g(2))}${el("ProcessingCode", g(3))}${amt === null ? "" : el("Amount", (Number(amt) / 100).toFixed(2), ` currencyCode="${esc(cur || "")}"`)}${el("Terminal", g(41))}${el("Merchant", g(42))}${el("ApprovalCode", g(38))}${g(39) === null ? "" : el("Result", RC[g(39)] || "unknown", ` code="${esc(g(39))}"`)}  </Body>\n</Message>`;
    return xml;
  }

  // Find-the-fault quiz: a valid message is mutated in one way and the learner names the fault.
  const GOOD = build("0100", { 2: "4111111111111111", 3: "000000", 4: "000000001250", 7: "1120103045", 11: "000417", 41: "TERM0001", 42: "MERCHANT0000001", 49: "978" });
  const GOOD_R = build("0110", { 11: "000417", 39: "00" });
  const KINDS = ["The length prefix is wrong", "Bitmap and fields disagree", "A field has a character that is not allowed", "The message type is not valid", "A required field is missing", "The message is cut off"];
  const FAULTS = [
    { m: GOOD.replace("164111", "1X4111"), a: 0 },
    { m: GOOD.slice(0, 4) + "F0" + GOOD.slice(6), a: 1 },
    { m: GOOD.replace("000000001250", "0000000012A0"), a: 2 },
    { m: "0150" + GOOD.slice(4), a: 3 },
    { m: "0100" + (BigInt("0x" + GOOD.slice(4, 20)) ^ (1n << 15n)).toString(16).toUpperCase().padStart(16, "0") + GOOD.slice(20, GOOD.length - 3), a: 4 },
    { m: GOOD.slice(0, GOOD.length - 14), a: 5 },
    { m: GOOD_R.replace("39", "39").slice(0, GOOD_R.length - 2) + "0-", a: 2 },
    { m: GOOD_R + "00", a: 1 },
  ].map((f, i) => ({ id: i + 1, message: f.m, a: f.a }));

  function page() {
    const body = `<style>.k select,.k input,.k textarea{width:auto;display:inline-block}select{max-width:100%}textarea{width:100%!important;font-family:ui-monospace,Menlo,monospace;min-height:70px}.t td,.t th{white-space:normal;overflow-wrap:anywhere;padding:5px 8px;border-bottom:1px solid var(--line,#e3e7ef);text-align:left;vertical-align:top}.good{color:#1b7a3d}.bad{color:#b3261e}.mono{font-family:ui-monospace,Menlo,monospace;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6fb;padding:10px;border-radius:8px}</style>
<div class="crumbs"><a href="/labs">Payment Labs</a> / Messaging explorer</div><h1>Messaging explorer</h1>
<p class="lede">Card systems have long exchanged compact messages made of a <strong>type code</strong>, a <strong>bitmap</strong> saying which numbered fields follow, and the fields themselves. Newer systems use XML-style documents. Build a message here, read it field by field, and see the same payment as a readable document. The layout is a simplified teaching profile with invented choices, not any scheme's or processor's specification.</p>
<div class="panel k"><strong>1. Build</strong><p>Type <select id="mt"></select> <button type="button" id="ex">Fill an example</button></p><div id="fl"></div><p><button class="primary" type="button" id="bd">Build message</button> <span class="hint" id="bm"></span></p><textarea id="out" spellcheck="false" placeholder="The built message appears here"></textarea></div>
<div class="panel k"><strong>2. Read</strong><p class="hint">Paste any message, or press Read on the one above. Try breaking it: delete a character, change the bitmap, put a letter in the amount.</p><p><button type="button" id="rd">Read message</button> <button type="button" id="cv">Show as XML</button></p><div id="rres"></div><pre id="xml" hidden></pre></div>
<div class="panel k"><strong>3. Find the fault</strong><p class="hint" id="ft">Eight broken messages. Name the fault in each. Six right passes.</p><div id="fq"></div><p><button type="button" id="fs">Score</button> <span id="fm" class="hint"></span></p></div>
<p class="hint">Related: <a href="/academy/courses/messaging-formats">Card messaging formats course</a>, <a href="/labs/terminal">Terminal messaging lab</a>, <a href="/labs">Payment Labs</a>.</p></div>`;
    const script = `function $(i){return document.getElementById(i);}async function call(a,b,c){if(!(await Z.ensureKey()))return {status:0,body:{}};return Z.api(a,b,c);}
var SETUP=null;
function render(){var t=$('mt').value;$('fl').innerHTML=SETUP.fields.map(function(f){return '<label style="display:inline-block;margin:3px 10px 3px 0">'+f.n+' '+Z.esc(f.name)+' <input data-f="'+f.n+'" size="'+Math.min(18,f.len+2)+'" maxlength="'+f.len+'"></label>';}).join('');}
async function init(){var r=await call('GET','/v1/messages/setup');if(r.status!==200){$('bm').textContent=Z.msg(r)||'Create a test key to start.';return;}SETUP=r.body;$('mt').innerHTML=r.body.types.map(function(x){return '<option value="'+x.mti+'">'+x.mti+' '+Z.esc(x.name)+'</option>';}).join('');render();
$('fq').innerHTML=r.body.faults.map(function(f){return '<div style="margin:8px 0"><div class="mono">'+Z.esc(f.message)+'</div><select data-q="'+f.id+'"><option value="">What is wrong?</option>'+r.body.kinds.map(function(k,i){return '<option value="'+i+'">'+Z.esc(k)+'</option>';}).join('')+'</select></div>';}).join('');}
$('ex').onclick=function(){if(!SETUP)return;var ex=SETUP.example[$('mt').value]||{};[].slice.call(document.querySelectorAll('#fl [data-f]')).forEach(function(e){e.value=ex[e.getAttribute('data-f')]||'';});};
$('bd').onclick=async function(){var f={};[].slice.call(document.querySelectorAll('#fl [data-f]')).forEach(function(e){if(e.value!=='')f[e.getAttribute('data-f')]=e.value;});var r=await call('POST','/v1/messages/build',{mti:$('mt').value,fields:f});if(r.status!==200){$('bm').textContent=Z.msg(r);return;}$('bm').textContent='';$('out').value=r.body.message;};
$('rd').onclick=async function(){var r=await call('POST','/v1/messages/parse',{message:$('out').value});if(r.status!==200){$('rres').textContent=Z.msg(r);return;}var b=r.body;$('xml').hidden=true;$('rres').innerHTML='<p><strong>'+Z.esc(b.type||'Unknown type')+'</strong> '+(b.bitmap?'· bitmap <span class="mono">'+Z.esc(b.bitmap)+'</span> · fields '+b.present.join(', '):'')+'</p>'+(b.errors.length?'<p class="bad">'+b.errors.map(Z.esc).join('<br>')+'</p>':'<p class="good">No faults found.</p>')+'<table class="t"><tr><th>Field</th><th>Name</th><th>At</th><th>Value</th></tr>'+b.rows.map(function(x){return '<tr><td>'+x.n+'</td><td>'+Z.esc(x.name)+'</td><td>'+x.offset+'</td><td class="mono '+(x.ok?'':'bad')+'">'+Z.esc(x.value)+(x.meaning?' ('+Z.esc(x.meaning)+')':'')+'</td></tr>';}).join('')+'</table>';};
$('cv').onclick=async function(){var r=await call('POST','/v1/messages/convert',{message:$('out').value});$('xml').hidden=false;$('xml').textContent=r.status===200?r.body.xml:Z.msg(r);};
$('fs').onclick=async function(){var a={};[].slice.call(document.querySelectorAll('#fq [data-q]')).forEach(function(e){if(e.value!=='')a[e.getAttribute('data-q')]=Number(e.value);});var r=await call('POST','/v1/messages/faults/score',{answers:a});$('fm').textContent=r.status===200?r.body.correct+' of '+r.body.total+(r.body.passed?': passed':': keep going (6 to pass)'):Z.msg(r);};
if(Z.hasKey())init();else $('bm').textContent='Create a test key to start.';`;
    return UI.shell({ title: "Messaging explorer – Zanboxx", description: "Build and read card messages in a simplified teaching profile of the bitmap format, see them as XML, and find the fault in broken messages.", active: "labs", body, script });
  }

  const EXAMPLES = { "0100": { 2: "4111111111111111", 3: "000000", 4: "000000001250", 7: "1120103045", 11: "000417", 41: "TERM0001", 42: "MERCHANT0000001", 49: "978" }, "0110": { 11: "000417", 39: "00" }, "0200": { 2: "4111111111111111", 3: "000000", 4: "000000004999", 7: "1120103112", 11: "000418", 41: "TERM0001", 42: "MERCHANT0000001", 49: "978" }, "0210": { 11: "000418", 39: "51" }, "0400": { 2: "4111111111111111", 3: "000000", 4: "000000001250", 7: "1120103300", 11: "000419", 41: "TERM0001", 42: "MERCHANT0000001", 49: "978" }, "0410": { 11: "000419", 39: "00" } };

  return {
    async handle(req, res, path, m) {
      if (m === "GET" && path === "/labs/messages") { html(res, 200, page()); return true; }
      if (!path.startsWith("/v1/messages")) return false;
      const acc = ctx.authed(req), t = st(acc);
      if (m === "GET" && path === "/v1/messages/setup") { send(res, 200, { types: Object.keys(MTI).map((k) => ({ mti: k, name: MTI[k][0] })), fields: NUMS.map((n) => ({ n, name: F[n][0], len: F[n][2], variable: F[n][1] === "var" })), example: EXAMPLES, kinds: KINDS, faults: FAULTS.map((f) => ({ id: f.id, message: f.message })) }); return true; }
      if (m === "POST" && path === "/v1/messages/build") {
        const b = await readBody(req); guardPan(b.fields && (b.fields[2] || b.fields["2"]));
        const msg = build(String(b.mti || ""), b.fields || {}); t.did.built = true; if (b.mti === "0400") t.did.built_reversal = true; save(acc); send(res, 200, { message: msg, parsed: parse(msg) }); return true;
      }
      if (m === "POST" && path === "/v1/messages/parse") {
        const b = await readBody(req); const r = parse(b.message); t.did.parsed = true; if (r.errors.length) t.did.parsed_error = true; save(acc); send(res, 200, r); return true;
      }
      if (m === "POST" && path === "/v1/messages/convert") { const b = await readBody(req); const xml = toXml(b.message); t.did.converted = true; save(acc); send(res, 200, { xml, note: "Simplified XML-style rendering for teaching. Real standard documents have their own element names and many more fields." }); return true; }
      if (m === "POST" && path === "/v1/messages/faults/score") {
        const a = (await readBody(req)).answers; if (!a || typeof a !== "object") throw bad(400, "invalid_request", "answers must be an object of question number to option number");
        let ok = 0; const rows = FAULTS.map((f) => { const v = a[f.id] !== undefined ? a[f.id] : a[String(f.id)]; const c = Number(v) === f.a && v !== undefined && v !== ""; if (c) ok++; return { id: f.id, correct: c, answered: v !== undefined && v !== "", hint: c ? "" : "Read the parse result for this message in section 2." }; });
        const passed = ok >= 6; t.did.faults_done = true; if (passed) t.did.faults_pass = true; save(acc); send(res, 200, { correct: ok, total: rows.length, passed, rows }); return true;
      }
      return false;
    },
  };
};
