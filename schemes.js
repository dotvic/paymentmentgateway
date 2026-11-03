"use strict";
// Card scheme profiles: Visa, Mastercard and American Express.
//
// Zanboxx never talks to the real card networks. This module only models how the schemes differ so that
// developers can test against those differences: card number format, security code, 3-D Secure branding and ECI,
// decline codes and chargeback reasons. All codes are simplified teaching values, not a certified implementation.

const SCHEMES = {
  visa: {
    id: "visa", name: "Visa",
    lengths: [13, 16, 19],
    cvv: { name: "CVV2", length: 3, where: "back of the card" },
    tds: { brand: "Visa Secure", authValueName: "CAVV" },
    eci: { Y: "05", A: "06", N: "07", U: "07", R: "07" },
    responses: {
      decline: { code: "05", message: "Do not honor", retry: "Do not retry the same card repeatedly. Ask for another payment method." },
      nsf: { code: "51", message: "Insufficient funds", retry: "The customer can top up; a later retry may succeed." },
      expired: { code: "54", message: "Expired card", retry: "Ask the customer for a new card or new expiry date." },
      invalid_card: { code: "14", message: "Invalid card number", retry: "Ask the customer to re-enter the card number." },
    },
    chargebacks: [
      { code: "10.4", category: "fraud", reason: "Fraud: card-absent environment" },
      { code: "13.1", category: "not_received", reason: "Merchandise or services not received" },
      { code: "13.3", category: "not_as_described", reason: "Not as described or defective" },
      { code: "12.6.1", category: "duplicate", reason: "Duplicate processing" },
    ],
    note: "Visa checks that card numbers start with 4. Responses use ISO 8583 field 39 codes.",
  },
  mastercard: {
    id: "mastercard", name: "Mastercard",
    lengths: [16],
    cvv: { name: "CVC2", length: 3, where: "back of the card" },
    tds: { brand: "Mastercard Identity Check", authValueName: "AAV (UCAF)" },
    eci: { Y: "02", A: "01", N: "00", U: "00", R: "00" },
    responses: {
      decline: { code: "05", message: "Do not honor", retry: "Treat as a hard decline. Mastercard can attach a merchant advice code telling you not to retry." },
      nsf: { code: "51", message: "Insufficient funds", retry: "The customer can top up; a later retry may succeed." },
      expired: { code: "54", message: "Expired card", retry: "Ask the customer for a new card or new expiry date." },
      invalid_card: { code: "14", message: "Invalid card number", retry: "Ask the customer to re-enter the card number." },
    },
    chargebacks: [
      { code: "4837", category: "fraud", reason: "No cardholder authorization" },
      { code: "4855", category: "not_received", reason: "Goods or services not provided" },
      { code: "4853", category: "not_as_described", reason: "Cardholder dispute: not as described or defective" },
      { code: "4834", category: "duplicate", reason: "Duplicate processing" },
    ],
    note: "Mastercard numbers start with 51 to 55 or 2221 to 2720. The 3DS ECI values are 02, 01 and 00, not 05, 06 and 07.",
  },
  amex: {
    id: "amex", name: "American Express",
    lengths: [15],
    cvv: { name: "CID", length: 4, where: "front of the card" },
    tds: { brand: "American Express SafeKey", authValueName: "AEVV" },
    eci: { Y: "05", A: "06", N: "07", U: "07", R: "07" },
    responses: {
      decline: { code: "100", message: "Deny", retry: "Do not retry the same card repeatedly. Ask for another payment method." },
      nsf: { code: "116", message: "Not sufficient funds", retry: "The customer can top up; a later retry may succeed." },
      expired: { code: "101", message: "Expired card", retry: "Ask the customer for a new card or new expiry date." },
      invalid_card: { code: "111", message: "Invalid account", retry: "Ask the customer to re-enter the card number." },
    },
    chargebacks: [
      { code: "F29", category: "fraud", reason: "Card not present fraud" },
      { code: "C08", category: "not_received", reason: "Goods or services not received" },
      { code: "C31", category: "not_as_described", reason: "Goods or services not as described" },
      { code: "P08", category: "duplicate", reason: "Duplicate charge" },
    ],
    note: "Amex numbers have 15 digits and start with 34 or 37. The security code (CID) has 4 digits and sits on the front. Responses use Amex action codes, not ISO 8583 codes.",
  },
};

// Which scheme a card number belongs to, from its first digits. Returns null if it is none of the three.
function detect(pan) {
  const n = String(pan || "").replace(/[\s-]/g, "");
  if (!/^\d+$/.test(n)) return null;
  if (/^4/.test(n)) return "visa";
  if (/^(5[1-5]|2(2[2-9][1-9]|2[3-9]|[3-6]\d|7[01]|720))/.test(n)) return "mastercard";
  if (/^3[47]/.test(n)) return "amex";
  return null;
}

// Luhn check: the checksum every real card number satisfies.
function luhn(pan) {
  const n = String(pan || "").replace(/[\s-]/g, "");
  if (!/^\d{12,19}$/.test(n)) return false;
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

// Checks the format of a card number (and optionally the security code) against the scheme's rules.
// Returns { scheme, error } where error is a message or null. Unknown schemes only need 13 to 19 digits.
function check(pan, cvv) {
  const n = String(pan || "").replace(/\s/g, "");
  if (!/^\d{13,19}$/.test(n)) return { scheme: null, error: "card_number must be 13 to 19 digits" };
  const id = detect(n), s = id && SCHEMES[id];
  if (s && !s.lengths.includes(n.length)) return { scheme: id, error: `${s.name} card numbers have ${s.lengths.join(" or ")} digits; this one has ${n.length}` };
  if (cvv !== undefined && cvv !== null && cvv !== "") {
    const want = s ? s.cvv.length : null, c = String(cvv);
    if (!/^\d{3,4}$/.test(c)) return { scheme: id, error: "card_cvv must be 3 or 4 digits" };
    if (want && c.length !== want) return { scheme: id, error: `${s.name} uses a ${want}-digit ${s.cvv.name} (${s.cvv.where})` };
  }
  return { scheme: id, error: null };
}

const eciFor = (scheme, status) => (SCHEMES[scheme] || SCHEMES.visa).eci[status];
const tdsFor = (scheme) => (SCHEMES[scheme] || SCHEMES.visa).tds;
// The scheme's own response for one of our outcomes (decline, nsf, expired, invalid_card), or null.
const responseFor = (scheme, outcome) => (SCHEMES[scheme] && SCHEMES[scheme].responses[outcome]) || null;

// Test cards. The number decides the outcome. 3ds outcomes match the existing Visa 3DS test cards.
const OUTCOME_LABELS = {
  approve: "Approved", decline: "Declined", nsf: "Insufficient funds", expired: "Expired card", timeout: "Gateway timeout",
  "3ds_Y": "3DS frictionless", "3ds": "3DS challenge", "3ds_N": "3DS denied", "3ds_A": "3DS attempted", "3ds_U": "3DS unavailable", "3ds_R": "3DS rejected",
};
const TEST_CARDS = [
  ["visa", "4111111111111111", "approve"], ["visa", "4000000000000002", "decline"], ["visa", "4000000000009995", "nsf"],
  ["visa", "4000000000000069", "expired"], ["visa", "4000000000000408", "timeout"],
  ["visa", "4000000000003000", "3ds_Y"], ["visa", "4000000000003220", "3ds"], ["visa", "4000000000003238", "3ds_N"],
  ["visa", "4000000000003253", "3ds_A"], ["visa", "4000000000003261", "3ds_U"], ["visa", "4000000000003279", "3ds_R"],
  ["mastercard", "5555555555554444", "approve"], ["mastercard", "5200000000000007", "decline"], ["mastercard", "5200000000099959", "nsf"],
  ["mastercard", "5200000000000692", "expired"], ["mastercard", "5200000000004082", "timeout"],
  ["mastercard", "5200000000030004", "3ds_Y"], ["mastercard", "5200000000032208", "3ds"], ["mastercard", "5200000000032380", "3ds_N"],
  ["mastercard", "5200000000032539", "3ds_A"], ["mastercard", "5200000000032612", "3ds_U"], ["mastercard", "5200000000032794", "3ds_R"],
  ["amex", "378282246310005", "approve"], ["amex", "370000000000002", "decline"], ["amex", "370000000099954", "nsf"],
  ["amex", "370000000000697", "expired"], ["amex", "370000000004087", "timeout"],
  ["amex", "370000000030009", "3ds_Y"], ["amex", "370000000032203", "3ds"], ["amex", "370000000032385", "3ds_N"],
  ["amex", "370000000032534", "3ds_A"], ["amex", "370000000032617", "3ds_U"], ["amex", "370000000032799", "3ds_R"],
].map(([scheme, number, outcome]) => ({ scheme, number, outcome, label: OUTCOME_LABELS[outcome] }));

// What GET /v1/schemes returns.
function publicProfiles() {
  return Object.values(SCHEMES).map((s) => ({
    id: s.id, name: s.name, number_lengths: s.lengths, security_code: s.cvv, three_ds: { brand: s.tds.brand, authentication_value: s.tds.authValueName, eci: s.eci },
    responses: s.responses, chargeback_reasons: s.chargebacks, note: s.note,
    test_cards: TEST_CARDS.filter((c) => c.scheme === s.id).map(({ number, outcome, label }) => ({ number, outcome, label })),
  }));
}

module.exports = { SCHEMES, TEST_CARDS, detect, luhn, check, eciFor, tdsFor, responseFor, publicProfiles };
