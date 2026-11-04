"use strict";
// EMV chip card toolkit for the card-present lab: BER-TLV, application cryptograms (ARQC/ARPC) with real 3DES
// algorithms, and decoders for TVR, TSI and the cryptogram information data.
//
// SAFETY: every key here is a published or made-up TEST key, the only cards allowed are the Zanboxx test cards, and
// nothing here talks to a card or a network. The algorithms are the ones in EMV Book 2 (simplified where noted); the
// data is teaching data. Do not use real keys or real card numbers.
const crypto = require("crypto");

// Issuer master key for application cryptograms (IMK-AC), terminal PIN key, PIN verification key. Test values only.
const TEST_KEYS = {
  imk_ac: Buffer.from("0123456789ABCDEFFEDCBA9876543210", "hex"),
  tpk: Buffer.from("1A4D672DCA6CB3351FD1B02B237AF9AE", "hex"),
  pvk: Buffer.from("2F9D4C3A8E7B1650A4C2D8E6F1B3079D", "hex"),
  cvk: Buffer.from("0123456789ABCDEFFEDCBA9876543210", "hex"),
};

// ---- DES and 3DES on single blocks (single DES is 3DES with K1=K2=K3, which node still supports) ----
function tdesBlock(key16, block, encrypt = true) {
  const k = Buffer.concat([key16, key16.subarray(0, 8)]);
  const c = (encrypt ? crypto.createCipheriv : crypto.createDecipheriv)("des-ede3-ecb", k, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(block), c.final()]);
}
const desBlock = (key8, block, encrypt = true) => tdesBlock(Buffer.concat([key8, key8]), block, encrypt);
const xor = (a, b) => Buffer.from(a.map((x, i) => x ^ b[i]));
const hex = (b) => Buffer.from(b).toString("hex").toUpperCase();
const fromHex = (h) => Buffer.from(String(h).replace(/\s/g, ""), "hex");

function oddParity(key) { return Buffer.from(key.map((b) => { let x = b & 0xfe, p = 0; for (let i = 1; i < 8; i++) p ^= (x >> i) & 1; return x | (p ? 0 : 1); })); }

// ISO 9797-1 algorithm 3 ("retail MAC"), padding method 2 (a 0x80 byte, then zeros).
function retailMac(key16, data) {
  const padded = Buffer.concat([data, Buffer.from([0x80]), Buffer.alloc((8 - ((data.length + 1) % 8)) % 8)]);
  const k1 = key16.subarray(0, 8), k2 = key16.subarray(8, 16);
  let h = Buffer.alloc(8);
  for (let i = 0; i < padded.length; i += 8) h = desBlock(k1, xor(h, padded.subarray(i, i + 8)));
  return desBlock(k1, desBlock(k2, h, false));
}

// EMV Book 2, option A: derive the card's own master key from the issuer master key, PAN and PAN sequence number.
function deriveCardMasterKey(imk, pan, psn = "00") {
  const y = (String(pan) + String(psn).padStart(2, "0")).slice(-16).padStart(16, "0"), yb = fromHex(y);
  const zl = tdesBlock(imk, yb), zr = tdesBlock(imk, xor(yb, Buffer.alloc(8, 0xff)));
  return oddParity(Buffer.concat([zl, zr]));
}
// Common session key: derived from the card master key and the transaction counter, so every transaction has its own key.
function sessionKey(mk, atcHex) {
  const atc = fromHex(atcHex.padStart(4, "0")), f1 = Buffer.concat([atc, Buffer.from([0xf0, 0, 0, 0, 0, 0])]), f2 = Buffer.concat([atc, Buffer.from([0x0f, 0, 0, 0, 0, 0])]);
  return oddParity(Buffer.concat([tdesBlock(mk, f1), tdesBlock(mk, f2)]));
}

// ---- the data the card signs (CDOL1): what the terminal tells the card about this transaction ----
const bcd = (n, bytes) => fromHex(String(Math.round(n)).padStart(bytes * 2, "0"));
const CURRENCY_NUM = { EUR: "0978", USD: "0840", GBP: "0826" };
const TXN_TYPE_CODE = { sale: "00", auth: "00", completion: "00", incremental_auth: "00", cashback: "09", cash_advance: "01", quasi_cash: "11", withdrawal: "01", refund: "20", aft: "00", balance_inquiry: "31", mini_statement: "31", pin_change: "91" };
const CDOL1 = ["9F02", "9F03", "9F1A", "95", "5F2A", "9A", "9C", "9F37", "82", "9F36", "9F10"];

// f: amount (major units), other (cashback, major units), country (numeric, e.g. "0276"), tvr (hex), currency, date (YYMMDD), type (txn type byte hex),
// un (unpredictable number hex, 4 bytes), aip (hex), atc (hex), iad (issuer application data hex, includes the CVR)
function cdol1Data(f) {
  return Buffer.concat([bcd(f.amount * 100, 6), bcd((f.other || 0) * 100, 6), fromHex(f.country), fromHex(f.tvr), fromHex(CURRENCY_NUM[f.currency]), fromHex(f.date), fromHex(f.type), fromHex(f.un), fromHex(f.aip), fromHex(f.atc.padStart(4, "0")), fromHex(f.iad)]);
}
function generateArqc(pan, psn, f, imk = TEST_KEYS.imk_ac) {
  const sk = sessionKey(deriveCardMasterKey(imk, pan, psn), f.atc);
  return retailMac(sk, cdol1Data(f));
}
// ARPC method 1: the issuer proves it is the real issuer by encrypting the ARQC xor the 2-byte response code.
function generateArpc(pan, psn, atc, arqcHex, arcAscii, imk = TEST_KEYS.imk_ac) {
  const sk = sessionKey(deriveCardMasterKey(imk, pan, psn), atc), arc = Buffer.concat([Buffer.from(arcAscii, "ascii"), Buffer.alloc(6)]);
  return tdesBlock(sk, xor(fromHex(arqcHex), arc));
}
// What the issuer does when an ARQC arrives: recompute it from the same data and compare.
function verifyArqc(pan, psn, f, arqcHex, imk = TEST_KEYS.imk_ac) {
  const want = hex(generateArqc(pan, psn, f, imk));
  return { valid: want === String(arqcHex).toUpperCase(), expected: want };
}

// ---- BER-TLV ----
const TAGS = {
  "6F": "File control information (FCI) template", "A5": "FCI proprietary template", "BF0C": "FCI issuer discretionary data", "61": "Directory entry", "70": "Record template", "77": "Response message template (format 2)", "83": "Command template", "87": "Application priority indicator", "94": "Application file locator (AFL)", "9F38": "Processing options data object list (PDOL)", "5F2D": "Language preference", "8A": "Authorisation response code (ARC)",
  "4F": "Application ID (AID)", "50": "Application label", "57": "Track 2 equivalent data", "5A": "Application PAN", "5F20": "Cardholder name", "5F24": "Application expiry date", "5F2A": "Transaction currency code", "5F34": "PAN sequence number",
  "82": "Application interchange profile (AIP)", "84": "Dedicated file name", "8E": "Cardholder verification method (CVM) list", "95": "Terminal verification results (TVR)", "9A": "Transaction date", "9B": "Transaction status information (TSI)", "9C": "Transaction type",
  "9F02": "Amount, authorised", "9F03": "Amount, other (cashback)", "9F10": "Issuer application data", "9F1A": "Terminal country code", "9F26": "Application cryptogram", "9F27": "Cryptogram information data", "9F33": "Terminal capabilities", "9F34": "CVM results", "9F36": "Application transaction counter (ATC)", "9F37": "Unpredictable number",
};
function tlvEncode(tag, valueHex) {
  const v = fromHex(valueHex), t = fromHex(tag), l = v.length < 128 ? Buffer.from([v.length]) : v.length < 256 ? Buffer.from([0x81, v.length]) : Buffer.from([0x82, v.length >> 8, v.length & 255]);
  return Buffer.concat([t, l, v]);
}
function tlvDecode(buf) {
  const out = []; let i = 0;
  while (i < buf.length) {
    if (buf[i] === 0 || buf[i] === 0xff) { i++; continue; }
    let tag = buf[i++].toString(16).toUpperCase().padStart(2, "0");
    if ((buf[i - 1] & 0x1f) === 0x1f) { do { tag += buf[i].toString(16).toUpperCase().padStart(2, "0"); } while (buf[i++] & 0x80); }
    if (i >= buf.length) throw new Error("TLV ends in a tag");
    let len = buf[i++]; if (len & 0x80) { const n = len & 0x7f; if (n < 1 || n > 2 || i + n > buf.length) throw new Error("Bad TLV length"); len = 0; for (let k = 0; k < n; k++) len = (len << 8) | buf[i++]; }
    if (i + len > buf.length) throw new Error(`TLV value for ${tag} is longer than the data`);
    const constructed = !!(parseInt(tag.slice(0, 2), 16) & 0x20), v = buf.subarray(i, i + len); i += len;
    out.push(constructed ? { tag, name: TAGS[tag] || "constructed", children: tlvDecode(v) } : { tag, name: TAGS[tag] || "unknown tag", value: hex(v) });
  }
  return out;
}

// ---- decoders ----
const bits = (byte, names) => names.map((n, i) => (n && (byte >> (7 - i)) & 1 ? n : null)).filter(Boolean);
const TVR_BITS = [
  ["Offline data authentication was not performed", "SDA failed", "ICC data missing", "Card appears on terminal exception file", "DDA failed", "CDA failed", null, null],
  ["Chip and terminal application versions differ", "Application expired", "Application not yet effective", "Requested service not allowed for this card", "New card", null, null, null],
  ["Cardholder verification was not successful", "Unrecognised CVM", "PIN try limit exceeded", "PIN pad not present or not working", "PIN required, PIN pad present, but PIN not entered", "Online PIN entered", null, null],
  ["Transaction exceeds floor limit", "Lower consecutive offline limit exceeded", "Upper consecutive offline limit exceeded", "Transaction selected randomly for online processing", "Merchant forced transaction online", null, null, null],
  ["Default TDOL used", "Issuer authentication failed", "Script processing failed before final GENERATE AC", "Script processing failed after final GENERATE AC", null, null, null, null],
];
const decodeTvr = (h) => { const b = fromHex(h); return TVR_BITS.flatMap((names, i) => bits(b[i] || 0, names)); };
const encodeTvr = (flags) => { const b = Buffer.alloc(5); for (const f of flags) TVR_BITS.forEach((names, i) => { const k = names.indexOf(f); if (k >= 0) b[i] |= 0x80 >> k; }); return hex(b); };
const TSI_BITS = ["Offline data authentication was performed", "Cardholder verification was performed", "Card risk management was performed", "Issuer authentication was performed", "Terminal risk management was performed", "Script processing was performed", null, null];
const decodeTsi = (h) => bits(fromHex(h)[0] || 0, TSI_BITS);
const CID = { 0x00: { type: "AAC", meaning: "Application authentication cryptogram: the card declined the transaction" }, 0x40: { type: "TC", meaning: "Transaction certificate: the card approved the transaction offline" }, 0x80: { type: "ARQC", meaning: "Authorisation request cryptogram: the card wants the issuer to decide online" } };
const decodeCid = (h) => CID[fromHex(h)[0] & 0xc0] || { type: "unknown", meaning: "Unknown cryptogram type" };

module.exports = { TEST_KEYS, CDOL1, CURRENCY_NUM, TXN_TYPE_CODE, TAGS, desBlock, tdesBlock, retailMac, deriveCardMasterKey, sessionKey, cdol1Data, generateArqc, generateArpc, verifyArqc, tlvEncode, tlvDecode, decodeTvr, encodeTvr, decodeTsi, decodeCid, hex, fromHex, xor, oddParity };
