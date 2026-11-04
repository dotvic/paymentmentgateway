"use strict";
// Magnetic stripe, service codes, CVV1 and PIN handling for the card-present lab.
// Test cards only: building or checking track data for any other card number is refused. Test keys come from emv.js.
const EMV = require("./emv");
const SCH = require("./schemes");

const TEST = new Map(SCH.TEST_CARDS.map((c) => [c.number, c]));
const testCard = (pan) => TEST.get(String(pan || "").replace(/\s/g, "")) || null;

// ---- service code: three digits on the stripe that tell the terminal how to treat the card ----
const SC1 = { 1: "International interchange", 2: "International interchange, chip card (use the chip)", 5: "National interchange only", 6: "National interchange only, chip card (use the chip)", 7: "Private", 9: "Test" };
const SC2 = { 0: "Normal authorisation", 2: "Online authorisation required", 4: "Online authorisation required (except by agreement)" };
const SC3 = { 0: "No restrictions, PIN required", 1: "No restrictions", 2: "Goods and services only (no cash)", 3: "ATM only, PIN required", 4: "Cash only", 5: "Goods and services only, PIN required", 6: "No restrictions, use PIN where possible", 7: "Goods and services only, use PIN where possible" };
function describeServiceCode(sc) {
  if (!/^\d{3}$/.test(sc)) return null;
  return { code: sc, interchange: SC1[sc[0]] || "Unknown", authorisation: SC2[sc[1]] || "Unknown", services: SC3[sc[2]] || "Unknown", chip: sc[0] === "2" || sc[0] === "6", pin_required: ["0", "3", "5"].includes(sc[2]), cash_allowed: !["2", "5", "7"].includes(sc[2]), atm_only: sc[2] === "3" };
}

// ---- decimalisation shared by CVV and PVV ----
function decimalise(h, n) {
  const d = h.replace(/[A-F]/g, (c) => String(c.charCodeAt(0) - 65));
  const digits = [...h].filter((c) => c <= "9").concat([...h].filter((c) => c > "9").map((c) => String(c.charCodeAt(0) - 65)));
  return digits.slice(0, n).join("");
}
// CVV1 / CVC1 (the Visa-style algorithm): PAN, expiry YYMM and service code, encrypted with the card verification key pair.
function cvv(pan, expiryYYMM, serviceCode, cvk = EMV.TEST_KEYS.cvk) {
  const data = (pan + expiryYYMM + serviceCode).padEnd(32, "0"), a = EMV.fromHex(data.slice(0, 16)), b = EMV.fromHex(data.slice(16, 32));
  const x = EMV.desBlock(cvk.subarray(0, 8), a), y = EMV.xor(x, b), z = EMV.tdesBlock(cvk, y);
  return decimalise(EMV.hex(z), 3);
}
// PIN verification value: a short check value of the PIN, so the issuer never needs to store the PIN itself.
function pvv(pan, pin, pvki = "1", pvk = EMV.TEST_KEYS.pvk) {
  const tsp = pan.slice(0, -1).slice(-11) + pvki + pin.slice(0, 4);
  return decimalise(EMV.hex(EMV.tdesBlock(pvk, EMV.fromHex(tsp))), 4);
}

// ---- tracks ----
function names(pan) { const c = testCard(pan); return c ? c.scheme.toUpperCase() + "/TESTCARD" : "TEST/CARD"; }
function expiryFor(pan) { const c = testCard(pan); return c && c.outcome === "expired" ? "2201" : "3012"; }
function buildTracks(pan, { expiry, serviceCode = "201", pin = "1234" } = {}) {
  if (!testCard(pan)) throw new Error("Track data can only be built for Zanboxx test cards");
  expiry = expiry || expiryFor(pan);
  const disc = "1" + pvv(pan, pin) + cvv(pan, expiry, serviceCode);
  return { track1: `%B${pan}^${names(pan)}^${expiry}${serviceCode}${disc}?`, track2: `;${pan}=${expiry}${serviceCode}${disc}?`, expiry, service_code: serviceCode, cvv1: disc.slice(5, 8), pvv: disc.slice(1, 5) };
}
function parseTrack2(t) {
  const m = /^;?(\d{12,19})=(\d{2})(\d{2})(\d{3})(\d*)\??$/.exec(String(t || "").trim());
  if (!m) return null;
  return { pan: m[1], expiry: m[2] + m[3], service_code: m[4], discretionary: m[5], pvki: m[5].slice(0, 1), pvv: m[5].slice(1, 5), cvv: m[5].slice(5, 8) };
}
function parseTrack1(t) {
  const m = /^%?B(\d{12,19})\^([^^]{2,26})\^(\d{2})(\d{2})(\d{3})(\d*)\??$/.exec(String(t || "").trim());
  return m ? { pan: m[1], name: m[2], expiry: m[3] + m[4], service_code: m[5], discretionary: m[6], pvv: m[6].slice(1, 5), cvv: m[6].slice(5, 8) } : null;
}
const maskPan = (p) => p.slice(0, 6) + "*".repeat(Math.max(0, p.length - 10)) + p.slice(-4);
const lrc = (s) => { let x = 0; for (const c of Buffer.from(s, "ascii")) x ^= c; return x.toString(16).toUpperCase().padStart(2, "0"); };

// ---- PIN block, ISO format 0, encrypted under the terminal PIN key ----
const panField = (pan) => "0000" + pan.slice(0, -1).slice(-12);
function buildPinBlock(pin, pan, tpk = EMV.TEST_KEYS.tpk) {
  if (!/^\d{4,12}$/.test(pin)) throw new Error("A PIN has 4 to 12 digits");
  const clear = EMV.xor(EMV.fromHex(("0" + pin.length.toString(16) + pin).padEnd(16, "F")), EMV.fromHex(panField(pan)));
  return { clear_block: EMV.hex(clear), encrypted: EMV.hex(EMV.tdesBlock(tpk, clear)) };
}
function parsePinBlock(encryptedHex, pan, tpk = EMV.TEST_KEYS.tpk) {
  if (!/^[0-9a-fA-F]{16}$/.test(encryptedHex)) return null;
  const f = EMV.hex(EMV.xor(EMV.tdesBlock(tpk, EMV.fromHex(encryptedHex), false), EMV.fromHex(panField(pan))));
  const len = parseInt(f[1], 16);
  if (f[0] !== "0" || len < 4 || len > 12 || !/^\d+$/.test(f.slice(2, 2 + len)) || !/^F*$/.test(f.slice(2 + len))) return null;
  return f.slice(2, 2 + len);
}

module.exports = { testCard, describeServiceCode, cvv, pvv, buildTracks, parseTrack1, parseTrack2, maskPan, lrc, buildPinBlock, parsePinBlock, expiryFor };
