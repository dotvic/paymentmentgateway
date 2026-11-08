"use strict";
// USSD mobile money lab: a feature-phone simulator driving a menu session held on the network side, with the screen-length
// limit, session timeout, PIN lockout, lost-reply and duplicate protection, agent cash in and out, a SIM-swap exercise
// with and without a hold control, and five threat scenarios. Fictional wallet and numbers, test data only.
// Amounts are minor units (cents).

module.exports = function ({ html, ctx, UI, esc }) {
  const { send, bad, readBody, save } = ctx;
  const SHORTCODE = "*123#", MAX_CHARS = 182, SESSION_SECONDS = 60, PIN_TRIES = 3, TX_LIMIT = 50000, FEE = 30, DUP_MS = 120000;
  const MERCHANTS = { "55001": "Blue Bean Cafe", "55002": "Northwind Shop" };
  const money = (c) => (c / 100).toFixed(2);
  const st = (acc) => (acc.ussd = acc.ussd || { balance: 10000, pin: "1234", tries: 0, locked: false, swap_hold: false, sessions: {}, ledger: [], seq: 0, sid: 0, did: {}, answers: {}, lost: 0 });
  const scr = (text) => { if (text.length > MAX_CHARS) throw new Error("screen too long: " + text.length); return text; };
  const parseAmt = (s) => { if (!/^\d{1,5}(\.\d{1,2})?$/.test(String(s).trim())) return null; const c = Math.round(parseFloat(s) * 100); return c > 0 ? c : null; };
  const weakPin = (p, old) => /^(\d)\1{3}$/.test(p) || "0123456789".includes(p) || "9876543210".includes(p) || p === old;
  const MAIN = "My wallet\n1 Balance\n2 Send money\n3 Buy airtime\n4 Pay merchant\n5 My account\n0 Exit";

  function pinCheck(t, pin) {
    if (t.locked) return { ok: false, end: true, screen: "Wallet locked after wrong PINs. Visit an agent with your ID to unlock." };
    if (pin === t.pin) { t.tries = 0; return { ok: true }; }
    t.tries++; t.did.wrong_pin = true;
    if (t.tries >= PIN_TRIES) { t.locked = true; t.did.locked = true; return { ok: false, end: true, screen: "Wrong PIN. Wallet locked. Visit an agent with your ID to unlock." }; }
    return { ok: false, again: true, screen: `Wrong PIN. ${PIN_TRIES - t.tries} tries left. Enter your PIN:` };
  }
  function post(t, type, to, amount, fee) {
    if (amount + fee > t.balance) return null;
    t.balance -= amount + fee; const e = { id: "TX-" + String(++t.seq).padStart(4, "0"), type, to, amount, fee, at: Date.now(), status: "posted" }; t.ledger.push(e); return e;
  }
  const pretty = (e) => `${e.id} ${e.type} ${money(e.amount)}${e.to ? " to " + e.to : ""}`;

  // One step of the menu. Returns { screen, end?, expects? }. s = the session, i = what the user typed.
  function step(t, s, i, opts) {
    const end = (screen) => ({ screen: scr(screen), end: true }), ask = (screen, key, data) => { s.step = key; Object.assign(s.data, data || {}); return { screen: scr(screen) }; };
    i = String(i == null ? "" : i).trim();
    switch (s.step) {
      case "main":
        if (i === "1") return ask("Enter your PIN:", "bal_pin");
        if (i === "2") return ask("Send money\nEnter the recipient's number (digits only):", "send_to");
        if (i === "3") return ask("Buy airtime\nEnter amount (for example 5.00):", "air_amt");
        if (i === "4") return ask("Pay merchant\nEnter the 5-digit merchant code:", "mer_code");
        if (i === "5") return ask("My account\n1 Last 3 transactions\n2 Change PIN\n0 Back", "acct");
        if (i === "0") return end("Goodbye.");
        return { screen: scr("Invalid choice.\n" + MAIN) };
      case "bal_pin": { const p = pinCheck(t, i); if (!p.ok) return p.end ? end(p.screen) : { screen: scr(p.screen) }; return end(`Your balance is ${money(t.balance)}.`); }
      case "send_to": if (!/^\d{9,12}$/.test(i)) return { screen: scr("Invalid number. Enter 9 to 12 digits:") }; return ask("Enter amount (for example 20.00):", "send_amt", { to: i });
      case "send_amt": { const a = parseAmt(i); if (!a) return { screen: scr("Invalid amount. Enter it like 20.00:") }; if (a > TX_LIMIT) return { screen: scr(`Limit per transaction is ${money(TX_LIMIT)}. Enter a lower amount:`) }; if (a + FEE > t.balance) return end("Not enough money for this payment and fee."); s.data.amount = a;
        const dup = t.ledger.slice().reverse().find((e) => e.type === "send" && e.to === s.data.to && e.amount === a && Date.now() - e.at < DUP_MS);
        if (dup) { t.did.dup_warning = true; return ask(`You sent ${money(a)} to ${s.data.to} a moment ago (${dup.id}).\n1 Send again\n2 Cancel`, "send_dup"); }
        return ask(`Send ${money(a)} to ${s.data.to}? Fee ${money(FEE)}.\n1 Yes\n2 No`, "send_confirm"); }
      case "send_dup": if (i === "1") return ask(`Send ${money(s.data.amount)} to ${s.data.to}? Fee ${money(FEE)}.\n1 Yes\n2 No`, "send_confirm"); return end("Cancelled. Nothing was sent.");
      case "send_confirm": if (i === "1") return ask("Enter your PIN:", "send_pin"); return end("Cancelled. Nothing was sent.");
      case "send_pin": { const p = pinCheck(t, i); if (!p.ok) return p.end ? end(p.screen) : { screen: scr(p.screen) }; const e = post(t, "send", s.data.to, s.data.amount, FEE); if (!e) return end("Not enough money."); t.did.sent = true;
        if (opts.drop) { t.did.dropped = true; return { screen: null, end: true, dropped: true }; } return end(`Sent ${money(e.amount)} to ${e.to}. Fee ${money(e.fee)}. Ref ${e.id}. New balance ${money(t.balance)}.`); }
      case "air_amt": { const a = parseAmt(i); if (!a || a > 5000) return { screen: scr("Enter an amount from 0.50 to 50.00:") }; return ask("Enter your PIN:", "air_pin", { amount: a }); }
      case "air_pin": { const p = pinCheck(t, i); if (!p.ok) return p.end ? end(p.screen) : { screen: scr(p.screen) }; const e = post(t, "airtime", null, s.data.amount, 0); if (!e) return end("Not enough money."); t.did.airtime = true; return end(`Airtime ${money(e.amount)} added. Ref ${e.id}. Balance ${money(t.balance)}.`); }
      case "mer_code": if (!MERCHANTS[i]) return { screen: scr("Unknown merchant code. Check the code on the till and enter it again:") }; return ask(`Pay ${MERCHANTS[i]}\nEnter amount:`, "mer_amt", { code: i });
      case "mer_amt": { const a = parseAmt(i); if (!a || a > TX_LIMIT) return { screen: scr("Invalid amount. Enter it like 12.50:") }; return ask(`Pay ${money(a)} to ${MERCHANTS[s.data.code]}?\nEnter your PIN to confirm:`, "mer_pin", { amount: a }); }
      case "mer_pin": { const p = pinCheck(t, i); if (!p.ok) return p.end ? end(p.screen) : { screen: scr(p.screen) }; const e = post(t, "merchant", MERCHANTS[s.data.code], s.data.amount, 0); if (!e) return end("Not enough money."); t.did.merchant = true; return end(`Paid ${money(e.amount)} to ${e.to}. Ref ${e.id}. Balance ${money(t.balance)}.`); }
      case "acct":
        if (i === "1") return ask("Enter your PIN:", "hist_pin");
        if (i === "2") return ask("Enter your current PIN:", "chg_old");
        if (i === "0") { s.step = "main"; return { screen: scr(MAIN) }; } return { screen: scr("Invalid choice.\n1 Last 3 transactions\n2 Change PIN\n0 Back") };
      case "hist_pin": { const p = pinCheck(t, i); if (!p.ok) return p.end ? end(p.screen) : { screen: scr(p.screen) }; t.did.history = true; const l = t.ledger.slice(-3).reverse(); return end(l.length ? l.map(pretty).join("\n") : "No transactions yet."); }
      case "chg_old": { const p = pinCheck(t, i); if (!p.ok) return p.end ? end(p.screen) : { screen: scr(p.screen) }; return ask("Enter a new 4-digit PIN:", "chg_new"); }
      case "chg_new": if (!/^\d{4}$/.test(i) || weakPin(i, t.pin)) return { screen: scr("PIN must be 4 digits, not repeated or in sequence, and different from the old one. Try again:") }; s.data.np = i; return ask("Enter the new PIN again:", "chg_conf");
      case "chg_conf": if (i !== s.data.np) return end("The PINs did not match. PIN not changed."); t.pin = i; t.did.pin_changed = true; return end("PIN changed.");
      default: return end("Session ended.");
    }
  }

  const THREATS = [
    { id: "t1", q: "You get a text: 'Your wallet will close today. Dial *123*9*5551# to keep it.' What do you do?", opts: ["Dial it quickly", "Ignore it and contact the provider on a number you already know", "Reply with your PIN", "Forward it to friends"], a: 1, why: "A text urging a code is a phishing trick: dialling can trigger a transfer or hand over control. Use only numbers you already trust." },
    { id: "t2", q: "Your phone suddenly shows 'No service' and you get no calls, then a text says your SIM was replaced. You did not ask for it. What first?", opts: ["Wait until morning", "Call your provider from another phone at once and ask to block the new SIM and the wallet", "Buy a new phone", "Change your social media password"], a: 1, why: "A SIM swap moves your number to a criminal's SIM, and with it your wallet. Minutes matter; a hold on sending after a SIM change limits the damage." },
    { id: "t3", q: "Someone at the shop counter watches you type your PIN on the shared payment phone. What is the lesson?", opts: ["Nothing, PINs are safe", "Shield the keypad, never say your PIN aloud, and change it if you think it was seen", "Use your birthday as the PIN", "Let the cashier enter it"], a: 1, why: "A seen PIN plus a stolen or swapped SIM empties a wallet. Shield it, and change it if exposed." },
    { id: "t4", q: "An 'agent' offers to cash you out and asks you to say your PIN aloud 'to speed things up'. What do you do?", opts: ["Say it quietly", "Refuse. You enter the PIN yourself, and an agent never needs it", "Write it down", "Give your ID instead"], a: 1, why: "Only you should know your PIN. A real agent asks for your ID and has you confirm on your own phone." },
    { id: "t5", q: "You sent money but the screen froze and showed no confirmation. What should you do before sending again?", opts: ["Send again straight away", "Check your last transactions to see whether it posted", "Dial from another phone and send twice", "Ask the recipient to send it back"], a: 1, why: "The network may have posted the payment and lost the reply. Check the history first; sending again could pay twice." },
  ];

  function page() {
    const body = `<style>.k select,.k input{width:auto;display:inline-block}.ph{width:260px;max-width:100%;background:#1a1a22;border-radius:22px;padding:14px;color:#e8f5e8}.scr{background:#b8d8a8;color:#102010;font-family:ui-monospace,monospace;font-size:13px;white-space:pre-wrap;min-height:170px;padding:8px;border-radius:6px;word-break:break-word}.scr.off{opacity:.5}.t td,.t th{padding:5px 8px;border-bottom:1px solid var(--line,#e3e7ef);text-align:left;vertical-align:top}.row{display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start}pre{white-space:pre-wrap;font-size:13px}</style><div class="wrap"><h1>USSD mobile money lab</h1>
<p class="lede">USSD lets a basic phone use a bank or wallet through short text menus, with no app and no data connection. The phone is only a keypad and a screen: the network keeps the session. Dial the short code, send and pay money, lose a reply, get locked out, and try a SIM swap with and without protection. The wallet and numbers are fictional. Test data only.</p>
<div class="panel k"><div class="row"><div><div class="ph"><div id="sc" class="scr off">Dial ${SHORTCODE} to start.</div><p style="margin:8px 0 4px"><input id="in" size="14" placeholder="your reply"> <button type="button" id="rp" class="small">Send</button></p><p style="margin:4px 0"><button type="button" id="dl" class="small">Dial ${SHORTCODE}</button> <button type="button" id="en" class="small">End</button></p><p class="hint" id="cc" style="color:#bbb"></p></div>
<p class="hint"><label><input type="checkbox" id="dr"> lose the network reply on the last step</label><br><label>idle seconds before replying <input id="ids" size="3" value="0"></label></p></div>
<div style="flex:1;min-width:260px"><p><b>Balance <span id="bal"></span></b> <span class="hint" id="lk"></span></p><div id="led"></div>
<p class="hint">Agent desk: <button type="button" id="ci" class="small">Cash in 50.00</button> <button type="button" id="co" class="small">Cash out 20.00</button> <button type="button" id="ul" class="small">Unlock a locked wallet (ID checked)</button></p><pre id="ag"></pre></div></div></div>
<div class="panel k"><strong>SIM swap exercise</strong><p class="hint">A criminal gets a copy of your SIM, then dials the wallet as you. They already know your PIN from watching you. Does your wallet stop them?</p><p><label><input type="checkbox" id="sh"> Provider holds sending for 24 hours after a SIM change</label> <button type="button" id="sw" class="small">Simulate the SIM swap attack</button></p><pre id="sr"></pre></div>
<div class="panel k"><strong>Threat desk</strong><div id="th"></div></div>
<h2>What to notice</h2><ul><li>The phone holds no state. The network keeps the <b>session</b>, so a timeout or a dropped reply can leave you unsure whether money moved. Always check the history before sending again.</li><li>Screens are short (${MAX_CHARS} characters here), so menus are terse and each step does one thing.</li><li>USSD has no end-to-end encryption on the phone. Protection comes from the <b>PIN</b>, lockouts, limits, and controls such as a hold after a SIM change.</li><li>Agents turn cash into wallet money and back. They are a trusted human step, which makes them a fraud target too.</li></ul>
<p class="hint">Related: <a href="/knowledge/ussd-and-mobile-money">USSD and mobile money</a>, <a href="/knowledge/mobile-money-safety">Mobile money safety</a>, <a href="/academy/ussd-mobile-money">Course</a>.</p></div>`;
    const script = `function $(i){return document.getElementById(i);}function m(c){return (c/100).toFixed(2);}
var SID=null;async function api(a,b,c){if(!(await Z.ensureKey()))return {status:0,body:{}};return Z.api(a,b,c);}
function screen(t,off){$("sc").textContent=t;$("sc").className="scr"+(off?" off":"");$("cc").textContent=t?(t.length+" of ${MAX_CHARS} characters"):"";}
async function refresh(){var r=await api("GET","/v1/ussd");if(r.status!==200)return;$("bal").textContent=m(r.body.balance_cents);$("lk").textContent=r.body.locked?"(locked)":"";$("sh").checked=r.body.swap_hold;
$("led").innerHTML=r.body.ledger.length?'<table class="t"><tr><th>Ref</th><th>Type</th><th>Amount</th><th>To</th></tr>'+r.body.ledger.slice(-6).reverse().map(function(e){return "<tr><td>"+e.id+"</td><td>"+e.type+"</td><td>"+m(e.amount+e.fee)+"</td><td>"+Z.esc(e.to||"")+"</td></tr>";}).join("")+"</table>":"";}
function out(r){if(r.status!==200){screen(Z.msg(r),true);return;}var j=r.body;if(j.dropped){screen("(no reply received)\\nThe network lost the answer.",true);SID=null;}else{screen(j.screen,j.end);if(j.end)SID=null;}$("in").value="";refresh();}
$("dl").onclick=async function(){out(await api("POST","/v1/ussd/dial",{code:"${SHORTCODE}"}).then(function(r){if(r.status===200)SID=r.body.session_id;return r;}));};
$("rp").onclick=async function(){if(!SID){screen("No session. Dial ${SHORTCODE}.",true);return;}var r=await api("POST","/v1/ussd/reply",{session_id:SID,input:$("in").value,drop_reply:$("dr").checked,idle_seconds:parseInt($("ids").value,10)||0});if(r.status===200&&r.body.end)SID=null;out(r);};
$("in").onkeydown=function(e){if(e.key==="Enter")$("rp").onclick();};$("en").onclick=function(){SID=null;screen("Session ended.",true);};
$("ci").onclick=async function(){$("ag").textContent=JSON.stringify((await api("POST","/v1/ussd/agent",{kind:"in",amount_cents:5000,agent_code:"AG-204"})).body,null,1);refresh();};
$("co").onclick=async function(){$("ag").textContent=JSON.stringify((await api("POST","/v1/ussd/agent",{kind:"out",amount_cents:2000,agent_code:"AG-204"})).body,null,1);refresh();};
$("ul").onclick=async function(){$("ag").textContent=JSON.stringify((await api("POST","/v1/ussd/agent/unlock",{agent_code:"AG-204",id_checked:true})).body,null,1);refresh();};
$("sh").onchange=async function(){await api("POST","/v1/ussd/settings",{swap_hold:$("sh").checked});};
$("sw").onclick=async function(){await api("POST","/v1/ussd/settings",{swap_hold:$("sh").checked});var r=await api("POST","/v1/ussd/sim-swap",{});$("sr").textContent=JSON.stringify(r.body,null,1);refresh();};
async function threats(){var r=await api("GET","/v1/ussd/threats");if(r.status!==200)return;$("th").innerHTML=r.body.threats.map(function(t){return '<div class="panel"><p><b>'+Z.esc(t.q)+'</b></p>'+t.options.map(function(o,i){return '<div><button type="button" class="small" data-i="'+t.id+'" data-o="'+i+'">'+Z.esc(o)+'</button></div>';}).join("")+'<p id="a-'+t.id+'" class="hint">'+(t.answered?(t.answered.correct?"Answered correctly.":"Answered wrongly. Try again to see why."):"")+'</p></div>';}).join("");}
$("th").onclick=async function(e){var b=e.target.closest("button");if(!b)return;var r=await api("POST","/v1/ussd/threats/"+b.dataset.i+"/answer",{choice:parseInt(b.dataset.o,10)});$("a-"+b.dataset.i).innerHTML=r.status===200?("<b>"+(r.body.correct?"Correct. ":"Not quite. ")+"</b>"+Z.esc(r.body.why)):Z.esc(Z.msg(r));};
if(Z.hasKey()){refresh();threats();}else screen("Create a test key to start.",true);`;
    return UI.shell({ title: "USSD mobile money lab – Zanboxx", description: "Drive a USSD menu on a feature-phone simulator: send money, lose a reply, get locked out, try a SIM swap with and without protection, and judge five threat scenarios.", active: "labs", body, script });
  }

  return {
    async handle(req, res, path, m) {
      if (m === "GET" && path === "/labs/ussd") { html(res, 200, page()); return true; }
      if (!path.startsWith("/v1/ussd")) return false;
      const acc = ctx.authed(req), t = st(acc);
      if (m === "GET" && path === "/v1/ussd") { send(res, 200, { balance_cents: t.balance, locked: t.locked, swap_hold: t.swap_hold, limits: { per_transaction_cents: TX_LIMIT, session_seconds: SESSION_SECONDS, pin_tries: PIN_TRIES, screen_chars: MAX_CHARS }, ledger: t.ledger.map((e) => ({ id: e.id, type: e.type, to: e.to, amount: e.amount, fee: e.fee, status: e.status })), lost_cents: t.lost }); return true; }
      if (m === "POST" && path === "/v1/ussd/dial") {
        const code = String((await readBody(req)).code || "").trim();
        if (code !== SHORTCODE) { save(acc); send(res, 200, { session_id: null, screen: "Connection problem or invalid MMI code.", end: true }); return true; }
        const id = "S" + ++t.sid; t.sessions[id] = { step: "main", data: {}, at: Date.now() }; for (const k of Object.keys(t.sessions)) if (k !== id && Object.keys(t.sessions).length > 5) delete t.sessions[k];
        t.did.dialled = true; save(acc); send(res, 200, { session_id: id, screen: MAIN, end: false }); return true;
      }
      if (m === "POST" && path === "/v1/ussd/reply") {
        const b = await readBody(req), s = t.sessions[b.session_id]; if (!s) throw bad(404, "no_session", "No such session. Dial the short code again.");
        const idle = Math.max(Number(b.idle_seconds) || 0, 0);
        if (idle > SESSION_SECONDS || Date.now() - s.at > SESSION_SECONDS * 1000) { delete t.sessions[b.session_id]; t.did.timeout = true; save(acc); send(res, 200, { screen: "Session timed out. Nothing was done. Dial again.", end: true, timed_out: true }); return true; }
        const r = step(t, s, b.input, { drop: !!b.drop_reply }); s.at = Date.now(); if (r.end) delete t.sessions[b.session_id]; save(acc);
        send(res, 200, { screen: r.screen, end: !!r.end, dropped: !!r.dropped }); return true;
      }
      if (m === "POST" && path === "/v1/ussd/agent") {
        const b = await readBody(req); if (b.agent_code !== "AG-204") throw bad(403, "unknown_agent", "Unknown agent code. Check the code on the agent's sign.");
        if (!Number.isInteger(b.amount_cents) || b.amount_cents < 1 || b.amount_cents > 200000) throw bad(400, "invalid_request", "amount_cents must be a positive whole number up to 2000.00");
        if (b.kind === "in") { t.balance += b.amount_cents; t.did.cash_in = true; save(acc); send(res, 200, { status: "done", kind: "in", balance_cents: t.balance }); return true; }
        if (b.kind === "out") { if (b.amount_cents > t.balance) throw bad(422, "insufficient_funds", "Not enough in the wallet."); t.balance -= b.amount_cents; t.did.cash_out = true; save(acc); send(res, 200, { status: "done", kind: "out", balance_cents: t.balance }); return true; }
        throw bad(400, "invalid_request", "kind must be in or out");
      }
      if (m === "POST" && path === "/v1/ussd/agent/unlock") { const b = await readBody(req); if (!b.id_checked) throw bad(422, "id_required", "An agent must check your ID before unlocking."); if (!t.locked) throw bad(409, "not_locked", "The wallet is not locked."); t.locked = false; t.tries = 0; t.did.unlocked = true; save(acc); send(res, 200, { status: "unlocked", note: "You will be asked to choose a new PIN." }); return true; }
      if (m === "POST" && path === "/v1/ussd/settings") { const b = await readBody(req); t.swap_hold = !!b.swap_hold; save(acc); send(res, 200, { swap_hold: t.swap_hold }); return true; }
      if (m === "POST" && path === "/v1/ussd/sim-swap") {
        const tried = Math.min(TX_LIMIT, t.balance);
        if (t.swap_hold) { t.did.swap_blocked = true; save(acc); send(res, 200, { attacker_tried_cents: tried, blocked: true, lost_cents: 0, note: "The provider saw a recent SIM change and held sending for 24 hours. The customer got an alert on the old channel." }); return true; }
        t.balance -= tried; t.lost += tried; t.did.swap_drained = true; t.ledger.push({ id: "TX-" + String(++t.seq).padStart(4, "0"), type: "send", to: "0799000111", amount: tried, fee: 0, at: Date.now(), status: "posted" });
        save(acc); send(res, 200, { attacker_tried_cents: tried, blocked: false, lost_cents: tried, balance_cents: t.balance, note: "With no hold, the attacker's SIM and the PIN were enough. Turn on the hold and try again." }); return true;
      }
      if (m === "GET" && path === "/v1/ussd/threats") { send(res, 200, { threats: THREATS.map((x) => ({ id: x.id, q: x.q, options: x.opts, answered: t.answers[x.id] || null })) }); return true; }
      const g = path.match(/^\/v1\/ussd\/threats\/(t\d)\/answer$/);
      if (m === "POST" && g) {
        const x = THREATS.find((y) => y.id === g[1]); if (!x) throw bad(404, "not_found", "No such scenario");
        const c = (await readBody(req)).choice; if (!Number.isInteger(c) || c < 0 || c >= x.opts.length) throw bad(400, "invalid_request", "choice must be one of the option numbers");
        const correct = c === x.a; t.answers[x.id] = { correct }; const ok = Object.values(t.answers).filter((y) => y.correct).length; if (ok >= THREATS.length) t.did.threats_all = true;
        save(acc); send(res, 200, { correct, why: x.why, scenarios_correct: ok, of: THREATS.length }); return true;
      }
      return false;
    },
  };
};
