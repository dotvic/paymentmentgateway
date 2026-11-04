"use strict";
// Plain-language meanings of Zanboxx status codes and 3-D Secure statuses. Shared by the MCP server and the AI tutor.
module.exports = {
  "SBX-2000": "Approved.", "SBX-2002": "Approved without liability shift (3-D Secure was unavailable).", "SBX-2010": "Processing; the final state follows.",
  "SBX-2020": "Waiting for 3-D Secure. Complete the challenge with complete_3ds_challenge.",
  "SBX-4030": "3-D Secure authentication failed. The customer did not pass the challenge.", "SBX-4032": "3-D Secure rejected by the issuer. Do not retry this card.",
  "SBX-4220": "Parent transaction did not succeed.", "SBX-4221": "Parent transaction is already voided.", "SBX-4222": "capture-authorization needs an authorization as parent.",
  "SBX-4223": "Amount exceeds the uncaptured balance.", "SBX-4224": "A refund needs a purchase, debit or capture as parent.", "SBX-4225": "Amount exceeds the refundable balance (money held by a dispute cannot be refunded).",
  "SBX-4226": "Refunds and voids cannot be voided.", "SBX-4227": "Authorization already captured; refund the capture.", "SBX-4228": "Already refunded; it can no longer be voided.",
  "SBX-4229": "Parent transaction used a different payment method.", "SBX-4230": "Disputes are for card payments only.", "SBX-4231": "Only a successful purchase or capture can be disputed.",
  "SBX-4232": "Dispute amount exceeds the disputable balance.", "SBX-4233": "Transaction is disputed; it can no longer be voided.", "SBX-4234": "Already cleared in a settlement; refund instead of voiding.",
  "SBX-4240": "Agreement is not active; no more merchant-initiated payments.", "SBX-4242": "All instalments have been collected.",
  "SBX-5000": "Gateway error injected by your failure script.", "SBX-5040": "Gateway timeout; outcome unknown. Wait for the webhook or poll before retrying.",
  "3DS Y": "Authenticated. Liability shifts to the issuer.", "3DS A": "Attempt recorded. Liability usually shifts.", "3DS N": "Authentication denied.",
  "3DS U": "Authentication unavailable. No liability shift.", "3DS R": "Rejected by the issuer. Do not retry.", "3DS C": "Challenge required.",
};
