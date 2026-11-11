"use strict";
// Dispute evidence pack lab: five fictional chargeback cases. You pick the documents to send and write a short cover
// note. The pack is scored on what each document proves, on harmful or irrelevant additions, and on the note. The
// answer key stays on the server. Everything here is fictional.

module.exports = function ({ html, ctx, UI, esc }) {
  const { send, bad, readBody, save } = ctx;
  const PTS = { strong: 24, supporting: 12, weak: 4, harmful: -25, irrelevant: -6 };
  const WIN = 65, MAX_ITEMS = 10, ITEM_CAP = 80;
  // kind: strong | supporting | weak | harmful | irrelevant. why is shown after submitting.
  const CASES = [
    { id: "c1", category: "Fraud", title: "I did not make this purchase", amount: 189.0, days_left: 5, required: ["ip", "history"],
      claim: "The cardholder says they did not authorise a 189.00 order for a pair of headphones and a case.",
      facts: ["Order placed online at 21:14 from a browser, shipped to the cardholder's billing address.", "No 3-D Secure step was used on this payment.", "The same customer account has three earlier orders, none disputed."],
      library: [
        { id: "ip", title: "Order log: IP address and device match three earlier orders", kind: "strong", why: "A matching IP and device across undisputed orders is the best sign that the real customer ordered." },
        { id: "history", title: "Customer account history: three paid, undisputed orders over eight months", kind: "strong", why: "A history of accepted purchases from the same account makes a stranger's fraud less likely." },
        { id: "addr", title: "Shipping address equals the cardholder's billing address", kind: "supporting", why: "Goods went to the cardholder's own address, not a fraudster's drop." },
        { id: "email", title: "Order confirmation emailed to the account address and never bounced", kind: "supporting", why: "Shows the confirmation went to a working address on the account." },
        { id: "score", title: "Our internal fraud score for this order was 'low'", kind: "weak", why: "The issuer cannot check your private score, so it carries little weight." },
        { id: "terms", title: "Our general terms and conditions", kind: "irrelevant", why: "Terms say nothing about who made this payment." },
        { id: "forwarder", title: "Parcel tracking showing delivery to a freight forwarder in another country", kind: "harmful", why: "A forwarder is a common sign of fraud. It supports the cardholder's claim." },
        { id: "refund", title: "Our refund policy", kind: "irrelevant", why: "A refund policy does not answer a claim that the cardholder never ordered." },
      ] },
    { id: "c2", category: "Goods not received", title: "The parcel never arrived", amount: 74.5, days_left: 4, required: ["pod", "track"],
      claim: "The cardholder says a jacket ordered for 74.50 was never delivered.",
      facts: ["The order was dispatched on 3 March with a tracked service.", "The carrier's last scan reads 'delivered' on 6 March.", "The customer wrote to support on 9 March asking where the parcel was."],
      library: [
        { id: "pod", title: "Carrier proof of delivery: signature and photo at the order address, 6 March", kind: "strong", why: "A signed or photographed delivery at the right address is direct proof of receipt." },
        { id: "track", title: "Tracking number with the full scan history ending 'delivered'", kind: "strong", why: "The scan history shows dispatch, transit and delivery with dates." },
        { id: "addr", title: "Delivery address equals the shipping address the customer entered", kind: "supporting", why: "Shows the parcel went where the customer asked." },
        { id: "orderconf", title: "Order confirmation with the promised delivery date", kind: "supporting", why: "Sets the timeline against which delivery can be judged." },
        { id: "slogan", title: "A statement that 'we always ship carefully'", kind: "weak", why: "A claim about habit is not evidence about this parcel." },
        { id: "msg", title: "The customer's email of 9 March asking where the parcel was", kind: "harmful", why: "It supports the claim that the customer did not have the parcel. Only include messages that help you." },
        { id: "delay", title: "A carrier notice of a two-week network delay in the region", kind: "harmful", why: "It suggests the delivery scan may be unreliable and invites doubt." },
        { id: "logo", title: "Photos of our warehouse", kind: "irrelevant", why: "They say nothing about delivery of this parcel." },
      ] },
    { id: "c3", category: "Not as described", title: "It is not what I ordered", amount: 320.0, days_left: 6, required: ["page", "comm"],
      claim: "The cardholder says a desk lamp is not as described and wants the 320.00 back.",
      facts: ["The product page lists the lamp's size, material and colour.", "The customer asked to return it 40 days after delivery.", "Our return window is 30 days."],
      library: [
        { id: "page", title: "Archived copy of the product page showing the exact description on the order date", kind: "strong", why: "Shows what was promised, with a date, so the issuer can compare it with the claim." },
        { id: "comm", title: "Full message thread where the customer first complained, with our replies offering a return", kind: "strong", why: "Shows you tried to resolve it fairly before the dispute." },
        { id: "policy", title: "Return policy with the 30-day window, accepted at checkout", kind: "supporting", why: "Shows the customer agreed to the terms and the window had passed." },
        { id: "photos", title: "Our product photos from the listing", kind: "supporting", why: "Match the page and show how the item was presented." },
        { id: "reviews", title: "Five-star reviews from other customers", kind: "weak", why: "Other people's experience does not prove what this customer received." },
        { id: "custphoto", title: "The customer's photo showing a scratch on the base", kind: "harmful", why: "It supports the claim of a defect. Do not send evidence that helps the other side." },
        { id: "tax", title: "Our company tax certificate", kind: "irrelevant", why: "Unrelated to the dispute." },
      ] },
    { id: "c4", category: "Duplicate charge", title: "I was charged twice", amount: 49.0, days_left: 3, required: ["refs", "receipts"],
      claim: "The cardholder says they were charged 49.00 twice for the same booking.",
      facts: ["Two charges of 49.00 appeared on the same day.", "They belong to two separate bookings for two different dates.", "Each booking has its own reference."],
      library: [
        { id: "refs", title: "The two booking references with their dates and the charge each one belongs to", kind: "strong", why: "Shows two separate purchases, each with its own reference." },
        { id: "receipts", title: "Two itemised receipts, one per booking, showing different dates", kind: "strong", why: "Independent documents for each purchase make a duplicate unlikely." },
        { id: "calendar", title: "Calendar confirmation emails for each of the two dates", kind: "supporting", why: "Shows the customer received two separate confirmations." },
        { id: "usage", title: "Check-in records for both dates", kind: "supporting", why: "Shows the service was used on both dates." },
        { id: "reassure", title: "A note saying 'our system never double-charges'", kind: "weak", why: "A general claim does not address these two charges." },
        { id: "oneref", title: "A single combined statement listing only one booking", kind: "harmful", why: "It looks like proof that only one booking existed." },
        { id: "promo", title: "A marketing email for a summer offer", kind: "irrelevant", why: "Not related to these charges." },
      ] },
    { id: "c5", category: "Subscription after cancellation", title: "I cancelled this subscription", amount: 29.0, days_left: 5, required: ["log", "terms"],
      claim: "The cardholder says they cancelled a subscription before it renewed for 29.00.",
      facts: ["The account has no cancellation request on record.", "The renewal reminder was emailed seven days before the charge.", "The customer logged in and used the service after the renewal date."],
      library: [
        { id: "log", title: "Account audit log: no cancellation request, and a login and usage after the renewal", kind: "strong", why: "Shows no cancellation was made and that the service was used after the charge." },
        { id: "terms", title: "Subscription terms accepted at sign-up, with the cancellation steps and the date of acceptance", kind: "strong", why: "Shows what the customer agreed and how to cancel." },
        { id: "reminder", title: "Renewal reminder email sent seven days before, with delivery confirmation", kind: "supporting", why: "Shows the customer was warned and could have cancelled." },
        { id: "invoice", title: "Previous invoices paid on the same card without complaint", kind: "supporting", why: "Shows an ongoing relationship the customer accepted." },
        { id: "howto", title: "A help-centre page on how to cancel", kind: "weak", why: "General information, not specific to this account." },
        { id: "chat", title: "A chat transcript where the customer says 'please stop my plan' two days before the renewal", kind: "harmful", why: "It suggests the customer did ask to cancel. Never send evidence that contradicts your case." },
        { id: "press", title: "A press release about our new features", kind: "irrelevant", why: "Unrelated to the dispute." },
      ] },
  ];
  const st = (acc) => (acc.evid = acc.evid || { did: {}, results: {} });
  const tone = /\b(liar|lying|fraudster|scam(mer)?|cheat|thief|stupid|ridiculous)\b/i;

  function score(c, b) {
    const ids = Array.isArray(b.items) ? b.items.map(String) : null;
    if (!ids) throw bad(400, "invalid_request", "items must be a list of document ids");
    if (new Set(ids).size !== ids.length) throw bad(400, "invalid_request", "A document can be sent only once");
    if (ids.length < 1) throw bad(400, "invalid_request", "Choose at least one document");
    if (ids.length > MAX_ITEMS) throw bad(400, "invalid_request", `At most ${MAX_ITEMS} documents`);
    for (const i of ids) if (!c.library.find((x) => x.id === i)) throw bad(400, "invalid_request", `Unknown document ${i} for this case`);
    const note = String(b.narrative || "").trim(); if (note.length > 1500) throw bad(400, "invalid_request", "The note may be at most 1500 characters");
    const late = Math.min(Math.max(Number(b.days_late) || 0, 0), 30);
    const chosen = ids.map((i, n) => ({ ...c.library.find((x) => x.id === i), exhibit: String.fromCharCode(65 + n) }));
    let items = 0; const per = chosen.map((x) => { items += PTS[x.kind]; return { id: x.id, exhibit: x.exhibit, title: x.title, kind: x.kind, points: PTS[x.kind], why: x.why }; });
    const bloat = Math.max(0, ids.length - 6); items -= bloat * 3;
    items = Math.max(Math.min(items, ITEM_CAP), -40);
    // the cover note: up to 20 points
    const nb = []; let n = 0;
    const len = note.length; const okLen = len >= 60 && len <= 1000; if (okLen) n += 4; nb.push({ check: "A clear note of 60 to 1000 characters", points: okLen ? 4 : 0 });
    const refs = chosen.filter((x) => new RegExp("exhibit\\s*" + x.exhibit + "\\b", "i").test(note)).length, needRefs = Math.min(2, chosen.length);
    const refOk = refs >= needRefs; if (refOk) n += 6; nb.push({ check: "Refers to your documents by exhibit letter", points: refOk ? 6 : 0 });
    const dateOk = /\b(\d{1,2}\s*(st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})\b/i.test(note) || /\b(on|at|before|after|within)\s+(the\s+)?(order|renewal|delivery|date|day)\b/i.test(note); if (dateOk) n += 5; nb.push({ check: "Gives dates or a timeline", points: dateOk ? 5 : 0 });
    const askOk = /\b(please|request|ask|reverse|rule|decline|represent|uphold|in our favou?r)\b/i.test(note); if (askOk) n += 5; nb.push({ check: "Says what you are asking the bank to do", points: askOk ? 5 : 0 });
    const rude = tone.test(note); if (rude) { n -= 5; nb.push({ check: "Keeps a calm, factual tone (accusing the customer costs points)", points: -5 }); }
    n = Math.max(0, n);
    let total = items + n; const miss = c.required.filter((r) => !ids.includes(r));
    let capped = false; if (miss.length && total > 60) { total = 60; capped = true; }
    total = Math.max(0, Math.min(100, total));
    let verdict = total >= WIN ? "won" : "lost"; let cause = verdict === "won" ? "Evidence persuaded the bank." : miss.length ? "A key document was missing." : "The pack was not strong enough or contained material that helped the cardholder.";
    if (late > 0) { verdict = "lost"; cause = `The response was ${late} day${late === 1 ? "" : "s"} late. Late evidence is not read, whatever it contains.`; }
    const harmful = per.filter((p) => p.kind === "harmful").length;
    return { score: total, win_at: WIN, verdict, cause, documents: per, items_points: items, note_points: n, note_checks: nb, missing_key_documents: miss.map((m) => ({ id: m, title: c.library.find((x) => x.id === m).title })), capped_because_key_missing: capped, too_many_documents: bloat > 0, harmful_sent: harmful, late_days: late, unreferenced_exhibits: chosen.filter((x) => !new RegExp("exhibit\\s*" + x.exhibit + "\\b", "i").test(note)).map((x) => x.exhibit) };
  }

  function page() {
    const body = `<style>.k select,.k input,.k textarea{width:auto;display:inline-block}textarea{width:100%!important;min-height:110px}.doc{display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--line,#e3e7ef)}.doc input{margin-top:5px}.t td,.t th{padding:5px 8px;border-bottom:1px solid var(--line,#e3e7ef);text-align:left;vertical-align:top}.bad{color:#b3261e}.good{color:#1b7a3d}</style><div class="wrap"><h1>Dispute evidence pack lab</h1>
<p class="lede">A cardholder has disputed a payment. You have a few days to answer. Choose which documents to send, write a short cover note, and see how a reviewer would score it. The cases, customers and documents are fictional. Test data only.</p>
<div class="panel k"><p>Case <select id="cs"></select> <span class="hint" id="meta"></span></p><div id="cb"></div></div>
<div class="panel k"><strong>Your evidence pack</strong><p class="hint">Tick the documents you will send. Each one gets an exhibit letter (A, B, C ...) in the order you tick. More is not better: a reviewer reads quickly.</p><div id="lib"></div>
<p><strong>Cover note</strong> <span class="hint">State what happened, point to exhibits by letter, give dates, and say what you ask the bank to do.</span></p><textarea id="nt" maxlength="1500" placeholder="Example: The order was placed on 2 March at 21:14 from the same device as three earlier orders (Exhibit A). ..."></textarea>
<p>Send it <select id="lt"><option value="0">on time</option><option value="2">2 days late</option></select> <button type="button" id="go">Submit the pack</button> <span class="hint" id="sm"></span></p><div id="res"></div></div>
<h2>What to notice</h2><ul><li>The reviewer compares <b>the claim</b> with <b>the proof</b>. Each document should answer the claim directly.</li><li>Do not send anything that helps the other side, even if it is true. Choose what you send, and keep the thread of the story consistent.</li><li>Dates matter. Exhibit letters and a short timeline make a pack easy to follow.</li><li>A late response loses, whatever it contains.</li></ul>
<p class="hint">Related: <a href="/knowledge/chargeback-defence-and-evidence">Chargeback defence and evidence</a>, <a href="/academy/disputes">Disputes and chargebacks course</a>, <a href="/labs/clearing">the dispute ladder in the clearing lab</a>.</p></div>`;
    const script = `function $(i){return document.getElementById(i);}var C=[];async function api(a,b,c){if(!(await Z.ensureKey()))return {status:0,body:{}};return Z.api(a,b,c);}
function cur(){return C.find(function(x){return x.id===$("cs").value;});}
function draw(){var c=cur();if(!c)return;$("meta").textContent="Amount "+c.amount.toFixed(2)+", "+c.days_left+" days left to respond";$("cb").innerHTML='<p><b>'+Z.esc(c.title)+'</b> ('+Z.esc(c.category)+')</p><p>'+Z.esc(c.claim)+'</p><ul>'+c.facts.map(function(f){return "<li>"+Z.esc(f)+"</li>";}).join("")+"</ul>"+(c.answered?'<p class="hint">Your best score so far: '+c.answered.score+' ('+Z.esc(c.answered.verdict)+').</p>':"");
$("lib").innerHTML=c.library.map(function(d){return '<label class="doc"><input type="checkbox" value="'+d.id+'"><span>'+Z.esc(d.title)+"</span></label>";}).join("");$("res").innerHTML="";}
async function load(){var r=await api("GET","/v1/evidence/cases");if(r.status!==200){$("sm").textContent=Z.msg(r);return;}C=r.body.cases;var keep=$("cs").value;$("cs").innerHTML=C.map(function(c,i){return '<option value="'+c.id+'">'+(i+1)+". "+Z.esc(c.title)+"</option>";}).join("");if(keep)$("cs").value=keep;draw();}
$("cs").onchange=draw;
$("go").onclick=async function(){var ids=[].slice.call(document.querySelectorAll("#lib input")).filter(function(x){return x.checked;}).map(function(x){return x.value;});
var r=await api("POST","/v1/evidence/cases/"+$("cs").value+"/submit",{items:ids,narrative:$("nt").value,days_late:parseInt($("lt").value,10)});if(r.status!==200){$("sm").textContent=Z.msg(r);return;}$("sm").textContent="";var j=r.body;
$("res").innerHTML='<h3 class="'+(j.verdict==="won"?"good":"bad")+'">'+(j.verdict==="won"?"The bank ruled for you":"The bank ruled for the cardholder")+" ("+j.score+" of 100, "+j.win_at+" needed)</h3><p>"+Z.esc(j.cause)+'</p><table class="t"><tr><th>Exhibit</th><th>Document</th><th>Points</th><th>Why</th></tr>'+j.documents.map(function(d){return "<tr><td>"+d.exhibit+"</td><td>"+Z.esc(d.title)+"</td><td>"+d.points+"</td><td>"+Z.esc(d.why)+"</td></tr>";}).join("")+"</table>"
+(j.missing_key_documents.length?'<p class="bad">Missing key documents: '+j.missing_key_documents.map(function(m){return Z.esc(m.title);}).join("; ")+"</p>":"")+(j.too_many_documents?"<p class=bad>You sent too many documents; each one beyond six costs points.</p>":"")+'<p><b>Cover note: '+j.note_points+' of 20</b></p><ul>'+j.note_checks.map(function(n){return "<li>"+Z.esc(n.check)+": "+n.points+"</li>";}).join("")+"</ul>"+(j.unreferenced_exhibits.length?"<p class=hint>Exhibits you did not mention in the note: "+j.unreferenced_exhibits.join(", ")+"</p>":"");};
if(Z.hasKey())load();else $("sm").textContent="Create a test key to start.";`;
    return UI.shell({ title: "Dispute evidence pack lab – Zanboxx", description: "Assemble an evidence pack for a chargeback, write the cover note and see how a reviewer scores it.", active: "labs", body, script });
  }

  return {
    async handle(req, res, path, m) {
      if (m === "GET" && path === "/labs/evidence") { html(res, 200, page()); return true; }
      if (!path.startsWith("/v1/evidence")) return false;
      const acc = ctx.authed(req), t = st(acc);
      if (m === "GET" && path === "/v1/evidence/cases") {
        send(res, 200, { cases: CASES.map((c) => ({ id: c.id, category: c.category, title: c.title, amount: c.amount, days_left: c.days_left, claim: c.claim, facts: c.facts, library: c.library.map((x) => ({ id: x.id, title: x.title })), answered: t.results[c.id] || null })) }); return true;
      }
      const g = path.match(/^\/v1\/evidence\/cases\/(c\d)\/submit$/);
      if (m === "POST" && g) {
        const c = CASES.find((x) => x.id === g[1]); if (!c) throw bad(404, "not_found", "No such case");
        const r = score(c, await readBody(req)); const prev = t.results[c.id];
        if (prev) t.did.resubmitted = true;
        if (!prev || r.score > prev.score) t.results[c.id] = { score: r.score, verdict: r.verdict };
        t.did.submitted = true; if (r.late_days > 0) t.did.late_lost = true; else if (r.verdict === "won") { t.did.won = true; if (!r.harmful_sent) t.did.clean_win = true; }
        if (r.harmful_sent) t.did.harmful_sent = true; if (r.missing_key_documents.length) t.did.missed_key = true; if (r.note_points >= 20) t.did.perfect_note = true;
        if (CASES.every((x) => t.results[x.id] && t.results[x.id].verdict === "won")) t.did.won_all = true;
        save(acc); send(res, 200, r); return true;
      }
      return false;
    },
  };
};
