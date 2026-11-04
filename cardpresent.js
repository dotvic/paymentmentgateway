"use strict";
// Card-present lab: POS terminals and ATMs, with chip (EMV), contactless, magnetic stripe, fallback and manual entry.
//
// One request plays the whole chain: card, terminal and issuer. The lab builds the card's chip data (or reads the track
// or PIN block you send), checks it the way an issuer would (application cryptogram, CVV1/CVV2, PIN, expiry, limits),
// and then lets the existing payment engine decide, so the result shows up in payments, disputes and settlement.
// Test cards only. Keys are test keys (see emv.js). Response codes are simplified ISO 8583 field 39 values.
const EMV = require("./emv");
const MAG = require("./mag");
const SCH = require("./schemes");

const TYPES = {
  // POS
  sale: { channels: ["pos"], financial: true, maps: "purchase", label: "Sale", help: "Goods and services paid at the terminal." },
  auth: { channels: ["pos"], financial: true, maps: "authorization", label: "Pre-authorisation", help: "Reserves the amount; capture it later with a completion (hotels, fuel, car hire)." },
  completion: { channels: ["pos"], financial: true, maps: "capture-authorization", parent: true, label: "Completion", help: "Captures a pre-authorisation, for the same or a lower amount." },
  incremental_auth: { channels: ["pos"], financial: true, parent: true, label: "Incremental authorisation", help: "Raises the amount of an open pre-authorisation, for example a longer hotel stay." },
  void: { channels: ["pos"], financial: true, maps: "void", parent: true, label: "Void", help: "Cancels a transaction before it is cleared." },
  reversal: { channels: ["pos", "atm"], financial: true, maps: "void", parent: true, label: "Reversal", help: "Undoes a transaction the terminal could not complete (timeout, device failure, customer cancelled)." },
  refund: { channels: ["pos"], financial: true, maps: "refund", parent: true, label: "Refund", help: "Returns money for an earlier sale." },
  cashback: { channels: ["pos"], financial: true, maps: "purchase", pin: true, label: "Sale with cashback", help: "A sale plus cash handed over at the till. Needs a PIN." },
  cash_advance: { channels: ["pos", "atm"], financial: true, maps: "purchase", pin: true, mcc: "6010", label: "Cash advance", help: "Cash against a credit card at a bank counter or ATM. Needs a PIN." },
  quasi_cash: { channels: ["pos"], financial: true, maps: "purchase", mcc: "6051", label: "Quasi-cash", help: "Something as good as cash: chips, money orders, prepaid top-ups." },
  oct: { channels: ["pos"], financial: true, maps: "purchase", oct: true, mcc: "6540", label: "Original credit transaction (OCT)", help: "Pushes money to a card, for example a payout. Money flows to the cardholder." },
  aft: { channels: ["pos"], financial: true, maps: "purchase", mcc: "6540", label: "Account funding transaction (AFT)", help: "Pulls money from a card to fund another account or wallet." },
  // ATM
  withdrawal: { channels: ["atm"], financial: true, maps: "purchase", pin: true, mcc: "6011", label: "Cash withdrawal", help: "Cash from your bank account. Multiples of 10, 500 a day." },
  balance_inquiry: { channels: ["atm"], financial: false, pin: true, label: "Balance inquiry", help: "Shows the account balance. No money moves." },
  mini_statement: { channels: ["atm"], financial: false, pin: true, label: "Mini statement", help: "The last ten ATM transactions and the balance." },
  pin_change: { channels: ["atm"], financial: false, pin: true, label: "PIN change", help: "Checks the old PIN and sets a new one." },
};
const ENTRY = {
  chip: { code: "05", label: "Chip (EMV contact)", channels: ["pos", "atm"] },
  contactless: { code: "07", label: "Contactless chip", channels: ["pos"] },
  magstripe: { code: "90", label: "Magnetic stripe", channels: ["pos", "atm"] },
  fallback: { code: "80", label: "Fallback to stripe after a failed chip read", channels: ["pos", "atm"] },
  manual: { code: "01", label: "Manual key entry", channels: ["pos"] },
};
const CODES = {
  "00": "Approved", "05": "Do not honor", "51": "Insufficient funds", "54": "Expired card", "55": "Incorrect PIN", "57": "Transaction not permitted to cardholder", "61": "Exceeds withdrawal limit",
  "62": "Restricted card: use the chip", "75": "Allowable number of PIN tries exceeded", "82": "Cryptogram or card verification failed", "91": "Issuer or switch inoperative", "N7": "CVV2 mismatch", "1A": "Additional customer authentication required (use chip and PIN)",
};
const LIMITS = { floor: 50, contactless: 100, cashback_max: 100, atm_daily: 500, atm_step: 10, opening_balance: 2000 };
const REVERSAL_REASONS = ["timeout", "customer_cancelled", "device_failure", "malfunction"];
const TAMPER = ["arqc", "amount_after_signing", "atc_replay", "unpredictable_number", "wrong_pin", "expired_card", "wrong_cvv"];
const DEFAULT_PIN = "1234", MAX_PIN_TRIES = 3;

module.exports = function createCardPresent({ bad, rnd, r2, createPayment }) {
  const today = () => new Date().toISOString().slice(0, 10);
  const state = (acc) => (acc.cp = acc.cp || { atc: {}, tries: {}, pvv: {}, log: [] });
  const yymmdd = () => today().slice(2).replace(/-/g, "");
  const pinOf = (cp, pan) => cp.pvv[pan] || MAG.pvv(pan, DEFAULT_PIN);

  function catalog() {
    return {
      transaction_types: Object.entries(TYPES).map(([id, t]) => ({ id, channels: t.channels, label: t.label, financial: t.financial, needs_parent: !!t.parent, needs_pin: !!t.pin, description: t.help })),
      entry_modes: Object.entries(ENTRY).map(([id, e]) => ({ id, pos_entry_code: e.code, label: e.label, channels: e.channels })),
      response_codes: CODES, limits: LIMITS, tamper_options: TAMPER, test_pin: DEFAULT_PIN,
      test_cards: SCH.TEST_CARDS.map((c) => { const t = MAG.buildTracks(c.number); return { ...c, expiry: t.expiry, service_code: t.service_code, cvv1: t.cvv1, cvv2: MAG.cvv(c.number, t.expiry, "000"), track2: t.track2 }; }),
      note: "Zanboxx plays the card, the terminal and the issuer with made-up test keys. Test cards only. Every test card has the PIN " + DEFAULT_PIN + ".",
    };
  }

  function check(cond, status, code, message) { if (!cond) throw bad(status, code, message); }

  // Runs one card-present transaction. Returns { status, body }.
  function run(acc, b) {
    const cp = state(acc), flow = [];
    const step = (title, detail, ok = true, data) => flow.push({ n: flow.length + 1, title, detail, ok, ...(data ? { data } : {}) });
    const channel = b.channel === undefined ? "pos" : b.channel;
    check(["pos", "atm"].includes(channel), 400, "invalid_request", "channel must be pos or atm");
    const type = TYPES[b.transaction_type];
    check(type, 400, "invalid_request", `transaction_type must be one of ${Object.keys(TYPES).join(", ")}`);
    check(type.channels.includes(channel), 422, "SBX-4260", `${type.label} is not available on a ${channel.toUpperCase()}. It is available on: ${type.channels.join(", ").toUpperCase()}`);
    const tid = b.transaction_type;
    for (const k of Object.keys(b)) check(["channel", "transaction_type", "entry_mode", "amount", "currency", "cashback_amount", "card_number", "expiry", "track1", "track2", "card_cvv", "pin", "pin_block", "new_pin", "emv", "tamper", "parent_transaction_id", "reversal_reason", "mcc", "terminal_id", "psn", "device", "request_id", "service_code"].includes(k), 400, "invalid_request", `Unknown field "${k}"`);
    if (b.tamper !== undefined) check(TAMPER.includes(b.tamper), 400, "invalid_request", `tamper must be one of ${TAMPER.join(", ")}`);
    const entryName = b.entry_mode === undefined ? (channel === "atm" ? "chip" : "chip") : b.entry_mode;
    const entry = ENTRY[entryName];
    check(entry, 400, "invalid_request", `entry_mode must be one of ${Object.keys(ENTRY).join(", ")}`);
    check(entry.channels.includes(channel), 422, "SBX-4261", `${entry.label} is not possible on a ${channel.toUpperCase()}`);
    const currency = b.currency === undefined ? "EUR" : b.currency;
    check(["EUR", "USD", "GBP"].includes(currency), 400, "invalid_request", "currency must be EUR, USD or GBP");
    const terminal = b.terminal_id === undefined ? (channel === "atm" ? "ATM00001" : "POS00001") : String(b.terminal_id);
    check(/^[A-Za-z0-9_-]{1,16}$/.test(terminal), 400, "invalid_request", "terminal_id must be 1 to 16 letters, digits, - or _");
    const mcc = b.mcc === undefined ? type.mcc || "5999" : String(b.mcc);
    check(/^\d{4}$/.test(mcc), 400, "invalid_request", "mcc must be 4 digits");

    // ---- follow-up transactions work on a parent and need no card ----
    if (type.parent) return followUp(acc, cp, b, type, tid, channel, entryName, entry, terminal, mcc, flow, step);

    // ---- amounts ----
    let amount = Number(b.amount), other = 0;
    if (type.financial) {
      check(amount > 0 && amount <= 1e5, 400, "invalid_request", "amount must be between 0.01 and 100000");
      if (tid === "cashback") { other = Number(b.cashback_amount); check(other > 0 && other <= LIMITS.cashback_max, 400, "invalid_request", `cashback_amount must be between 0.01 and ${LIMITS.cashback_max}`); check(amount > other, 400, "invalid_request", "amount is the total charged and must be larger than cashback_amount"); }
      else check(b.cashback_amount === undefined, 400, "invalid_request", "cashback_amount belongs on a cashback transaction");
      if (tid === "withdrawal") { check(Number.isInteger(amount) && amount % LIMITS.atm_step === 0, 422, "SBX-4262", `ATM cash comes in notes: the amount must be a multiple of ${LIMITS.atm_step}`); }
    } else { check(b.amount === undefined, 400, "invalid_request", `${type.label} does not carry an amount`); amount = 0; }
    amount = r2(amount);

    // ---- the card: from a track (stripe), or a test card number ----
    let pan = b.card_number === undefined ? null : String(b.card_number).replace(/\s/g, ""), t1 = null, t2 = null;
    if (b.track2 !== undefined) { t2 = MAG.parseTrack2(b.track2); check(t2, 400, "invalid_request", "track2 must look like ;PAN=YYMMSSSDDDD?"); }
    if (b.track1 !== undefined) { t1 = MAG.parseTrack1(b.track1); check(t1, 400, "invalid_request", "track1 must look like %BPAN^NAME^YYMMSSSDDDD?"); }
    if (!pan) pan = (t2 || t1 || {}).pan || null;
    check(pan, 400, "invalid_request", "Send card_number (a Zanboxx test card) or track2");
    const tc = MAG.testCard(pan);
    check(tc, 422, "SBX-4263", "Card-present tests work with the Zanboxx test cards only (see /v1/card-present). Never enter real card data.");
    for (const t of [t1, t2]) check(!t || t.pan === pan, 400, "invalid_request", "track1, track2 and card_number must be the same card");
    const tamper = b.tamper;
    const svc = b.service_code === undefined ? "201" : String(b.service_code);
    check(/^\d{3}$/.test(svc), 400, "invalid_request", "service_code must be 3 digits");
    const expiry = tamper === "expired_card" ? "2201" : b.expiry === undefined ? MAG.expiryFor(pan) : String(b.expiry);
    check(/^\d{4}$/.test(expiry), 400, "invalid_request", "expiry must be YYMM");
    step("Card read", `${tc.scheme.toUpperCase()} test card ${MAG.maskPan(pan)}, expiry ${expiry.slice(2)}/${expiry.slice(0, 2)}, entry: ${entry.label}.`, true, { service_code: MAG.describeServiceCode(svc) });

    const decline = (code, why, extra = {}) => finish(acc, cp, { code, why, tc, pan, amount, other, currency, type, tid, channel, entryName, entry, terminal, mcc, flow, step, b, ...extra });
    // expiry
    if (expiry < today().slice(2, 4) + today().slice(5, 7)) { step("Expiry check", `The card expired in ${expiry.slice(2)}/${expiry.slice(0, 2)}.`, false); return decline("54", "The card has expired."); }

    // ---- entry mode rules ----
    const sc = MAG.describeServiceCode(svc);
    let arqcInfo = null, cvm = "none";
    if (entryName === "magstripe" || entryName === "fallback") {
      const cvvGiven = t2 ? t2.cvv : MAG.buildTracks(pan, { expiry, serviceCode: svc }).cvv1;
      const want = MAG.cvv(pan, expiry, svc);
      const cvvSent = tamper === "wrong_cvv" ? String((Number(cvvGiven) + 1) % 1000).padStart(3, "0") : cvvGiven;
      if (sc.chip && entryName === "magstripe") { step("Service code", `Service code ${svc} says this is a chip card. A chip card swiped on a stripe reader is refused: use the chip, and only fall back to the stripe after the chip failed to read.`, false); return decline("62", "Chip card swiped: use the chip."); }
      step("Service code", `${svc}: ${sc.interchange}; ${sc.authorisation}; ${sc.services}.`);
      if (entryName === "fallback") step("Fallback", "The terminal first tried the chip, the chip could not be read, and the terminal then accepted the stripe. The issuer sees entry mode 80 and can apply stricter rules.");
      const ok = cvvSent === want;
      step("CVV1 check", ok ? `CVV1 ${cvvSent} matches the value the issuer computes from PAN, expiry and service code.` : `CVV1 ${cvvSent} does not match the expected value. A copied or damaged stripe often fails here.`, ok);
      if (!ok) return decline("82", "CVV1 on the stripe is wrong.");
    } else if (entryName === "manual") {
      const want = MAG.cvv(pan, expiry, "000");
      step("CVV2 check", b.card_cvv === undefined ? "No CVV2 sent." : `CVV2 ${b.card_cvv} ${String(b.card_cvv) === want ? "matches" : "does not match"} the value computed with service code 000.`, String(b.card_cvv) === want);
      if (String(b.card_cvv) !== want) return decline("N7", "CVV2 does not match.");
    } else {
      // chip or contactless: build the card's data, the terminal's data, and let the issuer check the cryptogram
      const psn = b.psn === undefined ? "00" : String(b.psn);
      check(/^\d{2}$/.test(psn), 400, "invalid_request", "psn must be 2 digits");
      const lastAtc = cp.atc[pan] || 0, e = b.emv || {};
      check(typeof e === "object" && !Array.isArray(e), 400, "invalid_request", "emv must be an object");
      for (const k of Object.keys(e)) check(["atc", "un", "aip", "iad", "tvr", "country", "date", "arqc"].includes(k), 400, "invalid_request", `Unknown emv field "${k}". Allowed: atc, un, aip, iad, tvr, country, date, arqc`);
      const atcN = e.atc === undefined ? (tamper === "atc_replay" ? Math.max(1, lastAtc) : lastAtc + 1) : parseInt(e.atc, 16);
      check(Number.isInteger(atcN) && atcN > 0 && atcN < 65536, 400, "invalid_request", "emv.atc must be 1 to 4 hex digits, above 0");
      const needPin = !!type.pin || channel === "atm";
      const contactless = entryName === "contactless";
      if (contactless && amount > LIMITS.contactless) { step("Contactless limit", `${amount.toFixed(2)} is above the contactless limit of ${LIMITS.contactless}. The terminal asks the customer to insert the card instead.`, false); return decline("1A", "Over the contactless limit: use chip and PIN."); }
      const wantOnlinePin = needPin || (contactless && amount > LIMITS.floor && b.device !== "mobile");
      const flags = [];
      if (wantOnlinePin) flags.push("Online PIN entered");
      if (amount >= LIMITS.floor) flags.push("Transaction exceeds floor limit");
      if (tamper === "expired_card") flags.push("Application expired");
      const f = {
        amount: amount + other, other, country: e.country || "0276", tvr: e.tvr || EMV.encodeTvr(flags), currency, date: e.date || yymmdd(), type: EMV.TXN_TYPE_CODE[tid] || "00",
        un: e.un || EMV.hex(require("crypto").randomBytes(4)), aip: e.aip || "1980", atc: atcN.toString(16).toUpperCase().padStart(4, "0"), iad: e.iad || "0110A00003220000",
      };
      f.amount = tid === "cashback" ? amount - other : amount; // 9F02 is the goods amount; 9F03 the cashback
      const signed = e.arqc || EMV.hex(EMV.generateArqc(pan, psn, f));
      let sent = signed, seen = { ...f };
      if (tamper === "arqc") { const bb = EMV.fromHex(signed); bb[7] ^= 1; sent = EMV.hex(bb); }
      if (tamper === "amount_after_signing") seen = { ...f, amount: f.amount + 1 };
      if (tamper === "unpredictable_number") seen = { ...f, un: EMV.hex(EMV.xor(EMV.fromHex(f.un), Buffer.from([0, 0, 0, 1]))) };
      step("Card application selected", `AIP ${f.aip}, ATC ${f.atc}. The card builds the data to sign (CDOL1): amount ${f.amount.toFixed(2)}, other ${f.other.toFixed(2)}, country ${f.country}, TVR ${f.tvr}, currency ${EMV.CURRENCY_NUM[currency]}, date ${f.date}, type ${f.type}, unpredictable number ${f.un}, AIP, ATC, issuer application data.`, true, { cdol1_tags: EMV.CDOL1.map((t) => `${t} ${EMV.TAGS[t]}`) });
      step("Terminal risk management", `TVR ${f.tvr}: ${EMV.decodeTvr(f.tvr).join("; ") || "no flags set"}.`, true, { tvr: EMV.decodeTvr(f.tvr) });
      step("Generate AC", `The card returns a cryptogram (CID 80 = ARQC, online authorisation requested): ${sent}. It is a MAC over the data above with a key unique to this card and this ATC (the ICC session key), so it proves the card is genuine and the data was not changed.`, true,
        { tlv: EMV.tlvDecode(Buffer.concat([EMV.tlvEncode("9F27", "80"), EMV.tlvEncode("9F26", sent), EMV.tlvEncode("9F36", f.atc), EMV.tlvEncode("9F10", f.iad)])) });
      const v = EMV.verifyArqc(pan, psn, seen, sent);
      if (!v.valid) {
        step("Issuer checks the ARQC", `The issuer recomputes the cryptogram from the data it received and gets ${v.expected}, not ${sent}. ${tamper === "arqc" ? "A bit of the cryptogram was changed." : tamper === "amount_after_signing" ? "The amount at the issuer differs from the amount the card signed." : tamper === "unpredictable_number" ? "The unpredictable number differs: the terminal changed it after signing." : "The data does not match what the card signed."} Declined.`, false, { expected: v.expected, received: sent });
        return decline("82", "The application cryptogram is invalid.", { emv: { arqc: sent, expected_arqc: v.expected, atc: f.atc, valid: false } });
      }
      if (atcN <= lastAtc) { step("Issuer checks the ATC", `ATC ${f.atc} (${atcN}) is not above the last one seen for this card (${lastAtc}). A replayed cryptogram has an old counter. Declined.`, false); return decline("82", "ATC replay: the transaction counter did not increase.", { emv: { arqc: sent, atc: f.atc, valid: true, replay: true } }); }
      cp.atc[pan] = atcN;
      step("Issuer checks the ARQC", `Recomputed ${v.expected}: it matches. The card is genuine, the data is unchanged and ATC ${f.atc} is new (last seen ${lastAtc}).`, true);
      const arc = "00", arpc = EMV.hex(EMV.generateArpc(pan, psn, f.atc, sent, arc));
      arqcInfo = { arqc: sent, atc: f.atc, arpc, arc, tvr: f.tvr, tvr_flags: EMV.decodeTvr(f.tvr), cid: EMV.decodeCid("80"), aip: f.aip, un: f.un, valid: true, tsi: "F800", tsi_flags: EMV.decodeTsi("F800") };
      cvm = wantOnlinePin ? "online_pin" : contactless ? (b.device === "mobile" ? "cdcvm" : "no_cvm") : "no_cvm";
    }
    if (entryName === "magstripe" || entryName === "fallback") cvm = (type.pin || channel === "atm") ? "online_pin" : "signature";

    // ---- PIN ----
    if (cvm === "online_pin") {
      const pinIn = b.pin !== undefined ? String(b.pin) : null;
      check(pinIn || b.pin_block, 400, "invalid_request", `${type.label} needs a PIN: send pin (the lab encrypts it) or pin_block (ISO format 0, encrypted)`);
      let pin = pinIn; let pb = null;
      if (b.pin_block) { pin = MAG.parsePinBlock(String(b.pin_block), pan); pb = String(b.pin_block); step("PIN block", pin ? "The encrypted PIN block was decrypted with the terminal PIN key and unpacked (ISO format 0: the PIN is XORed with the card number, so the same PIN gives a different block on every card)." : "The PIN block could not be decrypted into a valid ISO format 0 block (wrong key, wrong card or damaged).", !!pin); if (!pin) return decline("55", "The PIN block is not valid for this card."); }
      else { if (!/^\d{4,12}$/.test(pin)) throw bad(400, "invalid_request", "pin must be 4 to 12 digits"); const sentPin = tamper === "wrong_pin" ? (pin === "0000" ? "1111" : "0000") : pin; pb = MAG.buildPinBlock(sentPin, pan); pin = sentPin; step("PIN entry", `The customer types a PIN on the encrypted PIN pad. The pad forms an ISO format 0 block (${pb.clear_block.replace(/./g, "•")} before encryption) and encrypts it under the terminal PIN key: ${pb.encrypted}.`, true); }
      const tries = cp.tries[pan] || 0;
      if (tries >= MAX_PIN_TRIES) { step("PIN try counter", `The card already had ${MAX_PIN_TRIES} wrong PINs in a row and is blocked. Reset it by calling POST /v1/card-present/reset-pin-tries.`, false); return decline("75", "PIN tries exceeded: the card is blocked for PIN use."); }
      const okPin = MAG.pvv(pan, pin) === pinOf(cp, pan);
      if (!okPin) { cp.tries[pan] = tries + 1; step("PIN verification", `The issuer turns the PIN into a PIN verification value (PVV) with its PIN verification key and compares it with the PVV on file: no match. Wrong tries: ${tries + 1} of ${MAX_PIN_TRIES}.`, false); return decline(tries + 1 >= MAX_PIN_TRIES ? "75" : "55", tries + 1 >= MAX_PIN_TRIES ? "Third wrong PIN: the card is blocked for PIN use." : "Incorrect PIN."); }
      cp.tries[pan] = 0;
      step("PIN verification", "The issuer turned the PIN into a PIN verification value (PVV) and it matches the PVV on file. The try counter is reset. The issuer never stores the PIN itself.");
    } else step("Cardholder verification", cvm === "signature" ? "Signature: the cashier compares the signature on the receipt with the card." : cvm === "cdcvm" ? "Consumer device CVM: the phone checked the customer (fingerprint, face or passcode)." : "No cardholder verification was needed for this amount.");

    // ---- service code restrictions ----
    if (["withdrawal", "cash_advance", "quasi_cash", "cashback"].includes(tid) && sc && !sc.cash_allowed && entryName !== "chip" && entryName !== "contactless") { step("Service code", `Service code ${svc} allows goods and services only, not cash.`, false); return decline("57", "The card is not allowed to take cash."); }

    // ---- non-financial ATM services ----
    if (!type.financial) return nonFinancial(acc, cp, { pan, tc, tid, type, channel, entryName, entry, terminal, flow, step, b, cvm, arqcInfo, currency });

    // ---- ATM withdrawal limits ----
    if (tid === "withdrawal") {
      const used = atmToday(acc, pan.slice(-4));
      if (used + amount > LIMITS.atm_daily) { step("Withdrawal limit", `Already withdrawn today: ${used.toFixed(2)}. Adding ${amount.toFixed(2)} would pass the daily limit of ${LIMITS.atm_daily}.`, false); return decline("61", "Over the daily ATM withdrawal limit."); }
      const bal = balance(acc, pan.slice(-4));
      if (amount > bal) { step("Balance check", `Available ${bal.toFixed(2)} is less than ${amount.toFixed(2)}.`, false); return decline("51", "Insufficient funds in the account."); }
      step("Withdrawal limits", `Today so far ${used.toFixed(2)} of ${LIMITS.atm_daily}; balance ${bal.toFixed(2)}.`);
    }

    // ---- issuer decision, by the same payment engine as every other test ----
    const outcome = tc.outcome.startsWith("3ds") ? "approve" : "auto";
    const res = createPayment(acc, { request_id: b.request_id || "cp_" + rnd(8), method: "card", transaction_type: type.maps, amount, currency, card_number: pan, scenario: outcome });
    return finishPayment(acc, cp, res, { pan, tc, amount, other, currency, type, tid, channel, entryName, entry, terminal, mcc, flow, step, cvm, arqcInfo });
  }

  function atmPayments(acc, last4) { return acc.payments.filter((p) => p.cp && p.cp.channel === "atm" && p.card_last4 === last4 && p.transaction_state === "success" && p.transaction_type === "purchase" && !p.voided); }
  const atmToday = (acc, last4) => atmPayments(acc, last4).filter((p) => p.created_at.slice(0, 10) === today()).reduce((a, p) => a + p.amount, 0);
  const balance = (acc, last4) => r2(LIMITS.opening_balance - atmPayments(acc, last4).reduce((a, p) => a + p.amount, 0));

  function nonFinancial(acc, cp, c) {
    const last4 = c.pan.slice(-4), out = { transaction_type: c.tid, channel: c.channel, terminal_id: c.terminal, entry_mode: c.entryName, pos_entry_mode: c.entry.code + "1", cvm: c.cvm, response_code: "00", response_message: CODES["00"], approved: true };
    if (c.tid === "balance_inquiry") { out.balance = { available: balance(acc, last4), currency: c.currency }; c.step("Balance inquiry", `The issuer answers with the available balance: ${out.balance.available.toFixed(2)} ${c.currency}. No money moves, so this creates no payment.`); }
    if (c.tid === "mini_statement") { out.statement = atmPayments(acc, last4).slice(0, 10).map((p) => ({ transaction_id: p.id, date: p.created_at, type: p.cp.transaction_type, amount: -p.amount, currency: p.currency })); out.balance = { available: balance(acc, last4), currency: c.currency }; c.step("Mini statement", `The issuer returns the last ${out.statement.length} ATM transactions and the balance ${out.balance.available.toFixed(2)} ${c.currency}.`); }
    if (c.tid === "pin_change") {
      const np = c.b.new_pin;
      if (!/^\d{4,12}$/.test(String(np || ""))) throw bad(400, "invalid_request", "new_pin must be 4 to 12 digits");
      if (String(np) === String(c.b.pin)) { c.step("PIN change", "The new PIN is the same as the old one. The issuer refuses.", false); out.approved = false; out.response_code = "57"; out.response_message = "New PIN must differ from the old PIN"; }
      else if (/^(\d)\1+$/.test(np) || "01234567890123456789".includes(np) || "98765432109876543210".includes(np)) { c.step("PIN change", "The new PIN is too easy to guess (repeated or sequential digits). The issuer refuses.", false); out.approved = false; out.response_code = "57"; out.response_message = "New PIN is too weak"; }
      else { cp.pvv[c.pan] = MAG.pvv(c.pan, String(np)); cp.tries[c.pan] = 0; c.step("PIN change", `The issuer checked the old PIN, then stored a new PIN verification value (${cp.pvv[c.pan]}) for this card. Use the new PIN from now on. The PIN itself is never stored.`); }
    }
    return log(acc, cp, { status: 200, body: { ...out, ...(c.arqcInfo ? { emv: c.arqcInfo } : {}), flow: c.flow } }, c);
  }

  function followUp(acc, cp, b, type, tid, channel, entryName, entry, terminal, mcc, flow, step) {
    const parent = acc.payments.find((p) => p.id === b.parent_transaction_id);
    check(b.parent_transaction_id, 400, "invalid_request", `${type.label} needs parent_transaction_id`);
    check(parent, 404, "not_found", "parent_transaction_id not found");
    check(parent.method === "card", 422, "SBX-4229", "Parent transaction used a different payment method");
    const pinfo = { transaction_type: tid, channel, entry_mode: entryName, pos_entry_mode: entry.code + "0", terminal_id: terminal, mcc };
    if (tid === "reversal") { check(b.reversal_reason === undefined || REVERSAL_REASONS.includes(b.reversal_reason), 400, "invalid_request", `reversal_reason must be one of ${REVERSAL_REASONS.join(", ")}`); pinfo.reversal_reason = b.reversal_reason || "timeout"; }
    else check(b.reversal_reason === undefined, 400, "invalid_request", "reversal_reason belongs on a reversal");
    if (tid === "incremental_auth") {
      const inc = Number(b.amount);
      check(inc > 0, 400, "invalid_request", "amount is the extra amount to add and must be greater than 0");
      check(parent.transaction_type === "authorization" && parent.transaction_state === "success" && !parent.voided, 422, "SBX-4264", "Only a successful, open pre-authorisation can be increased");
      check(!(parent.captured_amount > 0), 422, "SBX-4265", "This pre-authorisation was already captured (partly or fully); start a new one");
      const total = r2(parent.amount + inc);
      check(total <= 1e5, 422, "SBX-4266", "The new total is above the maximum of 100000");
      (parent.increments = parent.increments || []).push({ at: new Date().toISOString(), added: r2(inc), total });
      parent.amount = total; step("Incremental authorisation", `The open authorisation of ${r2(total - inc).toFixed(2)} was raised by ${inc.toFixed(2)} to ${total.toFixed(2)} ${parent.currency}. The same transaction ID stays; you capture the new total later. In real life the issuer can refuse and the original amount stays reserved.`);
      parent.cp = { ...(parent.cp || {}), incremented: true }; save(acc);
      return log(acc, cp, { status: 200, body: { transaction_type: tid, approved: true, response_code: "00", response_message: CODES["00"], payment: parent, flow } }, { tid, channel, entryName, pan: null });
    }
    if (tid === "refund" || tid === "reversal" || tid === "void" || tid === "completion") {
      const amount = tid === "void" || tid === "reversal" ? parent.amount : Number(b.amount);
      const res = createPayment(acc, { request_id: b.request_id || "cp_" + rnd(8), method: "card", transaction_type: type.maps, amount, parent_transaction_id: parent.id });
      step(type.label, `${type.label} sent against ${parent.id}${pinfo.reversal_reason ? " (reason: " + pinfo.reversal_reason + ")" : ""}. No card is needed: the issuer already knows the original transaction.`, res.status === 201 || res.status === 200);
      const p = res.body && res.body.id && acc.payments.find((x) => x.id === res.body.id);
      if (p) { p.cp = { channel, ...pinfo }; p._cpflow = flow; }
      const okf = !!(p && p.transaction_state === "success");
      return log(acc, cp, { status: res.status, body: res.body && res.body.id ? { ...res.body, approved: okf, response_code: okf ? "00" : "05", response_message: okf ? CODES["00"] : CODES["05"], ...(p ? { cp: p.cp } : {}), flow } : res.body }, { tid, channel, entryName, pan: null });
    }
    throw bad(500, "internal_error", "unhandled");
  }
  let save = () => {};

  function finishPayment(acc, cp, res, c) {
    const p = res.body && res.body.id && acc.payments.find((x) => x.id === res.body.id);
    const ok = p && p.transaction_state === "success";
    const iso = ok ? "00" : tcCode(c.tc.outcome);
    if (p) {
      p.cp = { channel: c.channel, transaction_type: c.tid, entry_mode: c.entryName, pos_entry_mode: c.entry.code + (c.cvm === "online_pin" ? "1" : "2"), cvm: c.cvm, terminal_id: c.terminal, mcc: c.mcc, response_code: iso, ...(c.other ? { cashback_amount: c.other } : {}), ...(c.arqcInfo ? { atc: c.arqcInfo.atc } : {}) };
      if (c.type.oct) { p.transaction_type = "refund"; p.oct = true; p.cp.direction = "to_cardholder"; delete p.refunded_amount; }
      if (c.tid === "aft") p.cp.business_application_id = "AA";
      p._cpflow = c.flow;
    }
    c.step("Issuer decision", ok ? `The issuer approved (response ${iso}). ${c.arqcInfo ? "It returns an issuer authentication cryptogram (ARPC " + c.arqcInfo.arpc + ") so the card can check the answer really came from its issuer." : ""}` : `The issuer declined: ${CODES[iso] || res.body && res.body.status && res.body.status.message}.`, !!ok);
    if (c.type.oct) c.step("Original credit transaction", "Money flows TO the cardholder. In settlement this shows as a credit, like a refund without an original sale.");
    const body = { ...(res.body && res.body.id ? { ...res.body, ...(p ? { transaction_type: p.transaction_type, ...(p.oct ? { oct: true } : {}) } : {}) } : { error: res.body }), approved: !!ok, response_code: iso, response_message: CODES[iso] || "Declined", cvm: c.cvm, ...(c.arqcInfo ? { emv: c.arqcInfo } : {}), ...(p ? { cp: p.cp } : {}), flow: c.flow };
    return log(acc, cp, { status: res.status, body }, c);
  }
  const tcCode = (o) => ({ decline: "05", nsf: "51", expired: "54", timeout: "91" }[o] || "05");

  // A decision made by the lab before the issuer's normal engine: record a declined payment so it shows up like any other.
  function finish(acc, cp, c) {
    c.step("Decision", `Declined by the ${c.code === "82" || c.code === "N7" ? "issuer's security checks" : "lab rules"}: ${c.why} (response ${c.code}).`, false);
    let paymentBody = null;
    if (c.type.financial) {
      const res = createPayment(acc, { request_id: c.b.request_id || "cp_" + rnd(8), method: "card", transaction_type: c.type.maps, amount: Math.max(c.amount, 0.01), currency: c.currency, card_number: c.pan, scenario: "decline" });
      const p = res.body && res.body.id && acc.payments.find((x) => x.id === res.body.id);
      if (p) {
        p.status = { code: "SBX-4260", message: CODES[c.code] || c.why };
        p.cp = { channel: c.channel, transaction_type: c.tid, entry_mode: c.entryName, pos_entry_mode: c.entry.code + "0", terminal_id: c.terminal, mcc: c.mcc, response_code: c.code, decline_reason: c.why };
        if (c.type.oct) { p.transaction_type = "refund"; p.oct = true; delete p.refunded_amount; }
        p._cpflow = c.flow; paymentBody = p;
      }
    }
    const body = { ...(paymentBody ? { ...paymentBody } : {}), transaction_type: c.tid, approved: false, response_code: c.code, response_message: CODES[c.code] || c.why, reason: c.why, ...(c.emv ? { emv: c.emv } : {}), flow: c.flow };
    delete body._cpflow; delete body._tds; delete body._store;
    return log(acc, cp, { status: 200, body }, c);
  }

  function log(acc, cp, r, c) {
    cp.log.unshift({ at: new Date().toISOString(), transaction_type: c.tid, channel: c.channel, entry_mode: c.entryName, approved: !!(r.body && r.body.approved), response_code: r.body && r.body.response_code });
    if (cp.log.length > 100) cp.log.length = 100;
    return r;
  }

  function resetPinTries(acc, pan) {
    const tc = MAG.testCard(pan); check(tc, 422, "SBX-4263", "Only Zanboxx test cards are available here");
    const cp = state(acc); cp.tries[pan] = 0; delete cp.pvv[pan];
    return { card: MAG.maskPan(pan), pin_tries: 0, pin: DEFAULT_PIN, note: "The PIN is back to the test PIN and the try counter is reset." };
  }
  return { run, catalog, resetPinTries, setSave: (fn) => { save = fn; }, state, TYPES, ENTRY, CODES, LIMITS };
};
