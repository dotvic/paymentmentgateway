"use strict";
// Teaching simulation of an EMV 3-D Secure 2.x authentication. Field names follow the EMV 3DS 2.2 specification,
// but the messages are simplified and every value (IDs, cryptograms, risk signals) is made up.

const crypto = require("crypto");
const SCH = require("./schemes");

const VERSION = "2.2.0";
const CURRENCY = { EUR: "978", USD: "840", GBP: "826" };
const LABEL = {
  Y: "Authentication successful",
  N: "Not authenticated, transaction denied",
  U: "Authentication could not be performed",
  A: "Attempt processing performed",
  C: "Challenge required",
  R: "Authentication rejected by the issuer",
};
const eci = (tr, status) => SCH.eciFor(tr.ctx.scheme, status); // Visa and Amex: 05 / 06 / 07, Mastercard: 02 / 01 / 00
const REASON = { N: "01", U: "22", A: "13", R: "11" };
const REASON_TEXT = { "01": "Card authentication failed", "11": "Suspected fraud", "13": "Cardholder not enrolled in service", "22": "ACS technical issue" };

// Test cards: the card number decides how the simulated bank behaves.
const CARDS = {
  "4000000000003000": "Y", "4000000000003220": "C", "4000000000003238": "N",
  "4000000000003253": "A", "4000000000003261": "U", "4000000000003279": "R",
};

const uuid = () => crypto.randomUUID();
const jitter = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const stamp = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

const ME = "Merchant (you)", SERVER = "3DS Server", DS = "Directory Server", ACS = "ACS (issuer's bank)", BROWSER = "Cardholder's browser", ACQ = "Acquirer";
const VIA = "ACS, via Directory Server";

const SHARED_NOTES = {
  messageType: "What kind of message this is. AReq/ARes = authentication request/response, CReq/CRes = challenge request/response, RReq/RRes = results request/response.",
  messageVersion: "Version of the 3DS protocol both sides agreed to use.",
  threeDSServerTransID: "ID created by the 3DS Server. It ties every message of this authentication together.",
  acsTransID: "ID created by the issuer's ACS for this authentication.",
  dsTransID: "ID created by the Directory Server (the card network's switch). Your acquirer may need it when authorising.",
  transStatus: "The outcome. Y = authenticated, N = denied, U = could not be performed, A = attempt recorded, C = challenge required, R = rejected.",
  authenticationValue: "Cryptographic proof of the authentication (CAVV for Visa, AAV or UCAF for Mastercard, AEVV for American Express). Your acquirer passes it on when authorising. Fake here.",
  eci: "Electronic Commerce Indicator. Tells the networks how the cardholder was authenticated. Visa and American Express: 05 authenticated, 06 attempted, 07 not authenticated. Mastercard: 02, 01, 00.",
};

function addStep(tr, s, wait) {
  tr.clock += wait != null ? wait : jitter(8, 95);
  tr.steps.push({ n: tr.steps.length + 1, offset_ms: tr.clock, kind: "message", payload: null, notes: null, ...s });
}

function areqPayload(tr) {
  const { amount, currency, last4 } = tr.ctx, ids = tr.ids;
  return {
    messageType: "AReq", messageVersion: VERSION, messageCategory: "01", deviceChannel: "02",
    threeDSRequestorAuthenticationInd: "01", threeDSServerTransID: ids.threeDSServerTransID, threeDSCompInd: "Y",
    acctNumber: "************" + last4, cardExpiryDate: "2812",
    purchaseAmount: String(Math.round(amount * 100)), purchaseCurrency: CURRENCY[currency] || "978", purchaseExponent: "2", purchaseDate: stamp(),
    merchantName: "Demo Shop", mcc: "5734",
    browserInfo: { browserAcceptHeader: "text/html", browserJavaEnabled: false, browserLanguage: "en-GB", browserColorDepth: "24", browserScreenHeight: "1080", browserScreenWidth: "1920", browserTZ: "-60", browserUserAgent: "Mozilla/5.0 (simulated browser)" },
  };
}

const RISK = {
  Y: { riskLevel: "low", signals: ["Device has been used with this card before", "Amount is within the cardholder's normal range", "Billing country matches the device location"], decision: "Approve without asking the cardholder (frictionless)" },
  C: { riskLevel: "medium", signals: ["Device has not been seen with this card before", "Amount is above the cardholder's usual range"], decision: "Ask the cardholder to prove it is them (challenge)" },
  N: { riskLevel: "high", signals: ["Pattern looks like card testing", "Six attempts on this card in two minutes"], decision: "Deny the authentication" },
  A: { riskLevel: "not assessed", signals: ["Cardholder is not enrolled in 3-D Secure", "The card network's attempts server records the attempt instead"], decision: "Return proof of attempt" },
  U: { riskLevel: "unknown", signals: ["The issuer's ACS had a technical problem and did not answer in time"], decision: "Report that authentication could not be performed" },
  R: { riskLevel: "very high", signals: ["Card is reported lost or stolen"], decision: "Reject authentication and tell the merchant not to authorise" },
};

function outcomeFor(status, afterChallenge) {
  switch (status) {
    case "Y": return { liability: true, auth: "approved", pay: { ok: true, code: "SBX-2000", message: afterChallenge ? "Approved after 3D Secure" : "Approved with 3D Secure" }, takeaway: "Fully authenticated. For fraud chargebacks of the kind 'the cardholder did not make this purchase', liability moves from you to the issuer." };
    case "A": return { liability: true, auth: "approved", pay: { ok: true, code: "SBX-2000", message: "Approved with proof of authentication attempt" }, takeaway: "Proof of attempt only. Liability usually shifts to the issuer, but the exact rules depend on the card scheme and your acquirer." };
    case "U": return { liability: false, auth: "approved_without_liability_shift", pay: { ok: true, code: "SBX-2002", message: "Approved without liability shift (authentication unavailable)" }, takeaway: "No authentication took place. You may still choose to authorise, but you keep the fraud liability. This sandbox's merchant policy is to proceed." };
    case "R": return { liability: false, auth: "not_attempted", pay: { ok: false, code: "SBX-4032", message: "Authentication rejected by the issuer; do not retry with this card" }, takeaway: "The issuer refused the authentication. Do not authorise, and do not retry with the same card." };
    default: return { liability: false, auth: "not_attempted", pay: { ok: false, code: "SBX-4030", message: "3D Secure authentication failed" }, takeaway: afterChallenge ? "The cardholder did not pass the challenge. Do not authorise. If you did, you would carry all fraud liability." : "The issuer denied the authentication. Do not authorise. If you did, you would carry all fraud liability." };
  }
}

function areqAres(tr, status) {
  const ids = tr.ids;
  addStep(tr, { phase: "setup", kind: "info", from: ME, to: SERVER, name: "Start", title: "Merchant asks the 3DS Server to authenticate the cardholder",
    explain: "Before the payment is authorised, your server (or checkout page) asks a 3DS Server to check that the person paying really is the cardholder. You hand over the amount, currency, card and details about the customer's device.",
    payload: { amount: tr.ctx.amount, currency: tr.ctx.currency, card: "************" + tr.ctx.last4, ...(tr.ctx.scheme ? { cardScheme: SCH.SCHEMES[tr.ctx.scheme].name, schemeProgramme: SCH.tdsFor(tr.ctx.scheme).brand } : {}), channel: "browser" }, notes: { channel: "Browser checkout. Mobile apps use an SDK instead.", cardScheme: "The card network that issued the card, found from the first digits of the number.", schemeProgramme: "The network's name for its 3-D Secure programme. The protocol is the same EMV 3DS; the branding and some values (such as the ECI) differ." } }, 0);
  addStep(tr, { phase: "setup", from: SERVER, to: BROWSER, name: "3DS Method", title: "Device fingerprinting (3DS Method)",
    explain: "The 3DS Server loads a hidden page from the issuer's ACS in the customer's browser. The ACS quietly collects signals about the device for its risk analysis. If this finishes, the AReq says threeDSCompInd = Y.",
    payload: { threeDSMethodURL: "https://acs.issuer-bank.example/method", threeDSMethodData: { threeDSServerTransID: ids.threeDSServerTransID, threeDSMethodNotificationURL: "https://3ds-server.example/method-done" }, threeDSCompInd: "Y" },
    notes: { threeDSMethodURL: "Hidden iframe address supplied by the issuer.", threeDSCompInd: "Y = the 3DS Method completed, N = it did not, U = it was not used." } });
  addStep(tr, { phase: "authentication", from: SERVER, to: VIA, name: "AReq", title: "Authentication Request (AReq)",
    explain: "The 3DS Server asks the issuer to authenticate this payment. The message goes through the Directory Server, which finds the right issuer from the card number and forwards it to that issuer's Access Control Server (ACS).",
    payload: areqPayload(tr),
    notes: { ...SHARED_NOTES, messageCategory: "01 = payment authentication, 02 = non-payment.", deviceChannel: "02 = browser, 01 = app, 03 = 3DS Requestor Initiated.",
      threeDSRequestorAuthenticationInd: "01 = payment transaction.", threeDSCompInd: "Y = the 3DS Method finished.", acctNumber: "The card number. Only the last four digits are kept in this log.",
      purchaseAmount: "Amount in minor units (cents). 8900 means 89.00 when the exponent is 2.", purchaseCurrency: "ISO 4217 numeric code: 978 = EUR, 840 = USD, 826 = GBP.", purchaseExponent: "Decimal places in the currency.",
      browserInfo: "Device details the issuer uses for risk analysis. Simulated values here." } });
  const risk = RISK[status];
  addStep(tr, { phase: "authentication", kind: "decision", from: ACS, to: ACS, name: "Risk analysis", title: "Issuer assesses the risk (simulated)",
    explain: "Inside the bank, the ACS decides whether it needs to bother the customer. Real banks combine many signals such as device history, amount, location and spending habits. Here the card number you chose decides, and the signals are examples.",
    payload: { simulated: true, ...risk }, notes: { riskLevel: "Risk-based authentication: low risk is let through without friction.", decision: "What the ACS will do next." } }, jitter(40, 160));
  const ares = { messageType: "ARes", messageVersion: VERSION, threeDSServerTransID: ids.threeDSServerTransID, acsTransID: ids.acsTransID, dsTransID: ids.dsTransID, transStatus: status };
  if (REASON[status]) ares.transStatusReason = REASON[status];
  if (status === "Y" || status === "A") { ares.authenticationValue = tr.ctx.cavv; ares.eci = eci(tr, status); }
  if (status === "C") { ares.acsChallengeMandated = "Y"; ares.acsURL = "https://acs.issuer-bank.example/challenge"; }
  const notes = { ...SHARED_NOTES, transStatus: `${status} = ${LABEL[status]}. ${SHARED_NOTES.transStatus}` };
  if (ares.transStatusReason) notes.transStatusReason = `${ares.transStatusReason} = ${REASON_TEXT[ares.transStatusReason]}. Explains why the status is not Y.`;
  if (status === "C") { notes.acsChallengeMandated = "Y = the issuer requires a challenge."; notes.acsURL = "Where the cardholder's browser must go to take the challenge."; }
  addStep(tr, { phase: "authentication", from: VIA, to: SERVER, name: "ARes", title: `Authentication Response (ARes): transStatus ${status}`,
    explain: status === "C" ? "The issuer is not satisfied yet and asks for a challenge. No authentication value is issued until the cardholder passes it."
      : status === "Y" ? "The issuer authenticated the payment without involving the customer. The response carries the authentication value and ECI that you need for authorisation."
      : status === "A" ? "Full authentication was not possible, but the network recorded an attempt. The response carries proof of attempt and ECI " + eci(tr, "A") + "."
      : "No authentication value is issued. The reason code says why.",
    payload: ares, notes });
  addStep(tr, { phase: "authentication", kind: "info", from: SERVER, to: ME, name: "Result", title: status === "C" ? "3DS Server tells the merchant a challenge is required" : "3DS Server returns the result to the merchant",
    explain: status === "C" ? "Your page must now send the customer's browser to the issuer's challenge page (an iframe or redirect to acsURL)."
      : "The 3DS Server passes the outcome back to you. From here, your next step depends on transStatus.",
    payload: status === "C" ? { transStatus: "C", acsURL: "https://acs.issuer-bank.example/challenge", action: "Open the challenge in the customer's browser" }
      : { transStatus: status, eci: eci(tr, status), authenticationValue: tr.ctx.cavv || null, dsTransID: ids.dsTransID }, notes: SHARED_NOTES }, 0);
}

function authorization(tr, status, afterChallenge) {
  const o = outcomeFor(status, afterChallenge), ids = tr.ids;
  if (status === "Y" || status === "A" || status === "U") {
    addStep(tr, { phase: "authorization", from: ME, to: ACQ, name: "Authorization", title: status === "U" ? "Authorization request without 3DS proof" : "Authorization request with 3DS proof",
      explain: status === "U" ? "You send the payment for authorisation anyway. With no authentication value there is no liability shift."
        : "You send the normal authorisation request and add the 3DS data. This is what moves fraud liability to the issuer.",
      payload: { amount: tr.ctx.amount, currency: tr.ctx.currency, card: "************" + tr.ctx.last4, eci: eci(tr, status), authenticationValue: status === "U" ? null : tr.ctx.cavv, dsTransID: ids.dsTransID, threeDSVersion: VERSION },
      notes: { eci: SHARED_NOTES.eci, authenticationValue: status === "U" ? "Empty because no authentication happened." : SHARED_NOTES.authenticationValue, dsTransID: SHARED_NOTES.dsTransID } });
    addStep(tr, { phase: "authorization", from: ACQ, to: ME, name: "Authorization response", title: "Payment approved",
      explain: "The issuer approves the payment. " + (o.liability ? "Thanks to the 3DS data, you have liability protection for fraud chargebacks." : "There is no liability shift, so you carry the fraud risk."),
      payload: { responseCode: "00", message: "Approved", liabilityShift: o.liability }, notes: { responseCode: "00 = approved.", liabilityShift: "true = fraud liability moves to the issuer." } });
  } else {
    addStep(tr, { phase: "authorization", kind: "stop", from: ME, to: ME, name: "Stop", title: "Merchant does not authorise the payment",
      explain: o.takeaway, payload: { authorize: false, transStatus: status, liabilityShift: false },
      notes: { authorize: "A correct integration stops here and shows the customer a clear message." } });
  }
}

function finalise(tr, status, afterChallenge) {
  const o = outcomeFor(status, afterChallenge);
  tr.complete = true; tr.awaiting = null;
  tr.result = { trans_status: status, trans_status_label: LABEL[status], eci: eci(tr, status), authentication_value: status === "Y" || status === "A" ? tr.ctx.cavv : null, authentication_value_name: SCH.tdsFor(tr.ctx.scheme).authValueName, scheme_programme: SCH.tdsFor(tr.ctx.scheme).brand,
    liability_shift: o.liability, authorization: o.auth, merchant_takeaway: o.takeaway };
  tr.payment = o.pay;
  return tr;
}

function begin(ctx, status) {
  const tr = {
    protocol: `EMV 3-D Secure ${VERSION} (simulated)`, started_at: new Date().toISOString(), t0: Date.now(), clock: 0,
    ids: { threeDSServerTransID: uuid(), acsTransID: uuid(), dsTransID: uuid() },
    ctx: { amount: ctx.amount, currency: ctx.currency, last4: ctx.last4, scheme: ctx.scheme || null, cavv: status === "Y" || status === "A" ? crypto.randomBytes(20).toString("base64") : null },
    steps: [], complete: false, awaiting: null, result: null, payment: null,
  };
  areqAres(tr, status);
  if (status === "C") {
    const ids = tr.ids;
    addStep(tr, { phase: "challenge", from: BROWSER, to: ACS, name: "CReq", title: "Challenge Request (CReq)",
      explain: "The customer's browser opens the issuer's challenge page. This first request just asks the ACS to show the challenge.",
      payload: { messageType: "CReq", messageVersion: VERSION, threeDSServerTransID: ids.threeDSServerTransID, acsTransID: ids.acsTransID, challengeWindowSize: "05" },
      notes: { ...SHARED_NOTES, challengeWindowSize: "05 = full screen. Smaller sizes (01 to 04) are used for pop-up windows." } });
    addStep(tr, { phase: "challenge", from: ACS, to: BROWSER, name: "CRes", title: "Challenge Response (CRes): the bank shows its page",
      explain: "The bank's page asks the customer for proof, here a one-time code sent to their phone. challengeCompletionInd = N means the challenge is not finished yet.",
      payload: { messageType: "CRes", messageVersion: VERSION, threeDSServerTransID: ids.threeDSServerTransID, acsTransID: ids.acsTransID, acsUiType: "01", challengeInfoHeader: "Approve your payment", challengeInfoText: "Enter the code we sent to your phone ending in 42.", challengeCompletionInd: "N" },
      notes: { ...SHARED_NOTES, acsUiType: "01 = text, 02 = single select, 03 = multi select, 04 = out of band (banking app), 05 = HTML.", challengeCompletionInd: "N = more interaction needed, Y = the challenge is over." } });
    tr.awaiting = "cardholder";
    return tr;
  }
  authorization(tr, status, false);
  return finalise(tr, status, false);
}

function finishChallenge(tr, approved) {
  if (tr.complete || tr.awaiting !== "cardholder") return null;
  const ids = tr.ids, status = approved ? "Y" : "N";
  if (approved) tr.ctx.cavv = crypto.randomBytes(20).toString("base64");
  tr.clock = Math.max(tr.clock, Date.now() - tr.t0); // real time spent waiting for the cardholder
  addStep(tr, { phase: "challenge", from: BROWSER, to: ACS, name: "CReq", title: "Challenge Request (CReq) with the cardholder's answer",
    explain: approved ? "The customer types the correct code. The browser sends it to the bank." : "The customer types a wrong code. The browser sends it to the bank.",
    payload: { messageType: "CReq", messageVersion: VERSION, threeDSServerTransID: ids.threeDSServerTransID, acsTransID: ids.acsTransID, challengeDataEntry: "******" },
    notes: { challengeDataEntry: "What the customer typed. Masked in this log." } }, 0);
  addStep(tr, { phase: "challenge", from: ACS, to: BROWSER, name: "CRes", title: `Challenge Response (CRes): transStatus ${status}`,
    explain: approved ? "The code is right. The ACS closes the challenge and tells the browser it is finished." : "The code is wrong. The ACS closes the challenge as failed (real banks usually allow a few retries first).",
    payload: { messageType: "CRes", messageVersion: VERSION, threeDSServerTransID: ids.threeDSServerTransID, acsTransID: ids.acsTransID, transStatus: status, challengeCompletionInd: "Y" },
    notes: { ...SHARED_NOTES, challengeCompletionInd: "Y = the challenge is over." } });
  const rreq = { messageType: "RReq", messageVersion: VERSION, threeDSServerTransID: ids.threeDSServerTransID, acsTransID: ids.acsTransID, dsTransID: ids.dsTransID, transStatus: status, eci: eci(tr, status), interactionCounter: "01" };
  if (approved) rreq.authenticationValue = tr.ctx.cavv;
  addStep(tr, { phase: "challenge", from: VIA, to: SERVER, name: "RReq", title: "Results Request (RReq): the bank reports the final outcome",
    explain: "Separately from the browser, the ACS sends the final result to the 3DS Server through the Directory Server. This is the message you can trust. Never rely only on what the browser says.",
    payload: rreq, notes: { ...SHARED_NOTES, interactionCounter: "How many times the cardholder interacted with the challenge." } });
  addStep(tr, { phase: "challenge", from: SERVER, to: VIA, name: "RRes", title: "Results Response (RRes): acknowledgement",
    explain: "The 3DS Server confirms it received the result.",
    payload: { messageType: "RRes", messageVersion: VERSION, threeDSServerTransID: ids.threeDSServerTransID, acsTransID: ids.acsTransID, dsTransID: ids.dsTransID, resultsStatus: "01" },
    notes: { ...SHARED_NOTES, resultsStatus: "01 = results received." } });
  addStep(tr, { phase: "challenge", kind: "info", from: SERVER, to: ME, name: "Result", title: "3DS Server returns the final result to the merchant",
    explain: "The 3DS Server passes the outcome back to you. Now you know whether to authorise.",
    payload: { transStatus: status, eci: eci(tr, status), authenticationValue: approved ? tr.ctx.cavv : null, dsTransID: ids.dsTransID }, notes: SHARED_NOTES }, 0);
  authorization(tr, status, true);
  return finalise(tr, status, true);
}

const summary = (tr) => ({ protocol: "3ds2", trans_status: tr.result ? tr.result.trans_status : "C", eci: tr.result ? tr.result.eci : null, liability_shift: tr.result ? tr.result.liability_shift : null, scheme: tr.ctx.scheme || null });

function publicLog(tr, paymentId) {
  return { payment_id: paymentId, protocol: tr.protocol, started_at: tr.started_at, complete: tr.complete, awaiting: tr.awaiting, ids: tr.ids, steps: tr.steps, result: tr.result };
}

module.exports = { CARDS, begin, finishChallenge, summary, publicLog };
