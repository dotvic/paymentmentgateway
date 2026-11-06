const { spawn } = require("child_process"), http = require("http"), crypto = require("crypto"), assert = require("assert");
const { chromium } = require("playwright");
const path = require("path"), os = require("os"), fs = require("fs"); const ROOT = path.join(__dirname, ".."), OUT = fs.mkdtempSync(path.join(os.tmpdir(), "zanboxx-ui-"));
const MAILP = 18092, mails = [];
http.createServer((req, res) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { mails.push(JSON.parse(d)); res.setHeader("content-type", "application/json"); res.end("{}"); }); }).listen(MAILP);
const hookGot = [];
http.createServer((req, res) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { hookGot.push(JSON.parse(d)); res.end("ok"); }); }).listen(18093);
const PORT = 18090, STRIPE = 18091, BASE = `http://127.0.0.1:${PORT}`, WH = "whsec_ui";
http.createServer((req, res) => { req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ content: [{ type: "text", text: "Mock tutor answer." }] })); }); }).listen(18096);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stripeSrv = http.createServer((req, res) => {
  req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url.includes("portal") ? { url: "https://billing.stripe.test/p" } : { url: "https://checkout.stripe.test/c/cs_1" })); });
}).listen(STRIPE);
for (const f of ["data.json", "data.db", "data.db-wal", "data.db-shm"]) try { require("fs").unlinkSync(OUT + "/" + f); } catch {}
const srv = spawn("node", ["server.js"], { cwd: ROOT, stdio: "inherit", env: { ...process.env, PORT, ANTHROPIC_API_KEY: "sk-ant-mock", ANTHROPIC_API_BASE: "http://127.0.0.1:18096", DATA_FILE: OUT + "/data.json", ALLOW_PRIVATE_WEBHOOKS: "1", DISPUTE_REVIEW_DELAY_MS: "800",
  EMAIL_API_KEY: "re_x", EMAIL_FROM: "Z <a@example.test>", EMAIL_API_BASE: `http://127.0.0.1:${MAILP}`, STRIPE_SECRET_KEY: "sk_test_mock", STRIPE_PRICE_ID: "price_1", STRIPE_WEBHOOK_SECRET: WH, STRIPE_API_BASE: `http://127.0.0.1:${STRIPE}`, PUBLIC_URL: BASE, PRO_PRICE_LABEL: "EUR 19 per month",
  OPERATOR_NAME: "UI Test Operator", OPERATOR_ADDRESS: "1 Test Street", CONTACT_EMAIL: "legal@example.test" } });

(async () => {
  let browser, failed = false, pageRef;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(BASE + "/health"); break; } catch { await sleep(100); } }
    browser = await chromium.launch();
    const errors = [];
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    const page = await ctx.newPage(); pageRef = page;
    page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("requestfailed", (r) => errors.push("requestfailed: " + r.url()));
    await ctx.route("https://checkout.stripe.test/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<h1>mock checkout</h1>" }));

    // signup
    await page.goto(BASE + "/labs");
    assert.ok((await page.textContent("#labLocked")).includes("Create or paste"), "lab locked before signup");
    assert.ok(await page.isDisabled("#labForm") || await page.$eval("#labForm", (f) => f.disabled), "lab form disabled before signup");
    let acctId; page.on("response", async (r) => { if (r.url().endsWith("/v1/accounts") && r.request().method() === "POST") { try { acctId = (await r.json()).account_id; } catch {} } });
    await page.click("#create");
    await page.waitForFunction(() => /^sk_test_/.test(document.querySelector("#keyShow").textContent));
    assert.ok(!(await page.$eval("#labForm", (f) => f.disabled)), "lab form enabled after signup");
    assert.ok(await page.isVisible("#upgrade"), "Upgrade button visible");
    assert.equal((await page.textContent("#proPrice")).trim(), "EUR 19 per month");

    // upgrade this account so the 30 requests a minute free limit does not interfere with fast scripted clicks
    { const raw0 = JSON.stringify({ id: "evt_up", type: "checkout.session.completed", data: { object: { client_reference_id: acctId, mode: "subscription", payment_status: "paid", customer: "cus_a", subscription: "sub_a" } } });
      const t0 = Math.floor(Date.now() / 1000);
      assert.equal((await fetch(BASE + "/stripe/webhook", { method: "POST", headers: { "stripe-signature": `t=${t0},v1=${crypto.createHmac("sha256", WH).update(`${t0}.${raw0}`).digest("hex")}` }, body: raw0 })).status, 200); }
    // main console still works
    await page.click("#send");
    await page.waitForFunction(() => document.querySelector("#term").textContent.includes("HTTP 201"));

    // lab: every scenario
    const expect = { Y: ["Y", "05", "Yes"], N: ["N", "07", "No"], A: ["A", "06", "Yes"], U: ["U", "07", "No"], R: ["R", "07", "No"] };
    for (const [id, [ts, eci, shift]] of Object.entries(expect)) {
      await page.click(`label[for="lab_${id}"]`);
      await page.evaluate(() => { document.querySelector("#labOut").innerHTML = ""; }); await page.click("#labRun");
      try { await page.waitForSelector("#labOut .sumgrid", {timeout:5000}); } catch (e) { throw new Error(id + " labErr=" + await page.textContent("#labErr") + " out=" + (await page.textContent("#labOut")).slice(0,200)); }
      const sum = await page.textContent("#labOut .sumgrid");
      assert.ok(sum.includes(ts) && sum.includes(eci) && sum.includes(shift), `${id}: summary ${sum}`);
      assert.ok((await page.$$("#labOut .tl-item")).length >= 7, `${id}: timeline rendered`);
      assert.ok(!(await page.textContent("#labOut")).includes("4000000000003"), "no full card number in the rendered log");
    }

    // lab: challenge, wrong code first
    await page.click('label[for="lab_C"]');
    await page.evaluate(() => { document.querySelector("#labOut").innerHTML = ""; }); await page.click("#labRun");
    await page.waitForSelector("#labOut .chal");
    const before = (await page.$$("#labOut .tl-item")).length;
    await page.screenshot({ path: OUT + "/lab-challenge-waiting.png", fullPage: false });
    await page.click('button[data-chal="fail"]');
    await page.waitForSelector("#labOut .sumgrid");
    assert.ok((await page.$$("#labOut .tl-item")).length > before, "challenge adds steps");
    assert.ok((await page.textContent("#labOut .sumgrid")).includes("No, you keep it"));
    assert.ok(await page.isVisible("#labOut .tl-item.k-stop"), "stop step shown");
    // challenge: correct code
    await page.evaluate(() => { document.querySelector("#labOut").innerHTML = ""; }); await page.click("#labRun");
    await page.waitForSelector("#labOut .chal");
    await page.click('button[data-chal="approve"]');
    await page.waitForSelector("#labOut .sumgrid");
    assert.ok((await page.textContent("#labOut .sumgrid")).includes("Yes, moves to the issuer"));
    assert.ok((await page.textContent("#labOut")).includes("RReq"));

    // toggles
    const exp = await page.$eval("#labOut .explain", (e) => getComputedStyle(e).display);
    assert.notEqual(exp, "none");
    await page.uncheck("#labExplain");
    assert.equal(await page.$eval("#labOut .explain", (e) => getComputedStyle(e).display), "none");
    await page.check("#labExplain");
    await page.check("#labFields");
    assert.ok((await page.$$("#labOut details.f[open]")).length > 5, "show all fields opens details");
    await page.uncheck("#labFields");

    // download
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("button[data-lab-dl]")]);
    assert.ok(/^3ds-log-tx_[a-f0-9]+\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());

    // ledger button loads a log
    await page.click('label[for="lab_Y"]'); await page.evaluate(() => { document.querySelector("#labOut").innerHTML = ""; }); await page.click("#labRun"); await page.waitForSelector("#labOut .sumgrid");
    await page.evaluate(() => { document.querySelector("#labOut").innerHTML = "cleared"; });
    await page.waitForSelector('#ledger button[data-lab]');
    await page.click('#ledger button[data-lab] >> nth=0');
    await page.waitForSelector("#labOut .sumgrid");

    // full-page screenshots
    await page.click('label[for="lab_C"]'); await page.evaluate(() => { document.querySelector("#labOut").innerHTML = ""; }); await page.click("#labRun"); await page.waitForSelector("#labOut .chal");
    await page.click('button[data-chal="approve"]'); await page.waitForSelector("#labOut .sumgrid");
    await (await page.$("#lab")).screenshot({ path: OUT + "/lab-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await (await page.$("#lab")).screenshot({ path: OUT + "/lab-mobile.png" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const culprits = await page.evaluate(() => { const w = innerWidth; return [...document.querySelectorAll("body *")].filter(e => e.getBoundingClientRect().right > w + 1 && !e.closest(".tablewrap, pre")).slice(0, 8).map(e => e.tagName + "." + e.className + "#" + e.id + " " + Math.round(e.getBoundingClientRect().right)); });
    assert.ok(overflow <= 1, "no horizontal page scroll on mobile, overflow=" + overflow + " culprits=" + culprits.join("; "));
    await page.setViewportSize({ width: 1280, height: 900 });

    // billing UI: upgrade click goes to checkout
    { const acct0 = await (await fetch(BASE + "/v1/accounts", { method: "POST" })).json();
      const pg = await ctx.newPage();
      await pg.addInitScript((k) => localStorage.setItem("dryrun_key", k), acct0.api_key);
      await pg.goto(BASE + "/labs"); await pg.click("#upgrade"); await pg.waitForURL("https://checkout.stripe.test/**"); await pg.close(); }

    // billing success flow with a pre-made account
    const acct = await (await fetch(BASE + "/v1/accounts", { method: "POST" })).json();
    const page2 = await ctx.newPage();
    page2.on("pageerror", (e) => errors.push("pageerror2: " + e.message));
    await page2.addInitScript((k) => localStorage.setItem("dryrun_key", k), acct.api_key);
    const raw = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: { client_reference_id: acct.account_id, mode: "subscription", payment_status: "paid", customer: "cus_ui", subscription: "sub_ui" } } });
    const t = Math.floor(Date.now() / 1000);
    const wr = await fetch(BASE + "/stripe/webhook", { method: "POST", headers: { "stripe-signature": `t=${t},v1=${crypto.createHmac("sha256", WH).update(`${t}.${raw}`).digest("hex")}` }, body: raw });
    assert.equal(wr.status, 200);
    await page2.goto(BASE + "/labs?billing=success");
    await page2.waitForFunction(() => document.querySelector("#billingMsg").textContent.includes("You are on the Pro plan"));
    assert.ok(await page2.isVisible("#portal") && !(await page2.isVisible("#upgrade")), "Manage billing replaces Upgrade");
    assert.ok(!page2.url().includes("billing="), "billing parameter removed from the address bar");

    // delete account from the page
    page2.on("dialog", (d) => d.accept());
    await page2.click("summary:has-text('Delete this account')");
    await page2.click("#deleteAcct");
    await page2.waitForFunction(() => !localStorage.getItem("dryrun_key"));
    assert.ok(await page2.isVisible("#signup"), "signup form shown again after deletion");


    // email recovery in the browser
    { const p3 = await ctx.newPage(); p3.on("pageerror", (e) => errors.push("pageerror3: " + e.message));
      await p3.goto(BASE + "/labs"); await p3.click("#create");
      await p3.waitForFunction(() => /^sk_test_/.test(document.querySelector("#keyShow").textContent));
      const firstKey = await p3.evaluate(() => localStorage.getItem("dryrun_key"));
      await p3.click("#recoveryBox summary"); await p3.fill("#recEmail", "ui@example.test"); await p3.click("#recSend");
      await p3.waitForFunction(() => document.querySelector("#recMsg").textContent.includes("confirmation link"));
      await sleep(300); const vlink = mails.pop().text.match(/\/labs\?verify=[a-f0-9]+/)[0];
      await p3.goto(BASE + vlink);
      await p3.waitForFunction(() => document.querySelector("#linkMsg").textContent.includes("Email confirmed"));
      assert.ok(!p3.url().includes("verify="), "token removed from the address bar");
      // lose the key: new browser context has no key
      const ctx2 = await browser.newContext(); const p4 = await ctx2.newPage(); p4.on("pageerror", (e) => errors.push("pageerror4: " + e.message));
      await p4.goto(BASE + "/labs"); await p4.click("#lostBox summary"); await p4.fill("#lostEmail", "ui@example.test"); await p4.click("#lostSend");
      await p4.waitForFunction(() => document.querySelector("#lostMsg").textContent.includes("on its way"));
      await sleep(300); const llink = mails.pop().text.match(/\/labs\?login=[a-f0-9]+/)[0];
      await p4.goto(BASE + llink);
      await p4.waitForFunction(() => document.querySelector("#linkMsg").textContent.includes("signed in"));
      const newKey = await p4.evaluate(() => localStorage.getItem("dryrun_key"));
      assert.ok(newKey && newKey !== firstKey, "new key stored");
      await p4.waitForFunction(() => document.querySelector("#recState").textContent.includes("ui@example.test"));
      await p4.screenshot({ path: OUT + "/recovery.png" });
      await p4.goto(BASE + llink); await p4.waitForFunction(() => document.querySelector("#linkMsg").textContent.includes("expired"));
      await ctx2.close(); await p3.close(); }


    // trial, failure script, inspector and replay in the browser
    { const ctx3 = await browser.newContext(); const p5 = await ctx3.newPage(); p5.on("pageerror", (e) => errors.push("pageerror5: " + e.message));
      await p5.goto(BASE + "/labs"); await p5.click("#create");
      await p5.waitForFunction(() => /^sk_test_/.test(document.querySelector("#keyShow").textContent));
      // free: script is locked with a hint about the trial
      await p5.waitForFunction(() => document.querySelector("#scriptStatus").textContent.includes("trial"));
      await p5.click('button[data-preset="0"]'); await p5.click("#scriptSave");
      await p5.waitForFunction(() => document.querySelector("#scriptErr").textContent.includes("free trial"));
      assert.ok((await p5.textContent("#trialLine")).includes("14 days"));
      // confirm email: trial starts
      await p5.click("#recoveryBox summary"); await p5.fill("#recEmail", "trialui@example.test"); await p5.click("#recSend");
      await p5.waitForFunction(() => document.querySelector("#recMsg").textContent.includes("confirmation link"));
      await sleep(300); const tlink = mails.pop().text.match(/\/labs\?verify=[a-f0-9]+/)[0];
      await p5.goto(BASE + tlink);
      await p5.waitForFunction(() => document.querySelector("#linkMsg").textContent.includes("trial has started"));
      await p5.waitForFunction(() => document.querySelector("#usage").textContent.includes("Pro trial, 14 days left"));
      // script: every 3rd payment declines
      await p5.click('button[data-preset="0"]'); await p5.click("#scriptSave");
      await p5.waitForFunction(() => document.querySelector("#scriptStatus").textContent.includes("Saved"));
      await p5.fill("#whUrl", "http://127.0.0.1:18093/hook"); await p5.click("#whSave");
      await p5.waitForFunction(() => document.querySelector("#whSecret").textContent.includes("whsec_"));
      const states = [];
      for (let i = 0; i < 3; i++) {
        await p5.evaluate(() => { document.querySelector("#term").innerHTML = ""; });
        await p5.click("#send"); await p5.waitForFunction(() => document.querySelector("#term").textContent.includes("HTTP 201"));
        states.push(await p5.textContent("#term"));
      }
      assert.ok(states[0].includes('"success"') && states[2].includes('"failed"') && states[2].includes('"script_rule": 1'), "third payment declined by the script");
      // inspector: open details, replay
      await p5.click("#whRefresh");
      await p5.waitForSelector('#whLog button[data-dlv]');
      await p5.click('#whLog button[data-dlv] >> nth=0');
      await p5.waitForSelector("#whDetail pre.code");
      assert.ok((await p5.textContent("#whDetail")).includes("payment."));
      const before = hookGot.length;
      await p5.click("#whDetail button[data-replay]");
      await p5.waitForFunction(() => document.querySelector("#replayMsg").textContent.includes("Replay queued"));
      await sleep(500); assert.ok(hookGot.length > before, "replayed event reached the endpoint");
      await p5.screenshot({ path: OUT + "/script.png", fullPage: false });
      await (await p5.$("#script")).screenshot({ path: OUT + "/script-section.png" });
      await p5.setViewportSize({ width: 390, height: 844 });
      const ov = await p5.evaluate(() => document.documentElement.scrollWidth - innerWidth); assert.ok(ov <= 1, "no horizontal scroll on mobile with script and inspector, overflow=" + ov);
      await ctx3.close(); }

    // card schemes: test card table and the lab with other schemes
    await page.waitForSelector("#cardChips label");
    assert.ok((await page.textContent("#cardsBody")).includes("4111 1111 1111 1111"));
    await page.click('label[for="cs_amex"]');
    assert.ok((await page.textContent("#cardsBody")).includes("3782 822463 10005"), "amex card shown in 4-6-5 format");
    assert.ok((await page.textContent("#schemeInfo")).includes("SafeKey") && (await page.textContent("#schemeInfo")).includes("CID"));
    await page.click('label[for="cs_mastercard"]');
    assert.ok((await page.textContent("#schemeInfo")).includes("Identity Check"));
    await (await page.$("#cards")).screenshot({ path: OUT + "/cards.png" });
    await page.selectOption("#labScheme", "mastercard"); await page.click('label[for="lab_Y"]');
    assert.equal((await page.textContent("#labCard")).trim(), "5200 0000 0003 0004");
    await page.evaluate(() => { document.querySelector("#labOut").innerHTML = ""; }); await page.click("#labRun"); await page.waitForSelector("#labOut .sumgrid");
    const mcSum = await page.textContent("#labOut .sumgrid"); assert.ok(mcSum.includes("Mastercard Identity Check") && mcSum.includes("AAV"), mcSum);
    assert.ok(/ECI\s*02/.test(mcSum), "Mastercard ECI 02: " + mcSum);
    await page.selectOption("#labScheme", "amex"); await page.click('label[for="lab_A"]');
    await page.evaluate(() => { document.querySelector("#labOut").innerHTML = ""; }); await page.click("#labRun"); await page.waitForSelector("#labOut .sumgrid");
    const amSum = await page.textContent("#labOut .sumgrid"); assert.ok(amSum.includes("SafeKey") && /ECI\s*06/.test(amSum), amSum);
    await page.selectOption("#labScheme", "visa");

    // disputes: raise, answer with evidence, win
    await page.evaluate(async () => { var r = await api("POST", "/v1/payments", { request_id: "ui_dp_" + Math.random(), method: "card", transaction_type: "purchase", amount: 42, currency: "EUR", card_number: "5555555555554444" }); await refreshLedger(); return r.status; });
    await page.waitForSelector("#ledger button[data-dispute]");
    await page.click("#ledger button[data-dispute]");
    assert.ok((await page.inputValue("#dpPay")).startsWith("tx_"));
    assert.ok((await page.textContent("#dpReason")).includes("4855"), "Mastercard reason codes offered");
    await page.selectOption("#dpReason", "not_received"); await page.click("#dpRaise");
    await page.waitForFunction(() => document.querySelector("#dpDetail").textContent.includes("Needs your response"));
    assert.ok((await page.textContent("#dpDetail")).includes("Proof of delivery"));
    await page.fill("#ev_tracking_number", "1Z999AA10123456784"); await page.fill("#ev_proof_of_delivery", "Signed by J. Doe");
    await (await page.$("#disputes")).screenshot({ path: OUT + "/disputes.png" });
    await page.click("#dpSend");
    await page.waitForFunction(() => document.querySelector("#dpDetail").textContent.includes("Won."), null, { timeout: 12000 });
    assert.ok((await page.textContent("#dpList")).includes("Won"));
    for (let i = 0; i < 10 && !(await page.textContent("#ledger")).includes("dispute won"); i++) { await page.evaluate(() => refreshLedger()); await sleep(400); }
    assert.ok((await page.textContent("#ledger")).includes("dispute won"), "ledger shows the dispute as won");
    await (await page.$("#disputes")).screenshot({ path: OUT + "/disputes-won.png" });
    // a lost-by-accepting dispute
    await page.evaluate(async () => { await api("POST", "/v1/payments", { request_id: "ui_dp2_" + Math.random(), method: "card", transaction_type: "purchase", amount: 10, currency: "EUR", card_number: "4111111111111111" }); await refreshLedger(); });
    await page.waitForSelector("#ledger button[data-dispute]"); await page.click("#ledger button[data-dispute]"); await page.click("#dpRaise");
    await page.waitForSelector("#dpAccept"); await page.click("#dpAccept");
    await page.waitForFunction(() => document.querySelector("#dpDetail").textContent.includes("Lost."));

    // card on file: store a Mastercard, charge it as a merchant, see the scheme's advice, cancel
    await page.selectOption("#cofScheme", "mastercard"); await page.selectOption("#cofType", "instalment");
    assert.ok(await page.isVisible("#cofInstWrap"), "instalment count field appears");
    await page.click("#cofStore");
    await page.waitForFunction(() => document.querySelector("#cofOut").textContent.includes("Card stored"));
    assert.ok((await page.textContent("#cofOut")).includes("5555") === false, "no card number echoed");
    await page.waitForFunction(() => document.querySelector("#agrList").textContent.includes("1 of 3 paid"));
    await page.selectOption("#mitOutcome", "decline"); await page.click("#mitRun");
    await page.waitForFunction(() => document.querySelector("#cofOut").textContent.includes("MAC 03"));
    assert.ok((await page.textContent("#cofOut")).includes("Do not retry this card"));
    await page.selectOption("#mitOutcome", "approve"); await page.click("#mitRun");
    await page.waitForFunction(() => document.querySelector("#cofOut").textContent.includes("links back"));
    await page.waitForFunction(() => document.querySelector("#agrList").textContent.includes("2 of 3 paid"));
    await (await page.$("#cof")).screenshot({ path: OUT + "/cof.png" });
    await page.selectOption("#cofScheme", "visa"); await page.selectOption("#cofType", "recurring"); await page.check("#cofTds"); await page.click("#cofStore");
    await page.waitForFunction(() => document.querySelector("#agrList").textContent.includes("Yes (ECI 05)"));
    await page.click("#agrList button[data-agr-cancel]");
    await page.waitForFunction(() => document.querySelector("#cofOut").textContent.includes("cancelled"));
    await page.setViewportSize({ width: 390, height: 844 });
    const ovc = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth); assert.ok(ovc <= 1, "no horizontal scroll on mobile with card on file, overflow=" + ovc);
    await page.setViewportSize({ width: 1280, height: 900 });

    // settlement: close the day, preview a file, reconcile with a sample ledger
    await page.evaluate(async () => {
      for (const c of ["4111111111111111", "5555555555554444", "378282246310005", "4111111111111111"]) await api("POST", "/v1/payments", { request_id: "ui_stl_" + Math.random(), method: "card", transaction_type: "purchase", amount: 25, currency: "EUR", card_number: c });
      await refreshLedger();
    });
    await page.click("#stlClose");
    await page.waitForFunction(() => document.querySelector("#stlDetail") && !document.querySelector("#stlDetail").classList.contains("hidden") && document.querySelector("#stlDetail").textContent.includes("Payout:"), null, { timeout: 8000 });
    assert.ok((await page.textContent("#stlFees")).includes("Fictional fee schedule"));
    assert.ok((await page.textContent("#stlDetail")).includes("zbx-visa-clearing-") && (await page.textContent("#stlDetail")).includes("zbx-payout-"));
    await page.click('button[data-stl-view$=".dat"]');
    await page.waitForFunction(() => document.querySelector("#stlPreview").textContent.includes("95 chars"));
    assert.ok((await page.textContent("#stlPreview")).includes("DPS"), "fixed-width detail lines shown");
    await page.click("#stlSample"); assert.ok((await page.inputValue("#stlLedger")).includes("tx_0000dead"));
    await page.waitForFunction(() => document.querySelector("#stlIc") && document.querySelector("#stlIc").textContent.includes("Acquirer margin"));
    assert.ok((await page.textContent("#stlIc")).includes("interchange++") || (await page.textContent("#stlIc")).includes("Interchange++"));
    await page.fill("#tutQ", "Why was this declined?"); await page.click("#tutAsk");
    await page.waitForFunction(() => document.querySelector("#tutLog").textContent.includes("Mock tutor answer."));
    assert.ok((await page.textContent("#tutLeft")).includes("9 of 10"), await page.textContent("#tutLeft"));
    // POS and ATM labs
    await page.waitForFunction(() => document.querySelector("#cpType") && document.querySelector("#cpType").options.length > 5);
    await page.fill("#cpAmt", "12.50"); await page.click("#cpRun");
    await page.waitForFunction(() => document.querySelector("#cpOut").textContent.includes("Approved"));
    assert.ok((await page.textContent("#cpOut")).includes("ARPC"), "EMV lab shows the issuer cryptogram");
    assert.ok((await page.textContent("#cpOut")).includes("SELECT PPSE") && (await page.textContent("#cpOut")).includes("GENERATE AC (second)"), "EMV log shown with the result");
    await page.fill("#cpAmt", "13.00"); await page.click("#cpRun"); await page.waitForTimeout(600);
    await page.evaluate(() => { document.querySelector("#cpOut").innerHTML = ""; });
    await page.waitForSelector('button[data-cplog]'); await page.click('button[data-cplog]');
    await page.waitForFunction(() => document.querySelector("#cpOut").textContent.includes("SELECT PPSE"));
    await (await page.$("#cplab")).screenshot({ path: OUT + "/emv-log.png" });
    await page.selectOption("#cpTamper", "arqc"); await page.click("#cpRun");
    await page.waitForFunction(() => document.querySelector("#cpOut").textContent.includes("Declined") && document.querySelector("#cpOut").textContent.includes("response 82"));
    await page.click("#cpTabMag");
    await page.click("#cpRun");
    await page.waitForFunction(() => document.querySelector("#cpOut").textContent.includes("response 62"));
    await page.selectOption("#cpEntry", "fallback"); await page.click("#cpRun");
    await page.waitForFunction(() => document.querySelector("#cpOut").textContent.includes("Approved"));
    await page.click("#cpTabEmv"); await page.selectOption("#cpChannel", "atm"); await page.selectOption("#cpType", "balance_inquiry"); await page.click("#cpRun");
    await page.waitForFunction(() => document.querySelector("#cpOut").textContent.includes("Balance:"));
    await page.click("#stlCheck");
    await page.waitForFunction(() => document.querySelector("#stlResult").textContent.includes("not cleared in this batch"));
    assert.ok((await page.textContent("#stlResult")).includes("amount differs"));
    await (await page.$("#settle")).screenshot({ path: OUT + "/settle.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    const ovs = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth); assert.ok(ovs <= 1, "no horizontal scroll on mobile with settlement, overflow=" + ovs);
    await page.setViewportSize({ width: 1280, height: 900 });

    // legal pages
    for (const p of ["/terms", "/privacy", "/impressum"]) {
      const lp = await ctx.newPage(); const errs = [];
      lp.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
      await lp.goto(BASE + p);
      assert.ok((await lp.textContent("main")).includes("UI Test Operator"), p);
      assert.equal(errs.length, 0, p + " console errors: " + errs);
      await lp.close();
    }
    await page.goto(BASE + "/labs#lab");
    assert.deepEqual(errors, [], "browser errors: " + errors.join(" | "));
    console.log("UI test passed");
  } catch (e) { failed = true; let x=""; try{ x=" labErr="+await pageRef.textContent("#labErr"); }catch{} console.error("UI TEST FAILED:", e.message.slice(0,200), (e.stack.match(/ui-test.js:\d+/)||[""])[0], x); }
  finally { if (browser) await browser.close(); srv.kill(); stripeSrv.close(); process.exit(failed ? 1 : 0); }
})();
