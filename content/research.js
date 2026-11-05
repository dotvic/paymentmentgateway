"use strict";
// Evergreen explainers written by the Zanboxx team. Dated notes, not news: nothing here claims a current event.
module.exports = [
  { slug: "why-payments-get-declined", title: "Why good payments get declined", published_at: "2026-11-01T09:00:00Z", tags: ["cards", "authorisation"], summary: "Most declines are not fraud. A look at the usual causes and what a merchant can change.",
    markdown: `## The short version

Most declined card payments are from real customers. Issuers decline for many reasons, and only some are about the customer's money.

## The common causes

- **Insufficient funds.** The most common soft decline. A retry later may work.
- **Do not honour.** A generic refusal. The issuer will not say why. Treat it as hard.
- **Suspected fraud.** The issuer's models flagged the payment. Authentication with 3-D Secure often turns these into approvals.
- **Wrong details.** A mistyped number, expiry or security code.
- **Technical.** Timeouts and issuer outages. These are the only ones worth retrying at once, and only after checking the first attempt did not succeed.

## What a merchant can change

1. Send complete data: billing address, email and device information improve issuer confidence.
2. Authenticate when it is cheap to do so. A frictionless 3-D Secure flow shifts liability and lifts approval rates.
3. Show clear messages. "Try another card" converts better than a code.
4. Do not hammer a hard decline. Repeated attempts look like card testing.

You can try each of these outcomes with the test cards in the [Payment Labs](/labs).` },
  { slug: "reading-a-settlement-report", title: "Reading a settlement report without fear", published_at: "2026-10-25T09:00:00Z", tags: ["settlement", "finance"], summary: "Payouts rarely match sales. Here is how to walk from one to the other.",
    markdown: `## Why the numbers differ

A payout is a net amount. Starting from the gross sales in the batch you subtract refunds, chargebacks, fees and any reserve, and you add reversals and fee credits.

## A method that works

1. Check the batch cut-off. Sales after the cut-off belong to the next batch.
2. Sum approved captures. Ignore authorisations that were never captured.
3. Subtract refunds, in the batch where they settled, not where the sale was.
4. Subtract disputes at the time the money was withdrawn.
5. Subtract fees. Under blended pricing this is one line; under interchange++ it splits into interchange, scheme fee and markup.
6. Compare with the bank credit. A difference left over is a question for the acquirer.

Practise on a generated report in the Academy course on [clearing, settlement and reconciliation](/academy/settlement).` },
  { slug: "chip-cards-and-cryptograms", title: "How a chip card proves it is real", published_at: "2026-10-18T09:00:00Z", tags: ["emv", "card-present"], summary: "A plain-language walk through the chip's cryptogram and why copying the number is not enough.",
    markdown: `## The problem with the stripe

The magnetic stripe stores the same data on every swipe. Copy it and you have the card.

## What the chip does instead

At each transaction the terminal sends the chip the amount, currency, date and a random number. The chip adds its own transaction counter and signs the lot with a secret key that never leaves the chip. The result is the **cryptogram**.

The issuer holds the same key, computes the expected cryptogram, and compares. If the amount was changed, the data replayed, or the card cloned, the values differ and the payment is declined.

## What this does not stop

Chip security protects card-present payments. Online, the card number alone is still used, which is why 3-D Secure exists. Lost and stolen cards are handled with PINs and blocking.

See it work, and watch it fail when a bit is flipped, in the [EMV lab](/labs) and in the Academy course on [chip, stripe, POS and ATM](/academy/card-present).` },
];
