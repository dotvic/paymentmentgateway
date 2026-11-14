"use strict";
// Transaction types lab: every card transaction type on a debit side (money leaves the cardholder) and a credit side
// (money goes back, or a debit is cancelled), with a ledger view, a sequence runner and a scenario quiz.
// A teaching model: all amounts, fees and rules are invented. Answer keys stay on the server.

module.exports = function ({ html, ctx, UI, esc }) {
  const { send, bad, readBody, save } = ctx;
  const st = (acc) => (acc.types = acc.types || { did: {}, viewed: {} });

  // side: debit = money leaves the cardholder. credit = money goes back, or a debit is undone.
  const TYPES = [
    { id: "purchase", side: "debit", name: "Purchase (sale)", channels: "Card present and online", summary: "Authorise and capture in one step. The standard way to pay for goods that are handed over now.", effect: "Reserves the amount, then collects it at the end of the day or batch.", fees: "Normal pricing applies to the full amount.", disputes: "Can be disputed in the usual windows." },
    { id: "preauth", side: "debit", name: "Pre-authorisation", channels: "Card present and online", summary: "Reserves money when the final amount is not known yet, such as a hotel stay or a car rental.", effect: "Holds funds on the card. Nothing is collected until a completion.", fees: "No sale fee until completion. Holds that are never completed expire.", disputes: "A hold alone moves no money, so there is nothing to dispute until completion." },
    { id: "incremental", side: "debit", name: "Incremental authorisation", channels: "Mostly online and hospitality", summary: "Raises the amount of an open pre-authorisation, for example when a guest stays another night.", effect: "Adds to the hold. Still nothing collected.", fees: "None until completion.", disputes: "Make sure the buyer agreed to the higher amount." },
    { id: "completion", side: "debit", name: "Completion (capture)", channels: "Card present and online", summary: "Collects the money that a pre-authorisation reserved. The amount can be lower than the hold but not higher.", effect: "Turns the hold into a sale and releases any difference.", fees: "Fees apply to the amount collected.", disputes: "Disputable like a sale." },
    { id: "tip_adjust", side: "debit", name: "Tip adjustment", channels: "Card present, restaurants and services", summary: "Adds a tip to a sale after the slip is signed, before the batch closes.", effect: "Raises the captured amount. Possible only while the sale is still open.", fees: "Fee applies to the new total.", disputes: "Keep the signed slip. A large jump invites questions." },
    { id: "cash_advance", side: "debit", name: "Cash advance", channels: "Bank counter and ATM", summary: "Cash taken against a credit card.", effect: "Money leaves the card immediately, interest usually starts at once and a fee is added.", fees: "A cash fee, usually higher than a sale.", disputes: "Hard to dispute: cash was handed over." },
    { id: "cashback", side: "debit", name: "Purchase with cashback", channels: "Card present, shops with a debit card", summary: "A purchase plus cash handed over at the till.", effect: "The card is charged for goods plus cash. The shop reclaims the cash through settlement.", fees: "Cash part is usually treated differently from the goods part.", disputes: "The cash part cannot be returned like goods." },
    { id: "quasi_cash", side: "debit", name: "Quasi-cash", channels: "Card present and online", summary: "Buying something that is as good as cash, such as casino chips, money orders or prepaid value.", effect: "Charged like a sale but treated as cash for fees and rules.", fees: "Higher than a normal sale. Often not eligible for rewards.", disputes: "Treated as high risk by issuers." },
    { id: "recurring", side: "debit", name: "Recurring or instalment", channels: "Online, merchant-initiated", summary: "Later payments taken from a card the buyer agreed to store, such as a subscription.", effect: "Each payment is a debit started by the merchant with no buyer present.", fees: "Normal pricing. Failures should not be retried blindly.", disputes: "Common dispute: buyer forgot or cancelled. Keep the consent record." },
    { id: "verification", side: "debit", name: "Account verification", channels: "Online and card present", summary: "A zero-amount check that the card is valid, used before saving a card or starting a subscription.", effect: "No money moves and no hold is placed.", fees: "A small check fee at most.", disputes: "Nothing to dispute." },
    { id: "refund", side: "credit", name: "Refund (purchase return)", channels: "Card present and online", summary: "Sends money back to the cardholder after a sale has cleared.", effect: "A credit to the cardholder, funded from the merchant's next settlement.", fees: "The original fee is often not returned, so refunds cost the merchant.", disputes: "Refunding quickly can avoid a chargeback." },
    { id: "oct", side: "credit", name: "Original credit (payout to card)", channels: "Online, platforms and marketplaces", summary: "Sending money to a card without an earlier sale, such as paying out a seller or a winner.", effect: "Credit to the cardholder, debited from the sender.", fees: "A payout fee. Often needs prior approval from the acquirer.", disputes: "Funds are hard to recover, so scams use it." },
    { id: "chargeback", side: "credit", name: "Chargeback (dispute credit)", channels: "Issuer initiated", summary: "The issuer returns money to the cardholder and reclaims it from the merchant.", effect: "Money moves back to the cardholder and out of the merchant's account, plus a fee.", fees: "A dispute fee, win or lose in many setups.", disputes: "You can answer with evidence. See the Dispute evidence lab." },
    { id: "representment", side: "credit", name: "Representment (merchant's answer)", channels: "Merchant initiated", summary: "The merchant's reply to a chargeback with evidence.", effect: "If it wins, the money returns to the merchant. If it loses, the chargeback stands.", fees: "Process cost, and sometimes a fee.", disputes: "Quality of evidence decides it." },
    { id: "void", side: "credit", name: "Void", channels: "Card present and online", summary: "Cancels a transaction before it clears. It undoes a debit, so it counts on the credit side without sending money.", effect: "Releases the hold and no money ever moves.", fees: "Normally no fee. Cheaper than a refund.", disputes: "Only possible before settlement." },
    { id: "reversal", side: "credit", name: "Reversal", channels: "Card present and online", summary: "A technical undo when a transaction did not complete cleanly, such as a time-out with no reply.", effect: "Releases the hold so the buyer is not charged for a payment that did not finish.", fees: "No fee.", disputes: "Failing to send one can leave the buyer charged with no goods." },
  ];
  const T = Object.fromEntries(TYPES.map((t) => [t.id, t]));

  // Ledger stages for a 100.00 payment. Columns: cardholder available, cardholder hold, merchant pending, merchant balance. Start: 500.00 and 0.
  const FEE = 1.5;
  const LED = {
    purchase: [["Start", 500, 0, 0, 0, "The cardholder has 500.00. The merchant has nothing."], ["Authorised", 400, 100, 0, 0, "100.00 is held. The merchant is not paid yet."], ["Captured", 400, 0, 100, 0, "The hold becomes a sale in the merchant's batch."], ["Cleared and settled", 400, 0, 0, 98.5, "The merchant receives 100.00 minus a 1.50 fee (invented)."]],
    preauth: [["Start", 500, 0, 0, 0, "Nothing yet."], ["Authorised", 400, 100, 0, 0, "A hold only. The merchant has no money."], ["Hold expires (never completed)", 500, 0, 0, 0, "No completion arrived, so the hold lapses and the cardholder gets it back."]],
    incremental: [["Authorised for 100.00", 400, 100, 0, 0, "Opening hold."], ["Incremental +40.00", 360, 140, 0, 0, "The hold grows. Still no money moves to the merchant."], ["Completed for 140.00", 360, 0, 140, 0, "Collected in full."]],
    completion: [["Hold of 140.00", 360, 140, 0, 0, "From an earlier pre-authorisation."], ["Completed for 120.00", 380, 0, 120, 0, "The 20.00 difference is released to the cardholder."], ["Settled", 380, 0, 0, 118.2, "The merchant is paid 120.00 minus a 1.80 fee."]],
    tip_adjust: [["Sale captured for 100.00", 400, 0, 100, 0, "Slip signed, batch still open."], ["Tip +15.00 added", 385, 0, 115, 0, "The captured amount rises to 115.00."], ["Settled", 385, 0, 0, 113.3, "Paid 115.00 minus a 1.70 fee."]],
    cash_advance: [["Start", 500, 0, 0, 0, "A credit card with 500.00 available."], ["Cash advance 100.00", 397, 0, 0, 0, "100.00 plus a 3.00 cash fee. Interest starts at once in a real credit product."]],
    cashback: [["Basket 40.00 plus 20.00 cash", 440, 60, 0, 0, "The card is held for 60.00 in total."], ["Captured", 440, 0, 60, 0, "The shop handed over 20.00 in cash."], ["Settled", 440, 0, 0, 59.4, "The shop is reimbursed 60.00 less a fee on the goods part only (invented)."]],
    quasi_cash: [["Chips bought for 100.00", 400, 100, 0, 0, "A hold, flagged as cash-like."], ["Settled", 400, 0, 0, 97, "Paid 100.00 minus a higher 3.00 fee."]],
    recurring: [["First payment, buyer present", 400, 0, 0, 98.5, "The buyer agrees to store the card."], ["Month 2, merchant-initiated", 300, 0, 0, 197, "No buyer present. Consent was captured at the start."], ["Month 3, merchant-initiated", 200, 0, 0, 295.5, "The record of consent is what protects you in a dispute."]],
    verification: [["Zero-amount check", 500, 0, 0, 0, "The card is confirmed valid. No money moved and no hold was placed."]],
    refund: [["Sale settled", 400, 0, 0, 98.5, "After clearing."], ["Refund of 100.00 requested", 400, 0, 0, 98.5, "A credit is sent to the card network."], ["Refunded", 500, 0, 0, -1.5, "The cardholder gets 100.00 back. The merchant is left 1.50 down because the fee is not returned in this model."]],
    oct: [["Start", 500, 0, 0, 0, "The recipient's card has 500.00."], ["Payout of 100.00 sent", 600, 0, 0, -100, "The sender is debited 100.00 and the card receives it."]],
    chargeback: [["Sale settled", 400, 0, 0, 98.5, "A normal sale."], ["Dispute opened", 500, 0, 0, -16.5, "The issuer returns 100.00 to the buyer and takes it back from the merchant, with a 15.00 dispute fee."]],
    representment: [["After chargeback", 500, 0, 0, -16.5, "The merchant is down 100.00 and the fee."], ["Evidence wins", 400, 0, 0, 98.5, "The chargeback is reversed. The dispute fee comes back in this model."]],
    void: [["Authorised", 400, 100, 0, 0, "100.00 held."], ["Voided before clearing", 500, 0, 0, 0, "The hold is released. No money ever moved."]],
    reversal: [["Sale sent, no reply received", 400, 100, 0, 0, "The terminal timed out. It is unknown whether the host recorded it."], ["Reversal sent", 500, 0, 0, 0, "The host cancels the half-finished transaction and the hold drops."]],
  };

  // Sequence runner on one order.
  const MAXA = 100000, ALLOW = ["preauth", "incremental", "completion", "purchase", "tip_adjust", "void", "reversal", "settle", "refund", "cash_advance", "verification", "oct", "chargeback", "representment"];
  const r2 = (x) => Math.round(x * 100) / 100;
  function runSeq(steps) {
    if (!Array.isArray(steps) || !steps.length || steps.length > 12) throw bad(400, "invalid_request", "steps must be a list of 1 to 12 steps");
    const o = { held: 0, captured: 0, settled: false, refunded: 0, chargeback: 0, credited: 0, fees: 0, cash: 0 };
    const out = []; const flags = {};
    for (const [i, s] of steps.entries()) {
      const type = s && s.type; if (!ALLOW.includes(type)) throw bad(400, "invalid_request", `Step ${i + 1}: type must be one of ${ALLOW.join(", ")}`);
      const a = s.amount === undefined ? 0 : Number(s.amount);
      const needs = !["void", "reversal", "settle", "verification", "representment"].includes(type);
      if (!Number.isFinite(a) || a < 0 || a > MAXA || (needs && a <= 0)) throw bad(400, "invalid_request", `Step ${i + 1}: amount must be greater than 0 and no more than ${MAXA}`);
      let ok = true, msg = "";
      const fail = (m) => { ok = false; msg = m; };
      const empty = o.held === 0 && o.captured === 0 && !o.settled;
      switch (type) {
        case "preauth": if (!empty) fail("An order is already open."); else { o.held = a; msg = `Held ${a.toFixed(2)}. Nothing collected yet.`; } break;
        case "incremental": if (o.held <= 0 || o.captured > 0) fail("There is no open pre-authorisation to raise."); else { o.held = r2(o.held + a); msg = `Hold raised to ${o.held.toFixed(2)}.`; } break;
        case "completion": if (o.held <= 0) fail("There is no hold to complete."); else if (a > o.held) fail(`You cannot collect more than the hold of ${o.held.toFixed(2)}. Raise the hold first.`); else { msg = `Collected ${a.toFixed(2)}.` + (a < o.held ? ` Released ${r2(o.held - a).toFixed(2)}.` : ""); o.captured = a; o.held = 0; } break;
        case "purchase": if (!empty) fail("An order is already open."); else { o.captured = a; msg = `Sale of ${a.toFixed(2)} captured.`; } break;
        case "tip_adjust": if (o.captured <= 0 || o.settled) fail("A tip can only be added to an open sale that has not been settled."); else if (a > o.captured * 0.25) fail(`The tip is above the 25 percent limit in this model (${r2(o.captured * 0.25).toFixed(2)}).`); else { o.captured = r2(o.captured + a); msg = `Tip added. Sale is now ${o.captured.toFixed(2)}.`; } break;
        case "void": if (o.settled) fail("The sale has already settled. Use a refund instead."); else if (o.held <= 0 && o.captured <= 0) fail("There is nothing to void."); else { o.held = 0; o.captured = 0; msg = "Cancelled before clearing. No money moved."; } break;
        case "reversal": if (o.settled) fail("The transaction has already settled. A reversal is only for an unfinished one."); else if (o.held <= 0 && o.captured <= 0) fail("There is nothing to reverse."); else { o.held = 0; o.captured = 0; msg = "Technical undo sent. The hold is released."; } break;
        case "settle": if (o.captured <= 0) fail("Nothing has been captured, so there is nothing to settle."); else if (o.settled) fail("Already settled."); else { o.settled = true; o.fees = r2(o.fees + r2(o.captured * 0.015)); msg = `Cleared and settled. Fee ${r2(o.captured * 0.015).toFixed(2)}.`; } break;
        case "refund": if (!o.settled) fail("The sale has not cleared yet. Void it instead: it is cheaper and faster."); else if (r2(o.refunded + a) > r2(o.captured - o.chargeback)) fail(`You cannot refund more than was collected (${r2(o.captured - o.refunded - o.chargeback).toFixed(2)} left).`); else { o.refunded = r2(o.refunded + a); msg = `Refunded ${a.toFixed(2)}.`; } break;
        case "cash_advance": if (!empty) fail("An order is already open."); else { const fee = Math.max(2, r2(a * 0.03)); o.cash = a; o.fees = r2(o.fees + fee); msg = `Cash ${a.toFixed(2)} given. Cash fee ${fee.toFixed(2)}.`; } break;
        case "verification": msg = "Card checked. No money moved and no hold was placed."; break;
        case "oct": if (!empty) fail("An order is already open."); else { o.credited = a; msg = `Payout of ${a.toFixed(2)} sent to the card.`; } break;
        case "chargeback": if (!o.settled) fail("A chargeback needs a settled sale."); else if (a > r2(o.captured - o.refunded - o.chargeback)) fail("A chargeback cannot exceed what is still unrefunded."); else { o.chargeback = r2(o.chargeback + a); o.fees = r2(o.fees + 15); msg = `The issuer pulled back ${a.toFixed(2)} and charged a 15.00 dispute fee.`; } break;
        case "representment": if (o.chargeback <= 0) fail("There is no chargeback to answer."); else if (s.evidence === true) { msg = `Evidence accepted. ${o.chargeback.toFixed(2)} returned and the dispute fee refunded.`; o.chargeback = 0; o.fees = r2(o.fees - 15); } else { msg = "Sent without evidence. The chargeback stands."; } break;
      }
      out.push({ step: i + 1, type, name: T[type] ? T[type].name : "Clearing and settlement", amount: a, ok, message: msg || "Rejected" });
      if (!ok) flags[type + "_blocked"] = true;
    }
    const merchant = r2(o.captured - o.refunded - o.chargeback - o.fees - o.cash * 0 - o.credited);
    const cardholder = r2(-(o.captured - o.refunded - o.chargeback) - o.cash + o.credited);
    return { results: out, order: { held: o.held, captured: o.captured, refunded: o.refunded, chargeback: o.chargeback, settled: o.settled, fees: o.fees },
      cardholder_net: cardholder, merchant_net: o.settled || o.credited || o.cash ? merchant : r2(0 + merchant), note: "Net figures count only collected money. Holds are shown separately.", flags, okAll: out.every((x) => x.ok) };
  }

  // Scenario quiz
  const SC = [
    ["A hotel checks a guest in and does not know the final bill yet.", "preauth", "The amount is unknown, so reserve with a pre-authorisation and collect later."],
    ["The guest extends the stay by two nights while the hold is open.", "incremental", "The open hold is raised. Nothing is collected yet."],
    ["At check-out the final bill is 340.00 against a hold of 400.00.", "completion", "Collect what was spent. The extra 60.00 is released."],
    ["A customer pays 20.00 for a book and walks out with it.", "purchase", "The goods are handed over now, so authorise and capture together."],
    ["A diner signs the slip, then adds a tip before the restaurant closes its batch.", "tip_adjust", "A tip can be added while the sale is still open."],
    ["A cashier rang a drink twice. It is the same shift and the batch is open.", "void", "Before clearing, cancel it. No fee and no money moves."],
    ["A terminal shows a time-out. The shop does not know whether the host recorded the sale.", "reversal", "A reversal cleans up an unfinished transaction so the buyer is not charged for nothing."],
    ["A buyer returns trousers three days later. The sale settled yesterday.", "refund", "After settlement the way back is a refund."],
    ["A streaming service takes month two of a plan the buyer agreed to.", "recurring", "A later merchant-initiated debit under stored consent."],
    ["An app wants to confirm a card is valid before saving it. It must not charge anything.", "verification", "A zero-amount check moves no money."],
    ["A traveller gets cash at a bank counter using a credit card.", "cash_advance", "Cash against a credit card. Fees and interest apply at once."],
    ["A supermarket customer buys groceries and takes 30.00 cash out at the till.", "cashback", "A purchase plus cash handed over at the till."],
    ["A customer buys casino chips with a card.", "quasi_cash", "Something as good as cash is treated as quasi-cash with higher fees."],
    ["A marketplace pays a seller's earnings straight to their debit card.", "oct", "Money is sent to a card with no earlier sale."],
    ["A cardholder tells their bank they never received goods and the bank takes the money back from the merchant.", "chargeback", "The issuer reverses the debit and reclaims it with a dispute."],
    ["The merchant answers that dispute with delivery proof and signed receipt.", "representment", "The merchant's reply, with evidence, to a chargeback."],
    ["A shop captured a sale in error this morning. It has not settled yet.", "void", "Still before settlement, so void rather than refund."],
    ["A buyer pre-authorised 100.00 but only 60.00 of goods ship.", "completion", "Collect 60.00. The rest of the hold is released."],
  ];
  const SCEN = SC.map((s, i) => ({ id: i + 1, text: s[0], answer: s[1], why: s[2] }));

  function page() {
    const body = `<style>.tg{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin:10px 0}.tc{border:1px solid var(--line,#e3e7ef);border-radius:10px;padding:10px 12px;cursor:pointer;background:rgba(255,255,255,.5)}.tc:hover,.tc.on{border-color:#3b6cff}.tc .sd{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--mute,#5b6478)}.tc.credit .sd{color:#1b7a3d}.tc.debit .sd{color:#b3261e}.fb button.on{outline:2px solid #3b6cff}.t td,.t th{padding:5px 8px;border-bottom:1px solid var(--line,#e3e7ef);text-align:left;vertical-align:top}.srow{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:4px 0}.srow select,.srow input[type=number]{width:auto;max-width:calc(100vw - 80px)}#td,#sres,#qres{overflow-x:auto}#td .t,#sres .t,#qres .t{display:table;width:100%}.bad{color:#b3261e}.good{color:#1b7a3d}.sc{padding:8px 0;border-bottom:1px solid var(--line,#e3e7ef)}.sc select{max-width:calc(100vw - 80px)}</style><div class="wrap"><h1>Transaction types</h1>
<p class="lede">Every card transaction either takes money from the cardholder (a <b>debit</b>) or gives it back (a <b>credit</b>). This is separate from whether the card itself is a debit card or a credit card. Explore each type, watch the balances move, run your own sequences, then test yourself. A teaching model: all amounts, fees and rules are invented, and you use test data only.</p>
<p class="hint" id="top"></p>
<div class="panel"><strong>1. Type map</strong><p class="hint">Pick a type to see what it does and how the money moves.</p><p class="fb"><button type="button" data-s="all" class="on">All</button> <button type="button" data-s="debit">Debit: money out</button> <button type="button" data-s="credit">Credit: money back</button></p><div class="tg" id="tg"></div><div id="td"></div></div>
<div class="panel"><strong>2. Sequence runner</strong><p class="hint">Build a series of steps on one order and see which are allowed. Try a void after settlement, or a refund before it.</p><p>Examples: <button type="button" data-p="hotel">Hotel stay</button> <button type="button" data-p="cancel">Cancel after settlement</button> <button type="button" data-p="return">Return after settlement</button> <button type="button" data-p="dispute">Dispute and answer</button></p><div id="sq"></div><p><button type="button" id="add">Add step</button> <button type="button" id="go">Run</button> <button type="button" id="clr">Clear</button> <span class="hint" id="sm"></span></p><div id="sres"></div></div>
<div class="panel"><strong>3. Which type is it?</strong><p class="hint">Eighteen real-life situations. Pick the transaction type for each, then score yourself.</p><div id="sc"></div><p><button type="button" id="qgo">Score</button> <span class="hint" id="qm"></span></p><div id="qres"></div></div>
<p class="hint">Related: <a href="/knowledge/debit-and-credit-transaction-types">Debit and credit transaction types</a>, <a href="/academy/transaction-types">Transaction types course</a>, <a href="/labs/terminal">Terminal messaging</a>, <a href="/labs/evidence">Dispute evidence pack</a>.</p></div>`;
    const script = `function $(i){return document.getElementById(i);}async function api(a,b,c){if(!(await Z.ensureKey()))return {status:0,body:{}};return Z.api(a,b,c);}
var CAT=[],SIDE="all",SQ=[],SCN=[],PRE={hotel:[["preauth",100],["incremental",40],["completion",120],["settle",0]],cancel:[["purchase",100],["settle",0],["void",0],["refund",100]],"return":[["purchase",100],["settle",0],["refund",100]],dispute:[["purchase",100],["settle",0],["chargeback",100],["representment",0,true]]};
function opts(sel){return CAT.map(function(t){return '<option value="'+t.id+'"'+(t.id===sel?" selected":"")+">"+Z.esc(t.name)+"</option>";}).join("")+'<option value="settle"'+(sel==="settle"?" selected":"")+">Clearing and settlement (not a type)</option>";}
function drawCat(){$("tg").innerHTML=CAT.filter(function(t){return SIDE==="all"||t.side===SIDE;}).map(function(t){return '<div class="tc '+t.side+'" data-id="'+t.id+'" tabindex="0" role="button"><span class="sd">'+(t.side==="debit"?"Debit":"Credit")+"</span><br><b>"+Z.esc(t.name)+"</b><br>"+Z.esc(t.summary)+"</div>";}).join("");}
async function load(){var r=await api("GET","/v1/types/catalog");if(r.status!==200){$("top").textContent=Z.msg(r);return;}CAT=r.body.types;drawCat();addRow("preauth",100);}
document.querySelector(".fb").onclick=function(e){var s=e.target.getAttribute&&e.target.getAttribute("data-s");if(!s)return;SIDE=s;[].slice.call(document.querySelectorAll(".fb button")).forEach(function(b){b.className=b.getAttribute("data-s")===s?"on":"";});drawCat();};
async function show(id){var t=CAT.filter(function(x){return x.id===id;})[0];var r=await api("GET","/v1/types/ledger/"+id);if(r.status!==200){$("top").textContent=Z.msg(r);return;}
$("td").innerHTML="<h3>"+Z.esc(t.name)+' <small>('+(t.side==="debit"?"debit":"credit")+")</small></h3><p>"+Z.esc(t.summary)+"</p><ul><li><b>Where:</b> "+Z.esc(t.channels)+"</li><li><b>What happens:</b> "+Z.esc(t.effect)+"</li><li><b>Fees:</b> "+Z.esc(t.fees)+"</li><li><b>Disputes:</b> "+Z.esc(t.disputes)+'</li></ul><p class="hint">A 100.00 example. The cardholder starts with 500.00.</p><table class="t"><tr><th>Stage</th><th>Cardholder available</th><th>Held</th><th>Merchant pending</th><th>Merchant paid</th><th>What happened</th></tr>'+r.body.stages.map(function(s){return "<tr><td>"+Z.esc(s.stage)+"</td><td>"+s.cardholder_available.toFixed(2)+"</td><td>"+s.cardholder_hold.toFixed(2)+"</td><td>"+s.merchant_pending.toFixed(2)+"</td><td>"+s.merchant_balance.toFixed(2)+"</td><td>"+Z.esc(s.note)+"</td></tr>";}).join("")+"</table>";$("td").scrollIntoView({block:"nearest"});}
$("tg").onclick=function(e){var c=e.target.closest&&e.target.closest(".tc");if(c)show(c.getAttribute("data-id"));};
$("tg").onkeydown=function(e){if(e.key==="Enter"||e.key===" "){var c=e.target.closest&&e.target.closest(".tc");if(c){e.preventDefault();show(c.getAttribute("data-id"));}}};
function addRow(t,a,ev){var d=document.createElement("div");d.className="srow";d.innerHTML="<select>"+opts(t)+'</select><input type="number" min="0" step="0.01" value="'+(a||0)+'" aria-label="Amount"><label><input type="checkbox"'+(ev?" checked":"")+'> evidence</label><button type="button" class="rm">Remove</button>';$("sq").appendChild(d);}
$("add").onclick=function(){addRow("purchase",50);};$("clr").onclick=function(){$("sq").innerHTML="";$("sres").innerHTML="";};
$("sq").onclick=function(e){if(e.target.className==="rm")e.target.parentNode.parentNode.removeChild(e.target.parentNode);};
document.querySelectorAll("[data-p]").forEach(function(b){b.onclick=function(){$("sq").innerHTML="";PRE[b.getAttribute("data-p")].forEach(function(s){addRow(s[0],s[1],s[2]);});$("go").click();};});
$("go").onclick=async function(){var steps=[].slice.call(document.querySelectorAll("#sq .srow")).map(function(r){return {type:r.querySelector("select").value,amount:parseFloat(r.querySelector("input[type=number]").value)||0,evidence:r.querySelector("input[type=checkbox]").checked};});var r=await api("POST","/v1/types/sequence",{steps:steps});if(r.status!==200){$("sm").textContent=Z.msg(r);return;}$("sm").textContent="";var j=r.body;
$("sres").innerHTML='<table class="t"><tr><th>#</th><th>Step</th><th>Amount</th><th>Result</th></tr>'+j.results.map(function(x){return "<tr><td>"+x.step+"</td><td>"+Z.esc(x.name)+"</td><td>"+x.amount.toFixed(2)+'</td><td class="'+(x.ok?"good":"bad")+'">'+(x.ok?"OK. ":"Blocked. ")+Z.esc(x.message)+"</td></tr>";}).join("")+"</table><p>Cardholder net: <b>"+j.cardholder_net.toFixed(2)+"</b>. Merchant net after fees: <b>"+j.merchant_net.toFixed(2)+"</b>. Still held: "+j.order.held.toFixed(2)+". Fees: "+j.order.fees.toFixed(2)+".</p>";};
async function loadSc(){var r=await api("GET","/v1/types/scenarios");if(r.status!==200)return;SCN=r.body.scenarios;$("sc").innerHTML=SCN.map(function(s){return '<div class="sc"><b>'+s.id+".</b> "+Z.esc(s.text)+'<br><select data-s="'+s.id+'"><option value="">Choose...</option>'+opts("")+"</select></div>";}).join("");}
$("qgo").onclick=async function(){var a={};[].slice.call(document.querySelectorAll("#sc select")).forEach(function(s){a[s.getAttribute("data-s")]=s.value;});var r=await api("POST","/v1/types/scenarios/score",{answers:a});if(r.status!==200){$("qm").textContent=Z.msg(r);return;}$("qm").textContent="";var j=r.body;
$("qres").innerHTML='<h3 class="'+(j.passed?"good":"bad")+'">'+j.correct+" of "+j.total+(j.passed?": passed":": try again (15 to pass)")+"</h3><table class=\\"t\\"><tr><th>#</th><th>Your answer</th><th>Right?</th><th>Why</th></tr>"+j.rows.map(function(x){return "<tr><td>"+x.id+"</td><td>"+Z.esc(x.your_answer_name||"-")+'</td><td class="'+(x.correct?"good":"bad")+'">'+(x.correct?"Yes":"No: "+Z.esc(x.answer_name))+"</td><td>"+Z.esc(x.why)+"</td></tr>";}).join("")+"</table>";};
if(Z.hasKey()){load().then(loadSc);}else $("top").textContent="Create a test key to start.";`;
    return UI.shell({ title: "Transaction types lab – Zanboxx", description: "Every card transaction type on a debit side and a credit side, with ledger views, a sequence runner and a quiz. Test data only.", active: "labs", body, script });
  }

  return {
    async handle(req, res, path, m) {
      if (m === "GET" && path === "/labs/types") { html(res, 200, page()); return true; }
      if (!path.startsWith("/v1/types")) return false;
      const acc = ctx.authed(req), t = st(acc); let g;
      if (m === "GET" && path === "/v1/types/catalog") { send(res, 200, { types: TYPES }); return true; }
      if (m === "GET" && (g = path.match(/^\/v1\/types\/ledger\/([a-z_]+)$/))) {
        const ty = T[g[1]]; if (!ty) throw bad(404, "not_found", "No such transaction type");
        t.viewed[ty.id] = true; t.did.map_viewed = true; t.did["ledger_" + ty.side] = true; if (TYPES.every((x) => t.viewed[x.id])) t.did.map_all = true; if (ty.id === "void") t.did.saw_void = true; if (ty.id === "refund") t.did.saw_refund = true;
        save(acc); send(res, 200, { id: ty.id, side: ty.side, stages: LED[ty.id].map((s) => ({ stage: s[0], cardholder_available: s[1], cardholder_hold: s[2], merchant_pending: s[3], merchant_balance: s[4], note: s[5] })) }); return true;
      }
      if (m === "POST" && path === "/v1/types/sequence") {
        const b = await readBody(req), r = runSeq(b.steps), ty = b.steps.map((s) => s.type);
        t.did.seq_run = true; if (r.okAll && ty.join() === "preauth,incremental,completion,settle") t.did.seq_hotel = true;
        if (r.flags.void_blocked) t.did.seq_void_blocked = true; if (r.flags.refund_blocked) t.did.seq_refund_blocked = true;
        if (r.results.some((x) => x.type === "refund" && x.ok)) t.did.seq_refund_ok = true; if (r.results.some((x, i) => x.type === "representment" && x.ok && b.steps[i].evidence === true)) t.did.seq_dispute_won = true;
        save(acc); const { flags, okAll, ...rest } = r; send(res, 200, rest); return true;
      }
      if (m === "GET" && path === "/v1/types/scenarios") { send(res, 200, { scenarios: SCEN.map((s) => ({ id: s.id, text: s.text })) }); return true; }
      if (m === "POST" && path === "/v1/types/scenarios/score") {
        const b = await readBody(req), a = b.answers; if (!a || typeof a !== "object") throw bad(400, "invalid_request", "answers must be an object of scenario id to type id");
        let ok = 0; const rows = [];
        for (const s of SCEN) { const v = a[s.id] || a[String(s.id)]; if (v !== undefined && v !== "" && !T[v] && v !== "settle") throw bad(400, "invalid_request", `Scenario ${s.id}: unknown type '${v}'`); const c = v === s.answer; if (c) ok++; rows.push({ id: s.id, your_answer: v || null, your_answer_name: v && T[v] ? T[v].name : null, correct: c, answer: s.answer, answer_name: T[s.answer].name, why: s.why }); }
        const passed = ok >= 15; t.did.scen_done = true; if (passed) t.did.scen_pass = true; if (ok === SCEN.length) t.did.scen_perfect = true; save(acc);
        send(res, 200, { correct: ok, total: SCEN.length, passed, rows }); return true;
      }
      return false;
    },
  };
};
