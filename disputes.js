"use strict";
// Dispute (chargeback) simulation for card payments.
//
// Real flow: the cardholder tells their bank they do not recognise or accept a charge. The bank raises a dispute
// through the card scheme, the money is pulled back from the merchant, and the merchant has a limited time to send
// evidence. The issuer then decides. Here the "bank" is simulated: you trigger the dispute yourself, and the outcome
// follows your evidence, a forced result, or the deadline.
//
// States: needs_response -> under_review -> won | lost, and needs_response -> lost (accepted or deadline passed).
const SCH = require("./schemes");

const CATEGORIES = {
  fraud: {
    label: "Fraud",
    claim: "The cardholder says they did not make or authorise this payment.",
    accepted: ["customer_ip", "customer_email", "device_fingerprint", "billing_address_match", "authentication_proof", "customer_history", "uncategorized_text"],
    required: ["customer_ip", "customer_email"],
    tip: "Show that the real customer made the payment: IP address, email, device, earlier orders. A 3-D Secure authentication that shifted liability to the issuer wins fraud disputes without evidence.",
  },
  not_received: {
    label: "Goods or services not received",
    claim: "The cardholder says the goods or services never arrived.",
    accepted: ["tracking_number", "shipping_carrier", "delivery_date", "proof_of_delivery", "customer_communication", "uncategorized_text"],
    required: ["tracking_number", "proof_of_delivery"],
    tip: "Prove delivery: a carrier tracking number and a signed or photographed proof of delivery.",
  },
  not_as_described: {
    label: "Not as described or defective",
    claim: "The cardholder says what they received does not match what you sold.",
    accepted: ["product_description", "customer_communication", "refund_policy", "cancellation_policy", "uncategorized_text"],
    required: ["product_description", "customer_communication"],
    tip: "Show what you advertised and how you dealt with the customer: product page, messages, your refund policy.",
  },
  duplicate: {
    label: "Duplicate processing",
    claim: "The cardholder says they were charged twice for the same purchase.",
    accepted: ["original_transaction_reference", "explanation", "receipts", "uncategorized_text"],
    required: ["original_transaction_reference", "explanation"],
    tip: "Show that the two charges were for separate purchases, with a reference for each.",
  },
};
const OUTCOMES = ["auto", "win", "lose"];
const MAX_DISPUTES = 50, MAX_FIELD = 2000;
const DEFAULT_WINDOW_S = 7 * 24 * 3600;

module.exports = function createDisputes({ bad, rnd, r2, reviewMs }) {
  const now = () => new Date().toISOString();
  const note = (d, event, text) => d.history.push({ at: now(), event, note: text });
  const isOpen = (d) => d.state === "needs_response" || d.state === "under_review";

  // Mirrors the dispute on the payment: money held back, status for quick reading.
  function syncPayment(p, d) {
    p.dispute_id = d.id; p.dispute_state = d.state;
    p.disputed_amount = d.state === "won" ? 0 : d.amount; // won: the money comes back; open or lost: it stays withdrawn
  }

  function pickReason(p, b) {
    const profile = p.scheme ? SCH.SCHEMES[p.scheme] : null;
    if (b.reason_code !== undefined) {
      if (!profile) throw bad(400, "invalid_request", "This payment's card scheme is unknown, so send reason (fraud, not_received, not_as_described or duplicate) instead of reason_code");
      const r = profile.chargebacks.find((c) => c.code === String(b.reason_code));
      if (!r) throw bad(400, "invalid_request", `reason_code for ${profile.name} must be one of ${profile.chargebacks.map((c) => c.code).join(", ")}`);
      return { code: r.code, category: r.category, description: r.reason };
    }
    const cat = b.reason === undefined ? "fraud" : b.reason;
    if (!CATEGORIES[cat]) throw bad(400, "invalid_request", `reason must be one of ${Object.keys(CATEGORIES).join(", ")}`);
    const r = profile && profile.chargebacks.find((c) => c.category === cat);
    return r ? { code: r.code, category: cat, description: r.reason } : { code: null, category: cat, description: CATEGORIES[cat].label };
  }

  // Raises a dispute on a payment (the sandbox stands in for the cardholder's bank).
  function create(acc, p, b) {
    if (p.method !== "card") throw bad(422, "SBX-4230", "Disputes are available for card payments only");
    if (p.transaction_state !== "success" || !["purchase", "capture-authorization"].includes(p.transaction_type)) throw bad(422, "SBX-4231", "Only a successful purchase or capture can be disputed");
    if (p.dispute_id) throw bad(409, "dispute_exists", "This payment already has a dispute", { dispute_id: p.dispute_id });
    const reason = pickReason(p, b);
    const left = r2(p.amount - (p.refunded_amount || 0));
    const amount = b.amount === undefined ? left : Number(b.amount);
    if (!(amount > 0)) throw bad(400, "invalid_request", "amount must be greater than 0");
    if (amount > left) throw bad(422, "SBX-4232", `Amount exceeds the disputable balance of ${left.toFixed(2)} (payment minus refunds)`);
    const outcome = b.outcome === undefined ? "auto" : b.outcome;
    if (!OUTCOMES.includes(outcome)) throw bad(400, "invalid_request", `outcome must be one of ${OUTCOMES.join(", ")}`);
    let win = b.response_window_seconds === undefined ? DEFAULT_WINDOW_S : Number(b.response_window_seconds);
    if (!Number.isInteger(win) || win < 1 || win > DEFAULT_WINDOW_S) throw bad(400, "invalid_request", `response_window_seconds must be a whole number between 1 and ${DEFAULT_WINDOW_S} (7 days)`);
    acc.disputes = acc.disputes || [];
    if (acc.disputes.length >= MAX_DISPUTES) {
      const i = acc.disputes.findLastIndex((x) => !isOpen(x));
      if (i < 0) throw bad(429, "too_many_disputes", `At most ${MAX_DISPUTES} disputes can be open at once`);
      acc.disputes.splice(i, 1);
    }
    const cat = CATEGORIES[reason.category];
    const shifted = reason.category === "fraud" && !!(p.authentication && p.authentication.liability_shift === true);
    const t = Date.now();
    const d = {
      id: "dp_" + rnd(8), payment_id: p.id, state: "needs_response", amount, currency: p.currency, scheme: p.scheme || null,
      reason: { ...reason, claim: cat.claim }, created_at: now(), due_by: new Date(t + win * 1000).toISOString(),
      evidence_requirements: { required: cat.required, accepted: cat.accepted, tip: cat.tip },
      evidence: null, evidence_submitted_at: null, resolution: null, liability_shifted: shifted, simulation: { outcome }, history: [],
    };
    note(d, "created", `The cardholder's bank raised a ${reason.code ? reason.code + " " : ""}${reason.description} dispute. ${amount.toFixed(2)} ${p.currency} was withdrawn from your balance.`);
    if (shifted) {
      d.state = "under_review"; d.review_at = new Date(t + reviewMs).toISOString();
      note(d, "liability_shift", "This payment was authenticated with 3-D Secure, so liability for fraud sits with the issuer. No evidence is needed; the bank reviews the dispute and reverses it.");
    }
    acc.disputes.unshift(d);
    syncPayment(p, d);
    return d;
  }

  function submitEvidence(acc, p, d, b) {
    if (d.state !== "needs_response") throw bad(409, "invalid_state", d.state === "under_review" ? "Evidence was already submitted; the bank is reviewing it" : `The dispute is closed (${d.state})`);
    const ev = b && typeof b.evidence === "object" && b.evidence && !Array.isArray(b.evidence) ? b.evidence : b;
    const clean = {};
    for (const [k, v] of Object.entries(ev || {})) {
      if (!d.evidence_requirements.accepted.includes(k)) throw bad(400, "invalid_request", `Unknown evidence field "${k}" for a ${d.reason.category} dispute. Accepted: ${d.evidence_requirements.accepted.join(", ")}`);
      if (typeof v !== "string" && typeof v !== "boolean") throw bad(400, "invalid_request", `Evidence field "${k}" must be text`);
      const s = String(v).trim();
      if (s.length > MAX_FIELD) throw bad(400, "invalid_request", `Evidence field "${k}" is longer than ${MAX_FIELD} characters`);
      if (s) clean[k] = s;
    }
    if (!Object.keys(clean).length) throw bad(400, "invalid_request", `Send at least one evidence field. Accepted: ${d.evidence_requirements.accepted.join(", ")}`);
    d.evidence = clean; d.evidence_submitted_at = now(); d.state = "under_review"; d.review_at = new Date(Date.now() + reviewMs).toISOString();
    note(d, "evidence_submitted", `You submitted ${Object.keys(clean).length} evidence field${Object.keys(clean).length === 1 ? "" : "s"}. Evidence can only be submitted once. The bank is reviewing it.`);
    syncPayment(p, d);
    return d;
  }

  function accept(acc, p, d) {
    if (d.state !== "needs_response") throw bad(409, "invalid_state", d.state === "under_review" ? "Evidence was already submitted; the bank is reviewing it" : `The dispute is closed (${d.state})`);
    close(p, d, "lost", "accepted", "You accepted the dispute. The money stays with the cardholder.");
    return d;
  }

  function close(p, d, state, cause, text) {
    d.state = state; delete d.review_at;
    d.resolution = { result: state, cause, note: text, at: now() };
    note(d, state, text);
    syncPayment(p, d);
  }

  // Decides disputes that are due: reviews that finished and deadlines that passed. Returns the events to send.
  function sweep(acc, t = Date.now()) {
    const events = [];
    for (const d of acc.disputes || []) {
      const p = acc.payments.find((x) => x.id === d.payment_id);
      if (!p) continue;
      if (d.state === "needs_response" && Date.parse(d.due_by) <= t) {
        close(p, d, "lost", "no_response", "The response deadline passed without evidence, so the bank decided in the cardholder's favour. Real deadlines are strict.");
        events.push({ type: "dispute.lost", d });
      } else if (d.state === "under_review" && Date.parse(d.review_at) <= t) {
        const miss = d.evidence_requirements.required.filter((k) => !(d.evidence && d.evidence[k] && d.evidence[k].length >= 3));
        const o = d.simulation.outcome;
        if (o === "win") close(p, d, "won", "simulated_win", "You chose to win this dispute in the simulation. The funds return to your balance.");
        else if (o === "lose") close(p, d, "lost", "simulated_loss", "You chose to lose this dispute in the simulation. The money stays with the cardholder.");
        else if (d.liability_shifted) close(p, d, "won", "liability_shift", "The bank reversed the dispute: 3-D Secure moved liability for this fraud claim to the issuer.");
        else if (!miss.length) close(p, d, "won", "evidence_accepted", "The bank accepted your evidence and ruled for you. The funds return to your balance.");
        else close(p, d, "lost", "evidence_insufficient", `The evidence was not enough. Missing: ${miss.join(", ")}. The money stays with the cardholder.`);
        events.push({ type: d.state === "won" ? "dispute.won" : "dispute.lost", d });
      }
    }
    return events;
  }

  const publicDispute = (d) => { const { review_at, ...rest } = d; return rest; };
  const hasOpen = (acc) => (acc.disputes || []).some(isOpen);
  return { create, submitEvidence, accept, sweep, publicDispute, hasOpen, isOpen };
};
module.exports.CATEGORIES = CATEGORIES;
module.exports.OUTCOMES = OUTCOMES;
