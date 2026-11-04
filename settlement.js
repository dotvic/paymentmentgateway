"use strict";
// Clearing, settlement and payout simulation.
//
// On a real card payment the money moves in steps: the merchant's acquirer sends the transactions to the card scheme
// for clearing, the scheme nets what each side owes and settles, and the acquirer pays the merchant out. The files that
// carry this are exchanged between acquirers, issuers and schemes; merchants normally see only the acquirer's report.
//
// Zanboxx simulates the chain. "Closing the day" collects everything that has not been cleared yet, writes one clearing
// file per scheme, a settlement report and a payout file. The file layouts are made up for teaching (one fixed-width, one
// pipe-delimited, one record-typed CSV) and are NOT the layouts the real networks use. Fees are a fictional schedule.
const SCH = require("./schemes");

const FEES = {
  visa: { percent: 1.4, fixed: 0.1 },
  mastercard: { percent: 1.5, fixed: 0.1 },
  amex: { percent: 2.5, fixed: 0 },
  chargeback_fixed: 15,
  note: "A fictional fee schedule for teaching. Fees are charged on each presentment and each chargeback and are not returned on refunds.",
};
// Fictional cost build-up for the interchange report. Real interchange depends on the issuer, card product, region and
// regulation; these numbers only show how a fee splits into issuer, network and acquirer parts.
const INTERCHANGE = {
  percent: {
    domestic: { consumer_debit: 0.2, consumer_credit: 0.3, commercial: 0.9 },
    eea: { consumer_debit: 0.2, consumer_credit: 0.3, commercial: 1.0 },
    international: { consumer_debit: 1.15, consumer_credit: 1.5, commercial: 1.9 },
  },
  scheme_fee: { visa: { percent: 0.13, fixed: 0.02 }, mastercard: { percent: 0.14, fixed: 0.02 } },
  acquirer_markup: { percent: 0.25, fixed: 0.05 },
  note: "A fictional teaching schedule. Visa and Mastercard are four-party schemes: the fee splits into interchange (paid to the card issuer), a scheme fee (paid to the network) and the acquirer's markup. Amex is a three-party scheme: it charges one discount rate, so there is nothing to unbundle.",
};
const SCHEME_ORDER = ["visa", "mastercard", "amex"];
const KINDS = ["presentment", "refund", "chargeback", "chargeback_reversal"];
const MAX_BATCHES = 10, MAX_RECORDS = 500, PAYOUT_DAYS = 2;

const cents = (a) => Math.round(Number(a) * 100);
const money = (c) => (c / 100).toFixed(2);
const ymd = (iso) => iso.slice(0, 10).replace(/-/g, "");
const ts14 = (iso) => iso.slice(0, 19).replace(/[-:T]/g, "");
const csvCell = (v) => { const s = v == null ? "" : String(v); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csvLine = (a) => a.map(csvCell).join(",");

module.exports = function createSettlement({ bad, rnd }) {
  const feeFor = (r) => (r.kind === "presentment" ? cents(r.amount) * FEES[r.scheme].percent / 100 + FEES[r.scheme].fixed * 100 : r.kind === "chargeback" ? FEES.chargeback_fixed * 100 : 0);

  // Everything that has happened since the last closing and belongs to a known scheme.
  function collect(acc, cutoffMs) {
    const ev = [];
    for (const p of acc.payments) {
      if (p.method !== "card" || p.transaction_state !== "success" || !SCH.SCHEMES[p.scheme] || p.settled_in) continue;
      const isPay = p.transaction_type === "purchase" || p.transaction_type === "capture-authorization";
      if ((isPay && !p.voided) || p.transaction_type === "refund") {
        ev.push({ kind: isPay ? "presentment" : "refund", scheme: p.scheme, payment_id: p.id, dispute_id: null, agreement_id: p.agreement_id || null, mit: p.initiator === "merchant",
          ntid: p.network_transaction_id || null, amount: p.amount, currency: p.currency, at: p.created_at, reason_code: "", card_last4: p.card_last4 || "", card_type: p.card_type || null, card_region: p.card_region || null, flag: [p, "settled_in"] });
      }
    }
    for (const d of acc.disputes || []) {
      if (!SCH.SCHEMES[d.scheme]) continue;
      const p = acc.payments.find((x) => x.id === d.payment_id);
      const base = { scheme: d.scheme, payment_id: d.payment_id, dispute_id: d.id, agreement_id: p && p.agreement_id || null, mit: !!(p && p.initiator === "merchant"), ntid: p && p.network_transaction_id || null,
        amount: d.amount, currency: d.currency, reason_code: d.reason.code || "", card_last4: p && p.card_last4 || "" };
      if (!d.cb_settled_in) ev.push({ ...base, kind: "chargeback", at: d.created_at, flag: [d, "cb_settled_in"] });
      if (d.state === "won" && d.resolution && !d.cbr_settled_in) ev.push({ ...base, kind: "chargeback_reversal", at: d.resolution.at, flag: [d, "cbr_settled_in"] });
    }
    return ev.filter((e) => Date.parse(e.at) <= cutoffMs).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.payment_id < b.payment_id ? -1 : 1)).slice(0, MAX_RECORDS);
  }

  function totalsAndPayouts(records) {
    const map = new Map();
    for (const r of records) {
      const key = r.scheme + "/" + r.currency;
      if (!map.has(key)) map.set(key, { scheme: r.scheme, currency: r.currency, c: { presentment: [0, 0], refund: [0, 0], chargeback: [0, 0], chargeback_reversal: [0, 0] }, fees: 0 });
      const t = map.get(key); t.c[r.kind][0]++; t.c[r.kind][1] += cents(r.amount); t.fees += cents(r.fee);
    }
    const totals = [...map.values()].sort((a, b) => SCHEME_ORDER.indexOf(a.scheme) - SCHEME_ORDER.indexOf(b.scheme) || (a.currency < b.currency ? -1 : 1)).map((t) => {
      const net = t.c.presentment[1] - t.c.refund[1] - t.c.chargeback[1] + t.c.chargeback_reversal[1] - t.fees;
      const o = { scheme: t.scheme, currency: t.currency };
      for (const k of KINDS) o[k + "s"] = { count: t.c[k][0], amount: Number(money(t.c[k][1])) };
      return { ...o, fees: Number(money(t.fees)), net: Number(money(net)), _net: net };
    });
    const po = new Map();
    for (const t of totals) po.set(t.currency, (po.get(t.currency) || 0) + t._net);
    const payouts = [...po.entries()].sort().map(([currency, c]) => ({ id: "po_" + rnd(5), currency, amount: Number(money(c)), direction: c >= 0 ? "to_merchant" : "from_merchant" }));
    return { totals: totals.map(({ _net, ...rest }) => rest), payouts };
  }

  // Closes the day: everything uncleared up to the end of `cutoff` (YYYY-MM-DD, UTC) goes into one batch.
  function createBatch(acc, cutoff) {
    const cutoffMs = Date.parse(cutoff + "T23:59:59.999Z");
    const ev = collect(acc, cutoffMs);
    if (!ev.length) throw bad(409, "nothing_to_settle", `Nothing to clear up to ${cutoff}. Card payments with Visa, Mastercard or Amex test cards are cleared once they succeed; failed, voided and authorization-only payments are not.`);
    const id = "stl_" + rnd(4); // 12 characters, so it fits the fixed-width header
    const records = ev.map((e, i) => {
      const { flag, ...r } = e; flag[0][flag[1]] = id;
      return { n: i + 1, ...r, fee: Number(money(Math.round(feeFor(r)))) };
    });
    const { totals, payouts } = totalsAndPayouts(records);
    const pd = new Date(Date.parse(cutoff + "T00:00:00Z") + PAYOUT_DAYS * 864e5).toISOString().slice(0, 10);
    const b = { id, cutoff, created_at: new Date().toISOString(), payout_date: pd, record_count: records.length, totals, payouts: payouts.map((p) => ({ ...p, payout_date: pd })), records };
    acc.settlements = acc.settlements || [];
    acc.settlements.unshift(b);
    if (acc.settlements.length > MAX_BATCHES) acc.settlements.length = MAX_BATCHES;
    return b;
  }
  const summary = (b) => { const { records, ...rest } = b; return rest; };

  // Splits the fees of a batch into interchange, scheme fee and acquirer margin, and compares the blended price you paid
  // with what interchange++ pricing (cost plus a fixed markup) would have cost. Only presentments carry fees here.
  function interchange(b) {
    const m = new Map();
    for (const r of b.records) {
      if (r.kind !== "presentment") continue;
      const type = r.card_type || "consumer_credit", region = r.card_region || "domestic", key = [r.scheme, type, region, r.currency].join("/");
      if (!m.has(key)) m.set(key, { scheme: r.scheme, card_type: type, card_region: region, currency: r.currency, count: 0, volume: 0, ic: 0, sf: 0, mk: 0, blended: 0 });
      const g = m.get(key), amt = cents(r.amount);
      g.count++; g.volume += amt; g.blended += cents(r.fee);
      if (r.scheme !== "amex") {
        const sf = INTERCHANGE.scheme_fee[r.scheme], mk = INTERCHANGE.acquirer_markup;
        g.ic += amt * INTERCHANGE.percent[region][type] / 100; g.sf += amt * sf.percent / 100 + sf.fixed * 100; g.mk += amt * mk.percent / 100 + mk.fixed * 100;
      }
    }
    const groups = [...m.values()].sort((a, b) => SCHEME_ORDER.indexOf(a.scheme) - SCHEME_ORDER.indexOf(b.scheme) || (a.card_type + a.card_region < b.card_type + b.card_region ? -1 : 1)).map((g) => {
      const three = g.scheme === "amex", ic = Math.round(g.ic), sf = Math.round(g.sf), mk = Math.round(g.mk), ipp = three ? g.blended : ic + sf + mk;
      return { scheme: g.scheme, card_type: g.card_type, card_region: g.card_region, currency: g.currency, count: g.count, volume: Number(money(g.volume)),
        interchange: Number(money(three ? 0 : ic)), scheme_fees: Number(money(three ? 0 : sf)), acquirer_margin: Number(money(three ? g.blended : g.blended - ic - sf)),
        blended_total: Number(money(g.blended)), interchange_plus_total: Number(money(ipp)), difference: Number(money(g.blended - ipp)), ...(three ? { note: "Amex discount rate: one fee, not unbundled" } : {}) };
    });
    const tm = new Map();
    for (const g of groups) {
      if (!tm.has(g.currency)) tm.set(g.currency, { currency: g.currency, volume: 0, blended_total: 0, interchange_plus_total: 0 });
      const t = tm.get(g.currency); t.volume += cents(g.volume); t.blended_total += cents(g.blended_total); t.interchange_plus_total += cents(g.interchange_plus_total);
    }
    const totals = [...tm.values()].sort((a, c) => (a.currency < c.currency ? -1 : 1)).map((t) => ({ currency: t.currency, volume: Number(money(t.volume)), blended_total: Number(money(t.blended_total)), interchange_plus_total: Number(money(t.interchange_plus_total)),
      difference: Number(money(t.blended_total - t.interchange_plus_total)), blended_effective_rate_percent: t.volume ? Number((t.blended_total / t.volume * 100).toFixed(3)) : 0, interchange_plus_effective_rate_percent: t.volume ? Number((t.interchange_plus_total / t.volume * 100).toFixed(3)) : 0 }));
    return { batch_id: b.id, settlement_date: b.cutoff, groups, totals, schedule: INTERCHANGE,
      how_to_read: "blended_total is what the settlement charged you. interchange_plus_total is what you would pay if each cost were passed through and only a fixed markup were added. A positive difference means blended pricing cost you more on that mix of cards; a negative one means it cost less. acquirer_margin is what is left of the blended fee after interchange and the scheme fee." };
  }

  // ---------- files ----------
  const KIND2 = { presentment: "PS", refund: "RF", chargeback: "CB", chargeback_reversal: "CR" };
  const pad = (s, n) => String(s == null ? "" : s).padEnd(n).slice(0, n);
  const zero = (n, w) => String(n).padStart(w, "0");
  const LAYOUTS = {
    visa: { ext: "dat", format: "fixed-width", type: "text/plain",
      spec: ["H record: 'H', batch id (12), settlement date YYYYMMDD (8)",
        "D record (95 chars): 'D', kind (2: PS presentment, RF refund, CB chargeback, CR reversal), transaction id (19), dispute id (19), network transaction id (15), amount in minor units (12, zero padded), currency (3), card last four (4), reason code (6), timestamp YYYYMMDDHHMMSS (14)",
        "T record: 'T', detail count (8), hash total of all amounts in minor units (14)"] },
    mastercard: { ext: "txt", format: "pipe-delimited", type: "text/plain",
      spec: ["HDR|batch id|settlement date|MASTERCARD", "TXN|kind|transaction id|dispute id|trace id|amount|currency|card last four|reason code|timestamp", "TRL|detail count|sum of amounts"] },
    amex: { ext: "csv", format: "record-typed CSV", type: "text/csv",
      spec: ["HEADER,batch id,settlement date,AMEX", "column names row", "DETAIL,kind,transaction id,dispute id,transaction identifier,amount,currency,card last four,reason code,timestamp", "TRAILER,detail count,sum of amounts"] },
  };
  const fname = (b, scheme) => `zbx-${scheme}-clearing-${ymd(b.cutoff)}.${LAYOUTS[scheme].ext}`;
  const names = (b) => ({
    clearing: SCHEME_ORDER.filter((s) => b.records.some((r) => r.scheme === s)).map((s) => ({ name: fname(b, s), scheme: s, kind: "clearing", format: LAYOUTS[s].format, layout: LAYOUTS[s].spec })),
    settlement: `zbx-settlement-${ymd(b.cutoff)}.csv`, interchange: `zbx-interchange-${ymd(b.cutoff)}.csv`, payout: `zbx-payout-${ymd(b.cutoff)}.csv`,
  });
  function listFiles(b) {
    const n = names(b);
    return [...n.clearing.map((f) => ({ ...f, records: b.records.filter((r) => r.scheme === f.scheme).length })),
      { name: n.settlement, kind: "settlement report", format: "CSV", layout: ["One row per scheme and currency: counts and amounts of presentments, refunds, chargebacks and reversals, fees and net"] },
      { name: n.interchange, kind: "interchange report", format: "CSV", layout: ["One row per scheme, card type, region and currency: volume, interchange, scheme fee, acquirer margin, what you paid (blended) and what interchange++ pricing would cost"] },
      { name: n.payout, kind: "payout", format: "CSV", layout: ["One row per currency: the amount paid out (or collected) and the payout date"] }];
  }
  function build(b, name) {
    const n = names(b);
    const c = n.clearing.find((f) => f.name === name);
    if (c) {
      const rs = b.records.filter((r) => r.scheme === c.scheme), sumC = rs.reduce((a, r) => a + cents(r.amount), 0);
      let lines;
      if (c.scheme === "visa") lines = ["H" + pad(b.id, 12) + ymd(b.cutoff), ...rs.map((r) => "D" + KIND2[r.kind] + pad(r.payment_id, 19) + pad(r.dispute_id, 19) + pad(r.ntid, 15) + zero(cents(r.amount), 12) + r.currency + pad(r.card_last4, 4) + pad(r.reason_code, 6) + ts14(r.at)), "T" + zero(rs.length, 8) + zero(sumC, 14)];
      else if (c.scheme === "mastercard") lines = [`HDR|${b.id}|${b.cutoff}|MASTERCARD`, ...rs.map((r) => ["TXN", r.kind.toUpperCase(), r.payment_id, r.dispute_id || "", r.ntid || "", money(cents(r.amount)), r.currency, r.card_last4, r.reason_code, r.at].join("|")), `TRL|${rs.length}|${money(sumC)}`];
      else lines = [csvLine(["HEADER", b.id, b.cutoff, "AMEX"]), "record_type,kind,transaction_id,dispute_id,transaction_identifier,amount,currency,card_last4,reason_code,timestamp",
        ...rs.map((r) => csvLine(["DETAIL", r.kind, r.payment_id, r.dispute_id || "", r.ntid || "", money(cents(r.amount)), r.currency, r.card_last4, r.reason_code, r.at])), csvLine(["TRAILER", rs.length, money(sumC)])];
      return { type: LAYOUTS[c.scheme].type, body: lines.join("\n") + "\n" };
    }
    if (name === n.settlement) {
      const rows = [csvLine(["batch_id", "settlement_date", "scheme", "currency", "presentments_count", "presentments_amount", "refunds_count", "refunds_amount", "chargebacks_count", "chargebacks_amount", "reversals_count", "reversals_amount", "fees", "net"])];
      for (const t of b.totals) rows.push(csvLine([b.id, b.cutoff, t.scheme, t.currency, t.presentments.count, t.presentments.amount.toFixed(2), t.refunds.count, t.refunds.amount.toFixed(2), t.chargebacks.count, t.chargebacks.amount.toFixed(2), t.chargeback_reversals.count, t.chargeback_reversals.amount.toFixed(2), t.fees.toFixed(2), t.net.toFixed(2)]));
      return { type: "text/csv", body: rows.join("\n") + "\n" };
    }
    if (name === n.interchange) {
      const rep = interchange(b), rows = [csvLine(["batch_id", "settlement_date", "scheme", "card_type", "card_region", "currency", "presentments", "volume", "interchange", "scheme_fees", "acquirer_margin", "blended_total", "interchange_plus_total", "difference"])];
      for (const g of rep.groups) rows.push(csvLine([b.id, b.cutoff, g.scheme, g.card_type, g.card_region, g.currency, g.count, g.volume.toFixed(2), g.interchange.toFixed(2), g.scheme_fees.toFixed(2), g.acquirer_margin.toFixed(2), g.blended_total.toFixed(2), g.interchange_plus_total.toFixed(2), g.difference.toFixed(2)]));
      return { type: "text/csv", body: rows.join("\n") + "\n" };
    }
    if (name === n.payout) {
      const rows = [csvLine(["payout_id", "batch_id", "currency", "amount", "direction", "payout_date"]), ...b.payouts.map((p) => csvLine([p.id, b.id, p.currency, p.amount.toFixed(2), p.direction, p.payout_date]))];
      return { type: "text/csv", body: rows.join("\n") + "\n" };
    }
    return null;
  }

  // ---------- reconciliation: your ledger against one batch ----------
  function parseCsv(text) {
    const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) throw bad(400, "invalid_request", "The CSV needs a header row and at least one row");
    const d = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ";" : ",";
    const split = (l) => { const out = []; let cur = "", q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === d) { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out.map((s) => s.trim()); };
    const head = split(lines[0]).map((h) => h.toLowerCase());
    const col = (names) => head.findIndex((h) => names.includes(h));
    const ci = col(["transaction_id", "id", "tx", "transaction"]), ai = col(["amount"]), ui = col(["currency"]);
    if (ci < 0 || ai < 0) throw bad(400, "invalid_request", "The CSV needs columns transaction_id and amount (and optionally currency)");
    return lines.slice(1).map((l) => { const c = split(l); return { transaction_id: c[ci], amount: c[ai], currency: ui >= 0 ? c[ui] : undefined }; });
  }
  function reconcile(b, body) {
    let rows = body.ledger;
    if (rows === undefined && typeof body.csv === "string") rows = parseCsv(body.csv);
    if (!Array.isArray(rows) || !rows.length) throw bad(400, "invalid_request", 'Send your ledger as {"csv": "transaction_id,amount,currency\\n..."} or {"ledger": [{"transaction_id","amount","currency"}]}');
    if (rows.length > 2000) throw bad(400, "invalid_request", "At most 2000 ledger rows");
    const cleared = new Map(); const adjustments = [];
    for (const r of b.records) { if (r.kind === "presentment" || r.kind === "refund") cleared.set(r.payment_id, r); else adjustments.push(r); }
    const items = [], seen = new Set(), sum = { matched: 0, amount_mismatch: 0, currency_mismatch: 0, missing_in_clearing: 0, missing_in_ledger: 0, duplicate_in_ledger: 0 };
    const add = (status, id, ledger, rec, hint) => { sum[status]++; items.push({ transaction_id: id, status, ledger_amount: ledger ? ledger.amount : null, ledger_currency: ledger ? ledger.currency || null : null, cleared_amount: rec ? rec.amount : null, cleared_currency: rec ? rec.currency : null, kind: rec ? rec.kind : null, hint }); };
    for (const raw of rows) {
      const id = String(raw && raw.transaction_id || "").trim(), amt = Number(String(raw && raw.amount).replace(",", ".")), cur = raw && raw.currency ? String(raw.currency).trim().toUpperCase() : undefined;
      const led = { amount: Number.isFinite(amt) ? amt : null, currency: cur };
      if (!id) continue;
      if (seen.has(id)) { add("duplicate_in_ledger", id, led, null, "This transaction appears twice in your ledger. Check for a double booking."); continue; }
      seen.add(id);
      const rec = cleared.get(id);
      if (!rec) add("missing_in_clearing", id, led, null, "Not in this batch. It may be failed, voided, authorization-only, not yet cleared (it will arrive in a later batch), or already cleared in an earlier one.");
      else if (led.amount === null || cents(led.amount) !== cents(rec.amount)) add("amount_mismatch", id, led, rec, "The amounts differ. Look for partial captures, rounding, or a refund booked as a sale.");
      else if (cur && cur !== rec.currency) add("currency_mismatch", id, led, rec, "The currencies differ.");
      else add("matched", id, led, rec, "");
    }
    for (const [id, rec] of cleared) if (!seen.has(id)) add("missing_in_ledger", id, null, rec, rec.kind === "refund" ? "A refund was cleared that your ledger does not show." : "Cleared and paid out, but your ledger has no sale for it.");
    const ledgerNet = {}, clearedNet = {};
    for (const r of rows) { const c = (r.currency || "").toUpperCase(); if (c) ledgerNet[c] = (ledgerNet[c] || 0) + cents(String(r.amount).replace(",", ".") || 0); }
    for (const r of b.records) if (r.kind === "presentment" || r.kind === "refund") clearedNet[r.currency] = (clearedNet[r.currency] || 0) + (r.kind === "refund" ? -1 : 1) * cents(r.amount);
    return {
      settlement_id: b.id, summary: sum, ok: !items.some((i) => i.status !== "matched"), items: items.slice(0, 500),
      adjustments: adjustments.map((r) => ({ kind: r.kind, transaction_id: r.payment_id, dispute_id: r.dispute_id, amount: r.amount, currency: r.currency, scheme: r.scheme, reason_code: r.reason_code || null,
        hint: r.kind === "chargeback" ? "Money withdrawn by a dispute. It will not be in a ledger of sales, so book it separately." : "A dispute you won; the money came back." })),
      payouts: b.payouts, note: "Payouts are net of fees, refunds and chargebacks, so they will not equal your ledger total. Fees: " + FEES.note,
    };
  }

  // ---------- daily transaction export (all methods) ----------
  function transactionsCsv(acc, date) {
    const rows = [csvLine(["transaction_id", "request_id", "parent_transaction_id", "method", "transaction_type", "state", "status_code", "amount", "currency", "created_at", "scheme", "initiator", "agreement_id", "dispute_id", "dispute_state", "settled_in"])];
    for (const p of acc.payments.slice().reverse()) if (p.created_at.slice(0, 10) === date) rows.push(csvLine([p.id, p.request_id, p.parent_transaction_id, p.method, p.transaction_type, p.transaction_state, p.status && p.status.code, Number(p.amount).toFixed(2), p.currency, p.created_at, p.scheme, p.initiator, p.agreement_id, p.dispute_id, p.dispute_state, p.settled_in]));
    return rows.join("\n") + "\n";
  }

  return { FEES, INTERCHANGE, interchange, collect, createBatch, summary, listFiles, build, reconcile, transactionsCsv };
};
module.exports.FEES = FEES;
