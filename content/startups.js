"use strict";
// Startup Hub content: a launch roadmap and practical guides. General education only, not legal or financial advice.
const I = (id, text, link) => ({ id, text, link: link || null });
const ROADMAP = [
  { id: "validate", title: "1. Validate the problem", items: [
    I("v-problem", "Write the problem in one sentence and name who has it."),
    I("v-interviews", "Talk to at least ten people who have the problem and write down what they do today."),
    I("v-money", "Find out who pays, how much, and how often (merchants, consumers, or a partner)."),
    I("v-rival", "List the three closest alternatives and why customers would switch."),
  ] },
  { id: "model", title: "2. Choose the model", items: [
    I("m-role", "Decide your role in the payment chain: software on top of a provider, a payment facilitator, or a regulated institution.", "/startups/guides/regulatory-routes"),
    I("m-rev", "Pick how you earn: subscription, per-transaction fee, interchange share, or float.", "/startups/guides/unit-economics"),
    I("m-flows", "Draw the flow of money and data for one transaction from start to payout.", "/knowledge/payment-lifecycle"),
  ] },
  { id: "prototype", title: "3. Prototype", items: [
    I("p-sandbox", "Prototype your checkout or flow against the sandbox.", "/labs"),
    I("p-edge", "Test declines, 3-D Secure, refunds and disputes, not only the happy path.", "/academy/card-payments"),
    I("p-webhooks", "Handle webhooks with retries and idempotency.", "/knowledge/webhooks"),
  ] },
  { id: "compliance", title: "4. Compliance and partners", items: [
    I("c-route", "Confirm with a qualified lawyer which licence or registration, if any, your model needs in each country.", "/startups/guides/regulatory-routes"),
    I("c-pci", "Decide how you avoid handling raw card data, and what PCI DSS level or questionnaire applies.", "/startups/guides/compliance-basics"),
    I("c-aml", "Plan customer checks (KYC/KYB), sanctions screening and transaction monitoring.", "/startups/guides/compliance-basics"),
    I("c-provider", "Shortlist two acquirers or payment providers and compare fees, payout timing, and risk policies.", "/startups/guides/choosing-providers"),
    I("c-terms", "Prepare terms, privacy notice, refund policy and a complaints process.", null),
  ] },
  { id: "launch", title: "5. Launch", items: [
    I("l-pilot", "Run a small pilot with real but limited volume."),
    I("l-recon", "Reconcile pilot payouts against your records to the cent.", "/academy/settlement"),
    I("l-monitor", "Set alerts for approval rate, dispute ratio, refunds and failed webhooks."),
    I("l-support", "Publish a support route and a way to report fraud."),
  ] },
  { id: "grow", title: "6. Grow", items: [
    I("g-costs", "Review fees and routing every quarter.", "/startups/guides/unit-economics"),
    I("g-risk", "Review fraud and dispute trends and tighten rules.", "/academy/disputes"),
    I("g-sca", "Review how you handle strong authentication and exemptions.", "/academy/three-d-secure"),
  ] },
];
const GUIDES = [
  { slug: "regulatory-routes", title: "Regulatory routes: licence, agent or partner", summary: "The three common ways a payments startup operates, and what each means.",
    markdown: `> This is general education, not legal advice. Rules differ by country and change. Ask a qualified lawyer before you decide.

## Three common routes

1. **Build on a licensed provider.** You sell software and your provider (a payment institution, e-money institution or bank) holds the licence and the customer funds. This is the fastest way to start and the usual one for startups.
2. **Become a payment facilitator or marketplace operator.** You onboard sub-merchants under a provider's licence. You take on risk for them and must follow the provider's programme rules.
3. **Get your own licence.** You are regulated directly. Expect capital requirements, safeguarding of customer funds, governance, reporting and months of authority review.

## Questions that decide it

- Do you hold customer money, even briefly?
- Do you initiate payments for others, or only show data?
- Do you move money between parties you do not own?
- In which countries are your users?

If the answer to the first three is no, route 1 is often enough. If yes, expect more regulation.

## Next

Use the [launch roadmap](/startups) and take the compliance step with a professional.` },
  { slug: "compliance-basics", title: "Compliance basics: PCI, SCA and AML", summary: "What each acronym asks of you, in plain language.",
    markdown: `> General education, not legal advice.

## PCI DSS: protecting card data

The card schemes require anyone who stores, processes or transmits card data to follow PCI DSS. The simplest way to reduce scope is to **never touch the card number**: let a provider's hosted fields or checkout collect it and give you a token.

## SCA: strong customer authentication

In Europe and the UK, most online card payments need two of three factors. 3-D Secure is how merchants do it. Exemptions exist for low value, trusted beneficiaries, recurring payments and low risk, but the issuer can still ask for a challenge. See [3-D Secure and strong authentication](/academy/three-d-secure).

## AML and KYC

Regulated firms must know their customers (KYC), check businesses (KYB), screen against sanctions lists, monitor transactions and report suspicious activity. If you operate under a provider, they will push parts of this to you in your contract. Read it.

## Data protection

Card, identity and transaction data is personal data. Keep what you need, secure it, and write a clear privacy notice.` },
  { slug: "unit-economics", title: "Unit economics of a card payment", summary: "Where the fee goes and how to check a payments business actually earns money.",
    markdown: `## One payment, one split

On a 100.00 card sale the merchant might pay 1.5 to 2.9 percent plus a fixed fee. That is split into **interchange** (to the issuer), **scheme fees** (to the network) and the **acquirer or provider margin**. A startup that sits on top of a provider usually earns a share of the last part, or charges a subscription.

## The numbers to track

- **Take rate**: revenue as a share of volume.
- **Cost per transaction**: fees you pay, fraud losses, chargeback handling, support.
- **Approval rate**: every point of decline you cut is revenue.
- **Dispute ratio**: too many and the provider reviews or ends the relationship.
- **Payout delay**: slow settlement means you finance the gap.

## A quick test

Margin per payment = revenue per payment minus all costs per payment. If it is negative at small ticket sizes, a fixed fee is probably missing. Try the [interchange fee report](/labs) to see how card mix changes the cost.` },
  { slug: "choosing-providers", title: "Choosing a payment provider", summary: "A checklist for comparing acquirers and payment service providers.",
    markdown: `## Compare these, in writing

- **Pricing model**: blended or interchange++, fixed fees, refund and dispute fees, minimums.
- **Settlement**: payout schedule, rolling reserve, currencies.
- **Risk policy**: prohibited businesses, review triggers, dispute thresholds.
- **Coverage**: countries, card schemes and local methods.
- **Product**: API quality, sandbox, webhooks, reporting, 3-D Secure options, tokens.
- **Support**: who answers when payouts stop.
- **Exit**: can you export tokens and move away?

## Practical tips

Build against the sandbox first and test the awkward cases. Ask each provider to explain a sample payout line by line. Keep the integration behind your own small interface so switching later is possible.` },
];
module.exports = { ROADMAP, GUIDES, itemIds: ROADMAP.flatMap((s) => s.items.map((i) => i.id)) };
