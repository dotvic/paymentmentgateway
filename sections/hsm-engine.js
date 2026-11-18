"use strict";
// Payment cryptography engine for the Cryptography lab. Triple DES card and PIN values (card verification value, PIN verification value,
// PIN blocks, EMV key derivation and cryptograms) plus a simplified offline data authentication demo.
// Teaching only: every key here is a public, invented teaching key. A real hardware security module never reveals a clear key or PIN.
// Message layouts follow the published public algorithms in simplified form and are NOT interoperable with any product.
const crypto = require("crypto");

const hex = (b) => Buffer.from(b).toString("hex").toUpperCase();
const H = (s) => Buffer.from(s, "hex");
const xor = (a, b) => { const x = Buffer.alloc(a.length); for (let i = 0; i < a.length; i++) x[i] = a[i] ^ b[i]; return x; };

// ---- teaching keys (public on purpose) ----
const KEYS = {
  "CVK-A": "1A2B3C4D5E6F70819283A4B5C6D7E8F9", "CVK-B": "A1B2C3D4E5F60718293A4B5C6D7E8F90",
  "PVK-A": "2B3C4D5E6F708192A3B4C5D6E7F8091A", "PVK-B": "B2C3D4E5F60718293A4B5C6D7E8F90A1",
  "ZPK-A": "3C4D5E6F708192A3B4C5D6E7F8091A2B", "ZPK-B": "C3D4E5F60718293A4B5C6D7E8F90A1B2",
  "IMK-AC": "4D5E6F708192A3B4C5D6E7F8091A2B3C", "LMK": "5E6F708192A3B4C5D6E7F8091A2B3C4D",
};
const KEY_KINDS = { cvk: ["CVK-A", "CVK-B"], pvk: ["PVK-A", "PVK-B"], zpk: ["ZPK-A", "ZPK-B"] };
const key = (name, kind) => {
  if (!KEYS[name] || (kind && !KEY_KINDS[kind].includes(name))) { const e = new Error(`Unknown ${kind || "key"} '${name}'. Choose one of: ${(kind ? KEY_KINDS[kind] : Object.keys(KEYS)).join(", ")}`); e.code = "bad_input"; throw e; }
  return H(KEYS[name]);
};

// ---- DES primitives (single block ECB; single DES is two-key triple DES with equal halves) ----
function ecb(k16, block, decrypt) {
  const c = (decrypt ? crypto.createDecipheriv : crypto.createCipheriv)("des-ede", k16, null); c.setAutoPadding(false);
  return Buffer.concat([c.update(block), c.final()]);
}
const des = (k8, block, decrypt) => ecb(Buffer.concat([k8, k8]), block, decrypt);
const tdes = (k16, data, decrypt) => { const out = []; for (let i = 0; i < data.length; i += 8) out.push(ecb(k16, data.subarray(i, i + 8), decrypt)); return Buffer.concat(out); };
const parity = (b) => { const o = Buffer.from(b); for (let i = 0; i < o.length; i++) { let v = o[i] & 0xfe, n = 0; for (let k = 1; k < 8; k++) n += (v >> k) & 1; o[i] = v | (n % 2 === 0 ? 1 : 0); } return o; };
const luhnDigit = (digits) => { let s = 0, d = true; for (let i = digits.length - 1; i >= 0; i--) { let n = +digits[i]; if (d) { n *= 2; if (n > 9) n -= 9; } s += n; d = !d; } return (10 - (s % 10)) % 10; };

// Decimalisation shared by card values and PIN verification values: take digits 0-9 in order; if too few, take A-F as 0-5.
function decimalise(hexStr, n) {
  let out = ""; for (const c of hexStr) if (/[0-9]/.test(c)) { out += c; if (out.length === n) return out; }
  for (const c of hexStr) if (/[A-F]/.test(c)) { out += String(c.charCodeAt(0) - 65); if (out.length === n) return out; }
  return out;
}

function need(cond, msg) { if (!cond) { const e = new Error(msg); e.code = "bad_input"; throw e; } }
const digits = (v, n, name) => { const s = String(v == null ? "" : v).replace(/\s/g, ""); need(/^\d+$/.test(s) && (n == null || s.length === n), `${name} must be ${n} digits`); return s; };

// ---- card verification value ----
const CVV_KIND = { cvv1: { label: "CVV1 (magnetic stripe), service code from the card", svc: null }, cvv2: { label: "CVV2 (printed on the card), service code 000", svc: "000" }, icvv: { label: "iCVV (chip copy of the stripe), service code 999", svc: "999" } };
function cvv({ pan, expiry, service_code, kind, key: kn }) {
  pan = digits(pan, null, "pan"); need(pan.length >= 13 && pan.length <= 19, "pan must be 13 to 19 digits");
  expiry = digits(expiry, 4, "expiry (YYMM)"); kind = kind || "cvv1"; need(CVV_KIND[kind], "kind must be cvv1, cvv2 or icvv");
  const svc = CVV_KIND[kind].svc || digits(service_code, 3, "service_code");
  const K = key(kn || "CVK-A", "cvk"), KA = K.subarray(0, 8), KB = K.subarray(8, 16), steps = [];
  let data = pan + expiry + svc; steps.push(["Join card number, expiry (YYMM) and service code", data]);
  need(data.length <= 32, "card data too long"); data = data.padEnd(32, "0"); steps.push(["Pad with zeros to 32 hex digits", data]);
  const b1 = H(data.slice(0, 16)), b2 = H(data.slice(16)); steps.push(["Split into block 1 and block 2", hex(b1) + " | " + hex(b2)]);
  const e1 = des(KA, b1); steps.push(["Encrypt block 1 with key half A (single DES)", hex(e1)]);
  const x = xor(e1, b2); steps.push(["XOR the result with block 2", hex(x)]);
  const out = tdes(K, x); steps.push(["Encrypt with both key halves (triple DES)", hex(out)]);
  const v = decimalise(hex(out), 3); steps.push(["Decimalise: take the first three digits 0 to 9, left to right", v]);
  return { value: v, kind, service_code: svc, steps };
}

// ---- PIN verification value ----
const panBody = (pan) => pan.slice(0, -1);
function pvv({ pan, pin, pvki, key: kn }) {
  pan = digits(pan, null, "pan"); pin = digits(pin, null, "pin"); need(pin.length >= 4 && pin.length <= 12, "pin must be 4 to 12 digits");
  pvki = String(pvki == null ? "1" : pvki); need(/^[0-6]$/.test(pvki), "pvki must be 0 to 6");
  const K = key(kn || "PVK-A", "pvk"), steps = [];
  const tsp = panBody(pan).slice(-11) + pvki + pin.slice(0, 4); steps.push(["Build the 16-digit input: last 11 digits of the card number (without its check digit), key index, first 4 PIN digits", tsp]);
  const out = tdes(K, H(tsp)); steps.push(["Encrypt it with the PIN verification key (triple DES)", hex(out)]);
  const v = decimalise(hex(out), 4); steps.push(["Decimalise: first four digits 0 to 9, then letters A to F as 0 to 5 if needed", v]);
  return { value: v, pvki, steps };
}

// ---- PIN blocks ----
function pinField(pin, format, fill) {
  const L = pin.length.toString(16).toUpperCase();
  if (format === "0") return Buffer.from("0" + L + pin + "F".repeat(14 - pin.length), "hex");
  const f = fill && /^[A-F]+$/i.test(fill) ? fill.toUpperCase().padEnd(14 - pin.length, "A").slice(0, 14 - pin.length) : Array.from({ length: 14 - pin.length }, () => "ABCDEF"[crypto.randomInt(6)]).join("");
  return Buffer.from("3" + L + pin + f, "hex");
}
const panField = (pan) => Buffer.from("0000" + panBody(pan).slice(-12), "hex");
function buildPinBlock({ pan, pin, format, key: kn, fill }) {
  pan = digits(pan, null, "pan"); pin = digits(pin, null, "pin"); need(pin.length >= 4 && pin.length <= 12, "pin must be 4 to 12 digits");
  format = String(format == null ? "0" : format); need(["0", "3"].includes(format), "format must be 0 or 3");
  const K = key(kn || "ZPK-A", "zpk"), steps = [], pf = pinField(pin, format, fill), af = panField(pan), clear = xor(pf, af);
  steps.push(["PIN field: format, length, PIN, filler", hex(pf)]); steps.push(["Card number field: 0000 then the last 12 digits without the check digit", hex(af)]);
  steps.push(["XOR the two fields: the clear PIN block", hex(clear)]); const enc = tdes(K, clear); steps.push([`Encrypt under ${kn || "ZPK-A"} (triple DES): this is what travels`, hex(enc)]);
  return { pin_block: hex(enc), format, steps };
}
function openPinBlock({ pan, pin_block, key: kn }) {
  pan = digits(pan, null, "pan"); need(/^[0-9a-fA-F]{16}$/.test(String(pin_block || "")), "pin_block must be 16 hex digits");
  const K = key(kn || "ZPK-A", "zpk"), steps = [], clear = tdes(K, H(pin_block), true); steps.push([`Decrypt under ${kn || "ZPK-A"}`, hex(clear)]);
  const pf = xor(clear, panField(pan)), p = hex(pf); steps.push(["XOR with the card number field to get the PIN field", p]);
  const fmt = p[0], len = parseInt(p[1], 16), body = p.slice(2, 2 + len), fill = p.slice(2 + len);
  const ok = (fmt === "0" || fmt === "3") && len >= 4 && len <= 12 && /^\d+$/.test(body) && (fmt === "0" ? /^F*$/.test(fill) : /^[A-F]*$/.test(fill));
  return { ok, format: ok ? fmt : null, pin: ok ? body : null, steps };
}

// ---- random PIN (the lab reveals it once; a real module does not) ----
function randomPin({ pan, length }) {
  pan = digits(pan, null, "pan"); const n = length == null ? 4 : +length; need(Number.isInteger(n) && n >= 4 && n <= 6, "length must be 4 to 6");
  let pin; do { pin = Array.from({ length: n }, () => crypto.randomInt(10)).join(""); } while (/^(\d)\1+$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin));
  const enc = tdes(H(KEYS.LMK), Buffer.from(pin.padEnd(16, "F"), "hex"));
  return { pin, pin_under_master_key: hex(enc), steps: [["Draw random digits, rejecting all-the-same and straight runs", pin], ["Encrypt under the master key so it can be stored", hex(enc)]] };
}


// ---- PIN offset method: a PIN derived from the card number, plus a stored per-digit difference (offset) ----
const DEC_DEFAULT = "0123456789012345";
function decTable(t) { t = String(t == null || t === "" ? DEC_DEFAULT : t); need(/^\d{16}$/.test(t), "decimalisation table must be 16 digits (one for each hex digit 0 to F)"); return t; }
function naturalPin({ pan, key: kn, dectab, length }) {
  pan = digits(pan, null, "pan"); const n = length == null ? 4 : +length; need(Number.isInteger(n) && n >= 4 && n <= 12, "length must be 4 to 12"); const t = decTable(dectab), K = key(kn || "PVK-A", "pvk"), steps = [];
  const vd = pan.slice(-16).padStart(16, "0"); steps.push(["Validation data: the last 16 digits of the card number (zero-padded on the left)", vd]);
  const out = hex(tdes(K, H(vd))); steps.push(["Encrypt it with the PIN verification key (triple DES)", out]);
  const dec = Array.from(out, (c) => t[parseInt(c, 16)]).join(""); steps.push(["Map each hex digit through the decimalisation table " + t, dec]);
  const nat = dec.slice(0, n); steps.push([`Take the first ${n} digits: the natural PIN`, nat]); return { natural: nat, steps, dectab: t };
}
const dsub = (a, b) => Array.from(a, (c, i) => (10 + +c - +b[i]) % 10).join(""), dadd = (a, b) => Array.from(a, (c, i) => (+c + +b[i]) % 10).join("");
function pinOffset({ pan, pin, key: kn, dectab }) {
  pin = digits(pin, null, "pin"); need(pin.length >= 4 && pin.length <= 12, "pin must be 4 to 12 digits");
  const n = naturalPin({ pan, key: kn, dectab, length: pin.length }), off = dsub(pin, n.natural);
  return { offset: off, natural: n.natural, steps: n.steps.concat([["Offset = chosen PIN minus natural PIN, digit by digit, ignoring borrows", off]]) };
}
function offsetCheck({ pan, pin, offset, key: kn, dectab }) {
  offset = digits(offset, null, "offset"); const n = naturalPin({ pan, key: kn, dectab, length: offset.length }), expect = dadd(n.natural, offset);
  return { ok: expect === pin, expected: expect, steps: n.steps.concat([["Natural PIN plus the stored offset, digit by digit: the PIN that should have been entered", "(hidden from the caller)"]]) };
}

// ---- EMV: key derivation, cryptograms ----
function deriveMaster({ pan, psn }) {
  pan = digits(pan, null, "pan"); psn = digits(psn == null ? "00" : psn, 2, "psn"); const steps = [];
  const y = (pan + psn).slice(-16).padStart(16, "0"); steps.push(["Y = last 16 digits of card number + sequence number (zero-padded on the left)", y]);
  const IMK = H(KEYS["IMK-AC"]), yb = H(y), zl = tdes(IMK, yb), zr = tdes(IMK, xor(yb, Buffer.alloc(8, 0xff)));
  steps.push(["Left half = triple DES of Y under the issuer master key", hex(zl)]); steps.push(["Right half = triple DES of (Y inverted)", hex(zr)]);
  const mk = parity(Buffer.concat([zl, zr])); steps.push(["Set odd parity on every byte: the card's master key", hex(mk)]);
  return { mk, steps };
}
function sessionKey(mk, atc) {
  const a = H(atc), l = tdes(mk, Buffer.concat([a, H("F0"), Buffer.alloc(5)])), r = tdes(mk, Buffer.concat([a, H("0F"), Buffer.alloc(5)]));
  return parity(Buffer.concat([l, r]));
}
const hexField = (v, bytes, name) => { const s = String(v == null ? "" : v).replace(/\s/g, ""); need(new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(s), `${name} must be ${bytes} bytes (${bytes * 2} hex digits)`); return s.toUpperCase(); };
const DEFAULT_TXN = { amount: "000000012000", other_amount: "000000000000", country: "0826", tvr: "0000000000", currency: "0826", date: "260131", type: "00", unpredictable: "9A8B7C6D", aip: "3900", cvr: "03A00000" };
function txnData(b) {
  const t = { ...DEFAULT_TXN, ...Object.fromEntries(Object.entries(b || {}).filter(([k, v]) => k in DEFAULT_TXN && v !== undefined && v !== "")) };
  return { amount: hexField(t.amount, 6, "amount"), other_amount: hexField(t.other_amount, 6, "other_amount"), country: hexField(t.country, 2, "country"), tvr: hexField(t.tvr, 5, "tvr"), currency: hexField(t.currency, 2, "currency"), date: hexField(t.date, 3, "date"), type: hexField(t.type, 1, "type"), unpredictable: hexField(t.unpredictable, 4, "unpredictable"), aip: hexField(t.aip, 2, "aip"), cvr: hexField(t.cvr, 4, "cvr") };
}
function retailMac(k16, data) {
  const KL = k16.subarray(0, 8), KR = k16.subarray(8, 16); let d = Buffer.concat([data, H("80")]); while (d.length % 8) d = Buffer.concat([d, Buffer.alloc(1)]);
  let c = Buffer.alloc(8); for (let i = 0; i < d.length; i += 8) c = des(KL, xor(c, d.subarray(i, i + 8)));
  return des(KL, des(KR, c, true));
}
function arqc(b) {
  const { mk, steps } = deriveMaster(b), atc = hexField(b.atc == null ? "0001" : b.atc, 2, "atc"), t = txnData(b.txn);
  const sk = sessionKey(mk, atc); steps.push([`Session key for transaction counter ${atc}`, hex(sk)]);
  const data = H(t.amount + t.other_amount + t.country + t.tvr + t.currency + t.date + t.type + t.unpredictable + t.aip + atc + t.cvr);
  steps.push(["Join the transaction data and card data (amount, other amount, country, TVR, currency, date, type, unpredictable number, AIP, counter, CVR)", hex(data)]);
  const m = retailMac(sk, data); steps.push(["Pad (80 then zeros) and compute the 8-byte MAC: the cryptogram", hex(m)]);
  return { arqc: hex(m), atc, txn: t, sk, steps };
}
function arpc({ arqc: q, arc }, sk) {
  const a = hexField(q, 8, "arqc"), c = String(arc == null ? "3030" : arc).toUpperCase(); need(/^[0-9A-F]{4}$/.test(c), "arc must be 2 bytes (4 hex digits), for example 3030");
  const x = xor(H(a), Buffer.concat([H(c), Buffer.alloc(6)])), out = tdes(sk, x);
  return { arpc: hex(out), steps: [["XOR the request cryptogram with the response code (2 bytes, then zeros)", hex(x)], ["Encrypt under the session key", hex(out)]] };
}

// ---- offline data authentication (simplified: RSA with SHA-256, not the card formats) ----
let RSA = null;
function rsa() {
  if (!RSA) { const g = () => crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }); RSA = { ca: g(), issuer: g(), icc: g(), fake: g() }; }
  return RSA;
}
const sign = (priv, d) => crypto.sign("sha256", Buffer.from(d), priv), verify = (pub, d, s) => { try { return crypto.verify("sha256", Buffer.from(d), pub, s); } catch { return false; } };
const pubPem = (k) => k.export({ type: "spki", format: "pem" });
const ATTACKS = { none: "No attack", tamper: "Change the card data after it was signed", clone: "Copy the card's data onto a fake card (no private key)", replay: "Replay an earlier signature", change_amount: "Alter the amount between card and terminal" };
function offline({ method, attack, pan }) {
  method = String(method || "sda"); attack = String(attack || "none"); need(["sda", "dda", "cda"].includes(method), "method must be sda, dda or cda"); need(ATTACKS[attack], "attack must be one of " + Object.keys(ATTACKS).join(", "));
  pan = digits(pan || "4111111111111111", null, "pan"); const K = rsa(), steps = []; let detected = false; const add = (t, ok, note) => steps.push({ step: t, ok, note });
  const issuerCert = sign(K.ca.privateKey, pubPem(K.issuer.publicKey) + "|ISSUER|2029"), iccCertBody = pubPem(K.icc.publicKey) + "|" + pan + "|2029", iccCert = sign(K.issuer.privateKey, iccCertBody);
  const staticData = pan + "|2812|101"; const ssad = sign(K.issuer.privateKey, staticData);
  const okIssuer = verify(K.ca.publicKey, pubPem(K.issuer.publicKey) + "|ISSUER|2029", issuerCert);
  add("Terminal recovers the issuer's public key from its certificate, using the scheme's public key it already holds", okIssuer, okIssuer ? "The issuer key is certified." : "The certificate does not verify.");
  let shownData = staticData; if (attack === "tamper") shownData = pan + "|2812|201";
  if (method === "sda") {
    const ok = verify(K.issuer.publicKey, shownData, ssad); detected = !ok;
    add("Terminal hashes the static card data and compares it with the signed copy", ok, ok ? "They match." : "They differ: the data was changed after signing.");
    if (attack === "clone") add("A fake card repeats the real card's static data and signed copy", true, "Nothing in the check depends on a secret held by the card, so the copy passes.");
    if (attack === "change_amount") add("Amount altered in transit", true, "Static data authentication covers no transaction data, so this goes unnoticed.");
    return { method, attack, steps, detected, passed: ok, lesson: attack === "clone" ? "Static data authentication proves the data was signed by the issuer, not that this card is the genuine one. A copy passes." : attack === "tamper" ? "Any change to the signed data is caught." : attack === "change_amount" ? "Offline authentication of static data says nothing about the transaction itself." : "The signed static data verifies." };
  }
  const shownBody = attack === "tamper" ? iccCertBody.replace("|2029", "|2030") : iccCertBody, okIcc = verify(K.issuer.publicKey, shownBody, iccCert); add("Terminal recovers the card's public key from the card's certificate", okIcc, okIcc ? "The card key is certified by the issuer." : "The certificate does not match the card data: it was altered after signing.");
  const un = crypto.randomBytes(4).toString("hex").toUpperCase(), txn = method === "cda" ? "amount=12.00|gbp" : "";
  add("Terminal sends a fresh challenge (unpredictable number)", true, un);
  const priv = attack === "clone" ? K.fake.privateKey : K.icc.privateKey;
  let signedOver = un + "|atc=0002" + (method === "cda" ? "|" + txn : "");
  let sigOn = signedOver; if (attack === "replay") sigOn = "OLD" + crypto.randomBytes(2).toString("hex").toUpperCase() + "|atc=0001";
  const sig = sign(priv, sigOn); add("Card signs the challenge" + (method === "cda" ? " together with the transaction data and cryptogram" : "") + " with its private key", true, attack === "clone" ? "A fake card has no genuine private key, so it signs with some other key." : attack === "replay" ? "The attacker can only offer a signature made for an earlier challenge." : "Signed.");
  let check = signedOver; if (attack === "change_amount" && method === "cda") check = un + "|atc=0002|amount=1200.00|gbp";
  const ok = verify(K.icc.publicKey, check, sig);
  if (attack === "change_amount" && method === "dda") { add("Amount altered in transit", true, "The signature covers the challenge, not the transaction, so the change is not noticed."); detected = false; }
  else { detected = !ok || !okIcc; }
  const passed = method === "dda" && attack === "change_amount" ? true : ok && okIcc;
  add(method === "cda" ? "Terminal checks the signature against its own copy of the transaction data" : "Terminal verifies the signature on the challenge with the card's public key", passed, passed ? "Valid." : "Does not verify.");
  const lessons = { dda: { clone: "A copy has no private key, so it cannot answer a fresh challenge. This is what dynamic authentication adds.", replay: "A replayed signature was made for an old challenge, so it fails.", tamper: "Changed static data no longer matches what the card's certificate commits to.", change_amount: "Dynamic authentication proves the card is genuine but does not protect the amount.", none: "The card proved it holds the private key." }, cda: { clone: "A copy cannot sign.", replay: "A replayed signature fails.", tamper: "Changed data is caught.", change_amount: "In combined authentication the card's signature covers the transaction data, so the changed amount is caught.", none: "The signature covers the challenge, the cryptogram and the transaction data." } };
  return { method, attack, steps, detected, passed, lesson: lessons[method][attack] };
}

module.exports = { DEC_DEFAULT, naturalPin, pinOffset, offsetCheck, KEYS, KEY_KINDS, CVV_KIND, ATTACKS, DEFAULT_TXN, cvv, pvv, buildPinBlock, openPinBlock, randomPin, deriveMaster, sessionKey, arqc, arpc, txnData, retailMac, offline, des, tdes, decimalise, hex, H, xor, parity, luhnDigit, need };
