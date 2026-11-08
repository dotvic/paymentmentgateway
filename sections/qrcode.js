"use strict";
// Small QR code encoder (byte mode, error correction L or M, versions 1 to 15). Written for the QR lab so the server
// needs no library. Returns a square matrix of booleans (true = dark).

const ECC = { L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22], M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24] };
const BLOCKS = { L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6], M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10] };
const FMT = { L: 1, M: 0 };

const rawModules = (v) => { let r = (16 * v + 128) * v + 64; if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; } return r; };
const gfMul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z; };
const rsDivisor = (d) => { const r = new Array(d).fill(0); r[d - 1] = 1; let root = 1; for (let i = 0; i < d; i++) { for (let j = 0; j < d; j++) { r[j] = gfMul(r[j], root); if (j + 1 < d) r[j] ^= r[j + 1]; } root = gfMul(root, 2); } return r; };
const rsRemainder = (data, div) => { const r = div.map(() => 0); for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= gfMul(c, f); }); } return r; };
const bit = (x, i) => ((x >>> i) & 1) !== 0;

function encode(text, level) {
  level = level === "L" ? "L" : "M";
  const bytes = [...Buffer.from(String(text), "utf8")];
  let ver = 0, dataCw = 0;
  for (let v = 1; v <= 15; v++) {
    const cap = Math.floor(rawModules(v) / 8) - ECC[level][v - 1] * BLOCKS[level][v - 1], need = 4 + (v < 10 ? 8 : 16) + 8 * bytes.length;
    if (need <= cap * 8) { ver = v; dataCw = cap; break; }
  }
  if (!ver) { const e = new Error("Text is too long for this lab's QR code (limit about 400 characters)."); e.code = "too_long"; throw e; }
  const bits = []; const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); bytes.forEach((b) => put(b, 8));
  put(0, Math.min(4, dataCw * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < dataCw * 8; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  // split into blocks, add error correction, interleave
  const nb = BLOCKS[level][ver - 1], eccLen = ECC[level][ver - 1], raw = Math.floor(rawModules(ver) / 8), shortLen = Math.floor(raw / nb), numShort = nb - (raw % nb), div = rsDivisor(eccLen), blocks = [];
  for (let i = 0, k = 0; i < nb; i++) { const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1)); k += dat.length; const ecc = rsRemainder(dat, div); if (i < numShort) dat.push(0); blocks.push(dat.concat(ecc)); }
  const all = []; for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= numShort) all.push(b[i]); });
  const size = ver * 4 + 17, mod = Array.from({ length: size }, () => new Array(size).fill(false)), fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setF = (x, y, d) => { mod[y][x] = d; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy; if (x >= 0 && x < size && y >= 0 && y < size) setF(x, y, d !== 2 && d !== 4); } };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  if (ver > 1) {
    const n = Math.floor(ver / 7) + 2, step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2, pos = [6]; for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) { if ((a === 0 && b === 0) || (a === 0 && b === n - 1) || (a === n - 1 && b === 0)) continue; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setF(pos[a] + dx, pos[b] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }
  }
  const formatBits = (mask) => { const d = (FMT[level] << 3) | mask; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537); const bits15 = ((d << 10) | r) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setF(8, i, bit(bits15, i)); setF(8, 7, bit(bits15, 6)); setF(8, 8, bit(bits15, 7)); setF(7, 8, bit(bits15, 8)); for (let i = 9; i < 15; i++) setF(14 - i, 8, bit(bits15, i));
    for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, bit(bits15, i)); for (let i = 8; i < 15; i++) setF(8, size - 15 + i, bit(bits15, i)); setF(8, size - 8, true); };
  formatBits(0);
  if (ver >= 7) { let r = ver; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25); const vb = (ver << 12) | r; for (let i = 0; i < 18; i++) { const a = size - 11 + (i % 3), b = Math.floor(i / 3); setF(a, b, bit(vb, i)); setF(b, a, bit(vb, i)); } }
  // place data
  for (let i = 0, right = size - 1; right >= 1; right -= 2) { if (right === 6) right = 5; for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) { const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - v : v; if (!fn[y][x] && i < all.length * 8) { mod[y][x] = bit(all[i >>> 3], 7 - (i & 7)); i++; } } }
  const MASK = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0, (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
  const apply = (m) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASK[m](x, y)) mod[y][x] = !mod[y][x]; };
  const penalty = () => { let p = 0; for (let t = 0; t < 2; t++) for (let a = 0; a < size; a++) { let run = 1; for (let b = 1; b < size; b++) { const c = t ? mod[b][a] : mod[a][b], d = t ? mod[b - 1][a] : mod[a][b - 1]; if (c === d) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) if (mod[y][x] === mod[y][x + 1] && mod[y][x] === mod[y + 1][x] && mod[y][x] === mod[y + 1][x + 1]) p += 3;
    let dark = 0; for (const row of mod) for (const c of row) if (c) dark++; p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10; return p; };
  let best = 0, bestP = Infinity;
  for (let m = 0; m < 8; m++) { apply(m); formatBits(m); const p = penalty(); if (p < bestP) { bestP = p; best = m; } apply(m); }
  apply(best); formatBits(best);
  return { version: ver, level, size, matrix: mod };
}

function toSvg(matrix, { quiet = 4, dark = "#111", light = "#fff" } = {}) {
  const n = matrix.length, tot = n + quiet * 2; let d = "";
  for (let y = 0; y < n; y++) { let x = 0; while (x < n) { if (!matrix[y][x]) { x++; continue; } let w = 1; while (x + w < n && matrix[y][x + w]) w++; d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`; x += w; } }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${tot} ${tot}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${tot}" height="${tot}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}

module.exports = { encode, toSvg };
