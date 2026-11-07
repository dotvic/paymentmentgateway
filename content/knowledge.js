"use strict";
// Knowledge Centre pages: hand-written guides plus reference pages generated from the code and the README.
const fs = require("fs"), path = require("path");
const SCH = require("../schemes"), GLOSS = require("../glossary"), TERMS = require("./glossary-terms");

const readme = (() => { try { return fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8"); } catch { return ""; } })();
function section(title) {
  const re = new RegExp("^## " + title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ".*$", "m"), m = re.exec(readme);
  if (!m) return null;
  const rest = readme.slice(m.index + m[0].length), n = rest.search(/^## /m);
  return (n < 0 ? rest : rest.slice(0, n)).trim().replace(/^### /gm, "### ");
}
const host = "https://zanboxx.com";
const fromReadme = (slug, title, category, summary, heading) => { const b = section(heading); return b ? { slug, title, category, summary, markdown: b.replace(/\$HOST/g, host) } : null; };

const pages = [
  { slug: "getting-started", title: "Getting started", category: "Start here", summary: "Make your first test payment in five minutes.", markdown: `Zanboxx is a sandbox: payments here use **test cards** and fictional money. Nothing you do here moves real money.

## 1. Get a key

Open [Payment Labs](/labs) and press the button to create an account. You get an API key that starts with \`sk_test_\`. It is shown once, so store it. Confirming an email address later lets you sign in again and starts a 14-day trial of Pro features.

## 2. Create a payment

\`\`\`bash
curl -X POST ${host}/v1/payments \\
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \\
  -d '{"request_id":"order-1001","method":"card","transaction_type":"purchase","amount":49.90,"currency":"EUR","card_number":"4111111111111111"}'
\`\`\`

The card number decides the outcome. \`4111111111111111\` is approved, \`4000000000000002\` is declined. See [Test cards](/knowledge/test-cards) for the full list.

## 3. Follow up

Refund, capture or void it with the same endpoint and a \`parent_transaction_id\`. Register a webhook with \`PUT /v1/webhook\` to receive signed events.

## Where next

- Try the [labs](/labs) in a browser, or read the [Payment lifecycle](/knowledge/payment-lifecycle).
- Take the [Card payments fundamentals](/academy/card-payments) course.
- Connect an AI assistant with the [MCP server](/knowledge/mcp-server).` },
  { slug: "payment-lifecycle", title: "The payment lifecycle", category: "Concepts", summary: "Authorise, capture, clear, settle: what happens to a card payment, and who gets what.", markdown: `A card payment looks instant, but it is several steps between four parties: the **cardholder**, the **merchant**, the merchant's bank (the **acquirer**) and the cardholder's bank (the **issuer**), connected by a **card scheme**.

## The steps

1. **Authorisation.** The merchant asks if the payment is allowed. The issuer checks the card, the balance and fraud signals, then approves or declines. If it approves, the amount is held.
2. **Capture.** The merchant asks to collect the held money. A shop that ships goods later authorises first and captures when it ships. A *purchase* does both at once.
3. **Clearing.** The acquirer sends the day's captured transactions to the scheme, which passes them to the issuers.
4. **Settlement.** The banks net out what they owe each other and money moves. The acquirer then pays the merchant, usually less fees.
5. **Afterwards.** A merchant can **void** a payment before it clears, or **refund** it after. A cardholder can **dispute** it with their bank, which starts a chargeback.

## Who gets what

On a 100.00 payment the merchant does not receive 100.00. The issuer takes **interchange**, the scheme takes a **scheme fee**, and the acquirer keeps a **markup**. The Zanboxx [interchange report](/knowledge/clearing-settlement-and-payouts) shows the split for your own test payments.

## Why it matters when you build

- Treat *authorised* and *captured* as different states.
- Send an idempotency key (\`request_id\`) so a retry cannot charge twice.
- Do not assume a timeout means failure: ask for the status, or wait for the webhook.
- Reconcile your records with the settlement report, because the two will disagree sometimes.` },
  { slug: "authentication-and-limits", title: "Authentication, plans and limits", category: "Reference", summary: "How to send your key, rate limits, monthly quotas and error format.", markdown: `## Authentication

Send your key as \`Authorization: Bearer sk_test_...\`. Keys belong to one account. Rotating a key makes the old one stop working at once. Never put a key in browser code, a public repository or a screenshot.

## Plans and limits

| | Free | Pro and trial |
| --- | --- | --- |
| Payments per month | 200 | 20,000 |
| Requests per minute | 30 | 300 |
| Failure scripting, webhook replay | no | yes |
| Tutor questions per day | 10 | 100 |

Past a limit you get \`429\` with a message that says which one. Limits reset every minute and every month.

## Errors

Every error has the same shape:

\`\`\`json
{ "error": { "code": "invalid_request", "message": "amount must be greater than 0" } }
\`\`\`

\`code\` is stable and for programs. \`message\` is for people. Payment outcomes use \`SBX-xxxx\` status codes, listed in [Status codes](/knowledge/status-codes).

## Test data only

Zanboxx refuses card numbers that look real. Use the [test cards](/knowledge/test-cards).` },
  fromReadme("scenarios", "Scenarios and the auto outcome", "Reference", "How the card number picks the outcome.", "Test cards (scenario `auto`)"),
  fromReadme("clearing-settlement-and-payouts", "Clearing, settlement and payouts", "Guides", "Close the day, read the files, reconcile, and see where the fees go.", "Clearing, settlement and payouts"),
  fromReadme("card-on-file", "Card on file and merchant-initiated payments", "Guides", "Store a card once and charge it later the way subscriptions do.", "Card on file and merchant-initiated payments (MIT)"),
  fromReadme("disputes", "Disputes (chargebacks)", "Guides", "Raise a dispute, send evidence, win or lose.", "Disputes (chargebacks)"),
  fromReadme("card-present", "POS and ATM labs (EMV, stripe)", "Guides", "Chip, contactless and stripe transactions, POS and ATM types.", "POS and ATM labs (EMV chip, contactless, magnetic stripe)"),
  fromReadme("mcp-server", "MCP server", "Guides", "Drive the sandbox from an AI assistant.", "MCP server (use Zanboxx from an AI assistant)"),
  { slug: "ai-tutor", title: "AI tutor", category: "Guides", summary: "Ask questions about your own test payments.", markdown: `The tutor panel in [Payment Labs](/labs) answers questions about a payment you pick: why it was declined, what a 3-D Secure outcome means, how a dispute works. It reads that payment, its 3-D Secure steps and its dispute, never a card number (none is stored), and it only talks about payments.

## Limits and safety

- 10 questions a day on Free, 100 on Pro and trial. A failed answer is not counted.
- If you type something that looks like a real card number, the question is refused before anything is sent.
- Questions and the selected payment's data are sent to an AI provider (Anthropic) to produce the answer. Do not type personal data.
- The tutor can be wrong. Check what it says against the [glossary](/knowledge/glossary) and the [status codes](/knowledge/status-codes).

## API

\`POST /v1/tutor\` with \`{"question": "...", "transaction_id": "tx_...", "history": []}\`. \`GET /v1/tutor\` shows whether it is switched on and how many questions you have left today.` },
  fromReadme("webhooks", "Webhooks", "Guides", "Signed events, retries, the delivery inspector and replay.", "Webhooks"),
  fromReadme("endpoints", "Endpoint reference", "Reference", "Every endpoint in one table.", "Endpoints"),
].filter(Boolean);

// Generated pages
pages.push({ slug: "risk-and-fraud", title: "Risk scoring and fraud controls", category: "Concepts", summary: "How a risk score, thresholds and rules work together, and what the trade-offs cost.", markdown: `A payment risk system answers one question quickly: **approve, ask for more, or decline?** It has to stop fraud without turning away good customers.

## Score first, then decide

A **risk score** combines signals such as the amount compared with the customer's usual, whether the device is known, the country, how many payments happened in the last hour, how old the account is, and whether the customer passed strong authentication. A higher number means more risk.

A score is not a yes or no. Because risk is continuous, each business draws its own lines:

| Score | Typical action |
|---|---|
| Low | Approve without friction |
| Middle | Step-up authentication or manual review |
| High | Decline |

## Rules on top

**Rules** are explicit conditions, such as "more than five payments in an hour: review". They are easy to explain and to change quickly when a new attack appears. Models see patterns that rules miss, and rules cover cases where you know the answer. Most systems use both.

## The trade-off

Every setting has a cost on both sides:

- **False negatives** let fraud through: lost goods plus chargebacks and fees.
- **False positives** decline good customers: lost sales, and customers who may not come back.
- **Manual review** is accurate but costs time per case.

The right thresholds depend on your margins, average basket and how much fraud you face. Fixed thresholds also go stale: fraud patterns and customer behaviour change, so the numbers must be monitored and recalibrated.

## Signals are not proof

Location, device and time are hints. A holiday looks like fraud to a naive rule, and a determined criminal on a known device can look perfectly normal. Use several signals, and keep a path for the customer to prove who they are.

## Try it

The [risk engine lab](/labs/risk) lets you tune thresholds and rules on a practice set and see the cost. The [KPI page](/labs/kpis) shows approval and decline rates for your own payments. The [fraud and risk course](/academy/fraud-and-risk) walks through it.` });

pages.push({ slug: "idempotency-and-retries", title: "Idempotency and safe retries", category: "Guides", summary: "Why a timeout must never lead to a second charge, and how idempotency keys prevent it.", markdown: `## The problem

You send a payment request and the connection drops. Did the payment happen? You cannot tell. If you simply send it again, the customer may be charged twice. If you do nothing, an order may go unpaid.

## The fix: an idempotency key

Send a unique value in an \`Idempotency-Key\` header with every request that changes something. The server remembers the key and the result:

1. First request with the key: do the work, store the result.
2. Same key, same request: return the stored result and do nothing again.
3. Same key, **different** request: refuse it. It is almost certainly a bug.

\`\`\`
POST /v1/cards/crd_.../authorize
Idempotency-Key: order-1042-attempt-1
\`\`\`

## Rules of thumb

- Generate the key once per **intent** (one order, one payout), not once per attempt.
- Reuse the **same** key and the **same** body when you retry.
- Keep keys for a limited time: here 24 hours.
- Read-only requests (GET) do not need one.
- Some operations are idempotent by nature: setting a card to frozen twice leaves it frozen.

## Timeouts

A timeout means **unknown**, not failed. The safe order is:

1. Retry with the same key, or
2. Look the payment up by your own reference, or wait for the webhook,
3. Only then decide to start a new payment with a new key.

## Related protections

Webhooks need **replay protection** (a timestamp in the signature, and storing event IDs you have processed). APIs need **rate limiting** so that retries do not become a flood: wait longer between each retry. Keep an **audit log** so you can show what happened.

## Try it

In the [card controls and idempotency lab](/labs/controls), tick "simulate a timeout", authorize, then press the button again, with and without the key.` });

pages.push({ slug: "tokenization", title: "Tokenization", category: "Concepts", summary: "How tokens replace card numbers, what a token lifecycle looks like, and why a stolen token is worth less.", markdown: `## The problem with card numbers

A card number (the **PAN**) works anywhere. If a merchant stores it and is breached, every stolen number can be used elsewhere. Storing card numbers also puts the merchant under heavy security rules (PCI DSS).

## What a token does

A **token** is a stand-in value. The merchant or wallet keeps the token, and the real number stays in one protected place. Two common kinds:

| Kind | Issued by | Works with |
|---|---|---|
| Gateway (vault) token | Your payment provider | That provider only |
| Network token | The card network, through the issuer | Across the network, within its domain |

## Network token controls

- **Requestor**: the wallet or merchant that asked for it. The token is bound to it.
- **Domain**: where it may be used, such as one merchant or only online.
- **Cryptogram**: each payment carries a one-time value. A recorded payment cannot be replayed.
- **Lifecycle**: it is provisioned, activated after identity checks, can be suspended and resumed, and deleted, all without cancelling the card.
- **Card updates**: when the card is reissued or expires, the issuer updates the token behind the scenes. The merchant does not need new details, which is why network tokens often raise approval rates.

## What tokens do not do

A token does not authenticate the customer. It also moves trust to whoever runs the token service. Fraudsters still try to get tokens provisioned onto their own devices, so provisioning needs strong identity checks.

## Try it

The [tokenization lab](/labs/tokens) simulates provisioning, activation, domain checks, cryptograms, suspension and a card reissue, with test cards only. The [tokenization course](/academy/tokenization) walks through it.` });

pages.push({ slug: "agentic-payments", title: "Agentic payments and AI controls", category: "Concepts", summary: "What changes when software buys on a person's behalf, and the controls that keep it safe.", markdown: `## From assistant to agent

A chatbot answers. An **agent** acts: it searches, compares, decides and, with the right access, pays. That changes the question from "can we move the money?" to "can software move money for a person while identity, intent, limits and accountability stay intact?"

## What a payment system must know

| Question | Control |
|---|---|
| Who is the customer? | Normal authentication of the account holder |
| Which agent is acting? | A separate credential for each agent, never the person's own key |
| What was it asked to do? | The stated intent, kept in the audit trail |
| What may it buy? | An allow-list of merchants or categories |
| How much? | A per-purchase limit and a total budget |
| For how long? | An expiry, and revocation at any time |
| When must a person agree? | A confirmation rule above a set amount |
| Can we prove what happened? | An audit log of every request and decision |

Together these make a **mandate**.

## Enforce outside the model

Language models can be wrong, and can be tricked by text in a web page or email (**prompt injection**). Asking the model to behave is not a control. The limits must live in the payment system, so a confused or compromised agent hits the same wall. Agents also retry, so every request should carry a unique ID that makes a repeat harmless (see [idempotency](/knowledge/idempotency-and-retries)).

## Human in the loop

Small, routine purchases can run on their own. Larger or unusual ones should pause for approval. The person should see the merchant, the amount and the reason before they decide.

## AI elsewhere in payments

AI also helps with fraud scoring ([risk scoring](/knowledge/risk-and-fraud)), routing, reconciliation and support. Grounding answers in real data and documents (**RAG**) reduces made-up answers. Whatever the use, keep a person responsible, log decisions, and measure the model: precision and recall, false positives, drift and, for text models, how often they are wrong.

## Try it

The [agent payments lab](/labs/agents) lets you give a simulated agent a mandate and try to make it overspend. The [AI in payments course](/academy/ai-in-payments) covers the rest.` });

pages.push({ slug: "test-cards", title: "Test cards", category: "Reference", summary: "Every test card for Visa, Mastercard and American Express, and what each one does.",
  markdown: "Use these numbers with any future expiry. Visa and Mastercard use a 3-digit security code, American Express a 4-digit one. The PIN for card-present tests is `1234`. Real card numbers are always refused.\n\n" +
    Object.values(SCH.SCHEMES).map((s) => `## ${s.name}\n\n${s.note}\n\n| Number | What it does |\n| --- | --- |\n` + SCH.TEST_CARDS.filter((c) => c.scheme === s.id).map((c) => `| \`${c.number}\` | ${c.label} |`).join("\n")).join("\n\n") });
const codeRows = Object.entries(GLOSS).map(([k, v]) => `| \`${k}\` | ${v} |`).join("\n");
pages.push({ slug: "status-codes", title: "Status and response codes", category: "Reference", summary: "What every SBX status code, 3-D Secure status and card-present response code means.",
  markdown: "Payment results carry a status `code` and `message`. Scheme response codes differ by scheme:\n\n## Zanboxx codes\n\n| Code | Meaning |\n| --- | --- |\n" + codeRows + "\n\n## Scheme response codes\n\n| Scheme | Decline | Insufficient funds | Expired | Invalid card |\n| --- | --- | --- | --- | --- |\n" +
    Object.values(SCH.SCHEMES).map((s) => `| ${s.name} | ${s.responses.decline.code} ${s.responses.decline.message} | ${s.responses.nsf.code} | ${s.responses.expired.code} | ${s.responses.invalid_card.code} |`).join("\n") });
pages.push({ slug: "glossary", title: "Glossary", category: "Reference", summary: `${TERMS.length} payments terms in plain language.`,
  markdown: TERMS.slice().sort((a, b) => a[0].localeCompare(b[0])).map(([t, d]) => `### ${t}\n\n${d}`).join("\n\n") });

pages.push({ slug: "pos-acquiring-and-certification", title: "POS acquiring and certification", category: "Concepts", summary: "How a payment terminal gets approved to work with an acquirer: host certification, Level 1, 2 and 3, test accounts, keys, logs and when to certify again.", markdown: `## Why terminals are certified

A terminal is not just a screen with a card reader. It builds a message, signs it, sends it through an acquirer and a card scheme to an issuer, and must act correctly on the answer. If it fills one field wrongly, the payment can fail, be priced wrongly or shift liability. So every acquirer and card scheme tests terminals before they go live, and tests them again when something important changes.

## The three kinds of approval

**Acquirer host certification** checks the interface between the acquirer and a card scheme: that the acquirer's systems build and read the scheme's messages correctly. The messages follow the ISO 8583 style: a message type, a bitmap and numbered *data elements* such as DE4 (amount) or DE22 (how the card was read). Host certification is needed when the acquirer adds something new, such as a new transaction type or a new scheme.

**Level 1 and Level 2** approve the terminal itself. Level 1 covers the hardware and the low-level communication with the card. Level 2 covers the payment kernel, the software that runs the card conversation. An accredited laboratory performs them once per terminal model and kernel, and a letter of approval is issued. For contactless there is one approval per scheme's kernel.

**Level 3** checks one deployment: this terminal, configured this way, connected to this acquirer, for this scheme. It can only be requested for a terminal that already has Level 1 and 2. It is repeated for every scheme and every terminal model.

## How a Level 3 test is done

A test tool plays the card, and a simulator plays the scheme and issuer. The tester runs scripted test cases on the real terminal. Two logs come out: the **card-terminal log** (what the card and terminal said to each other, including chip tags) and the **network log** (what the acquirer and scheme saw). The checker compares them. Typical findings: the amount in DE4 differs from the amount the card approved, the point-of-sale entry mode in DE22 does not match how the card was read, chip data is missing, or a terminal that lost the answer never sent a reversal.

Which test cases apply depends on the terminal type, its capabilities (chip, contactless, PIN types, cashback, refunds), the merchant category, and the country. A mobile POS has different cases from an ATM.

## Setting up the test

The acquirer issues a test merchant ID and terminal ID, a profile that describes the terminal's capabilities, and a connection (an address and port, often with a VPN or TLS). If the terminal does online PIN or message authentication, the two sides exchange keys in a **key ceremony**: each custodian gets one *component* and a *check value*, enters it separately, and the system combines them inside a hardware security module. The check value catches typing mistakes. Test and production use separate ceremonies, so a test key never protects live traffic.

## When to certify again

Typically when you launch a deployment for a scheme for the first time, make a major upgrade that changes the payment flow or adds a function such as cashback or refunds, change how the terminal's messages map to the acquirer host, put a new system between the terminal and acquirer, or move to new hardware. Cosmetic changes outside the payment flow do not need it.

## Timing

Implementation and testing happen once and depend on the merchant. Level 3 takes roughly two weeks per test iteration plus one to two weeks of review, for each scheme and each terminal model. Running a pre-certification first, with the same test cases, helps pass in one iteration.

## Practise it

The [POS acquiring and certification lab](/labs/acquiring) lets you scope a project, run a key ceremony, set the terminal profile, find mismatches between the logs, and answer recertification scenarios. Everything is simulated with made-up keys and simplified rules. The [course](/academy/pos-acquiring) adds a quiz and a certificate of completion.` });

pages.push({ slug: "ecommerce-fraud-schemes", title: "E-commerce fraud schemes and the checks that catch them", category: "Concepts", summary: "Nine common online fraud schemes, the checks that help (address, security code, 3-D Secure, your own lists) and why one check is never enough.", markdown: `When the card is not in the shop, an approval only tells you the account had funds and was not reported stolen. It does not prove the real cardholder is buying. In card-not-present sales the merchant usually carries the loss for fraud the issuer approved, which is why checks at your end matter.

## Nine schemes worth knowing

- **Clean fraud.** Everything checks out: valid details, matching address, correct code, a plausible location. The most dangerous kind, because your usual rules pass it.
- **Account takeover.** A criminal gets into a real customer's account, changes the email or address and buys. Watch changes to contact details followed quickly by orders.
- **Friendly fraud.** The cardholder (or a relative) disputes a purchase that was in fact delivered. Defence is evidence, not a stricter checkout.
- **Identity theft.** Someone uses stolen personal data to open accounts and buy.
- **Affiliate fraud.** Fake leads or inflated traffic to collect referral payouts.
- **Re-shipping.** A recruited person receives goods bought with stolen cards and forwards them. The delivery address looks innocent.
- **Botnets.** Infected machines make the order look as if it comes from near the cardholder, so a simple location match is fooled.
- **Phishing, pharming and whaling.** Fake messages or redirected sites steal credentials; whaling targets specific staff with tailored messages.
- **Triangulation.** The fraudster sells cheap goods to a real buyer, then orders from a genuine shop with a stolen card. Both sides look innocent, and the fraudster collects the buyer's card details too.

## The checks, and what each one really tells you

- **Address verification (AVS).** The issuer compares the billing address you send with its records and returns a result code **separate** from the approve or decline. Exact match: proceed. Partial match (street or postal code only): look closer, since the customer may have moved or typed it in another format. No match: investigate before shipping. Unavailable: treat it as unknown, not as bad. **An issuer decline always wins**: never accept a declined payment because the address matched. It only works for cards from some countries.
- **Security code (CVV).** Proves someone has the card details in front of them. A no-match is a signal to weigh with others (it can be a typo, so allow one re-entry), not an automatic decline. Never store it after authorisation.
- **3-D Secure.** Authenticates the cardholder. A fully authenticated payment shifts fraud liability to the issuer. An attempted authentication gives less protection, and a failed one should not be sent for authorisation. It does not stop account takeover or friendly fraud, so keep screening.
- **Your own lists.** A **negative file** of details from confirmed fraud (emails, addresses, devices) and a **positive file** of trusted repeat customers. Put only confirmed fraud in the negative file, not every disputed order, and have a way to remove an innocent victim whose details were misused.
- **Velocity.** Limits on how many orders, cards and amounts one card, address, phone, email, device or network address can produce in a period. Tighter for new customers, looser for proven ones.
- **Input hygiene.** Run the card-number check (Luhn) before asking the issuer, to catch typos. Do not pre-fill the expiry date. Show returning customers only the last four digits.

## Signals that deserve a second look

Larger-than-usual orders; many of the same item; rush shipping; shipping outside your country; billing and shipping that differ (especially on high-value goods); several different cards from one network address; one card with several shipping addresses; a very short time between attempts on one card; free-mail addresses with no history; network country that differs from billing country. None is proof. Each adds weight, which is exactly what a risk score does. Try it in the [risk lab](/labs/risk).

## Order of checks

1. Authenticate (3-D Secure) where it applies.
2. Your own screening: negative file, velocity, high-risk locations. Stop or send to review here.
3. Authorise with address and security code, and read the results.
4. Only then pay for an outside fraud score, and only on payments still undecided. Scoring every tiny, low-risk order costs more than the fraud it prevents.
5. Review the suspicious ones by contacting the cardholder with a number you looked up yourself, never the one on the order.

## Measure it

Track gross fraud as a share of sales, recoveries as a share of gross fraud, how fast you review flagged orders, and complaints from good customers. The aim is less fraud with the least harm to good sales. Related: [Risk scoring and fraud controls](/knowledge/risk-and-fraud), [Chargeback defence and evidence](/knowledge/chargeback-defence-and-evidence).` });
pages.push({ slug: "chargeback-defence-and-evidence", title: "Chargeback defence and evidence", category: "Concepts", summary: "How to avoid chargebacks, answer copy requests, assemble compelling evidence, and monitor rates, plus authorisation, delivery and recurring-billing rules that cause them.", markdown: `A chargeback takes back the sale amount and adds your own handling cost. Most are avoidable, and many that are not can be won with the right evidence. The full liability for a chargeback sits in your merchant agreement, so read it.

## Why they happen

Customer disputes, fraud, processing errors and authorisation problems. Many come from avoidable mistakes: charging before shipping, double billing, an unrecognisable name on the statement, an unclear refund policy, slow replies.

## Prevent

- **Say it clearly at checkout.** Product description, total price including shipping and tax, the currency, delivery time, refund policy, and who will appear on the statement. If you use a billing provider, tell customers the name they will see.
- **Currency conversion.** If you offer paying in the customer's currency, they must actively choose it after seeing the rate and fee. Never make it the default.
- **Confirm orders** by email within a business day and warn about delays. Keep stock information honest.
- **Make contact easy.** A visible email and phone number, and response targets you monitor. Most customers who can reach you ask for a refund instead of a dispute.
- **Refund quickly** when a customer is right. A prompt credit is cheaper than a dispute.
- **Test your fulfilment** with your own orders: time from order to billing, and from return to credit. Delays create disputes.
- **Prevent duplicates**: require a positive click, show an "order being processed" message, and flag identical orders placed close together.
- **Do not repeat a hard decline.** Ask for another payment method. Hard declines such as lost or stolen must never be retried; soft ones may be retried a limited number of times if worthwhile.

## Authorisations and shipping

The shipping date counts as the transaction date for goods. An approval is valid for a limited time, so if you ship well after approval (a backorder, say), get a new one first. For delayed delivery, authorise the deposit and the balance separately. For split shipments, make sure the later authorisations still carry the authentication result, or the fraud protection can be lost. Deposit sales only for your own business.

## Recurring billing

Get and keep the cardholder's consent: the amount (or its range), how often, and for how long. Warn customers ahead of any charge outside the agreed range. Offer easy cancellation, check cancellation and complaint logs daily, and refund promptly when a cancellation arrives too late. Mark recurring payments as such so issuers see them correctly. For digital services, do not bill free-trial users who never used the service, and avoid renewal tricks that make "free" look free. Keep stored card details fresh with an account-updater service, and never store the security code.

## Respond to copy requests

When an issuer asks for proof of a sale, answer fully and quickly. An unanswered or illegible request almost always becomes a chargeback. Include: card number (as allowed), expiry, cardholder name, date, amount, authorisation code, your name and web address, a description of the goods, the shipping address and the address-check result. Helpful extras: time, email, phone, a detailed description, and whether a signature was obtained on delivery.

## Compelling evidence

For fraud and not-received disputes you can show that the cardholder took part or benefited:

- Goods collected in person: signature, copy of the identification shown.
- Goods delivered: proof of delivery and time to the **same physical address** that matched the address check. A signature is not always required.
- Digital goods: the buyer's network address and email, a description of what was downloaded, the date and time, and proof the account was used after the transaction date.
- Earlier undisputed orders that used the same network address, email, phone or physical address.
- The cardholder later acknowledged the purchase, by phone or in writing.
- You requested the address check or security-code check and the issuer returned "unavailable": the issuer's own gap can shift responsibility back.

Practise assembling evidence in the dispute lab: pick evidence that fits the category and see how it changes the outcome.

## Recover and monitor

Contact customers who truly received goods and keep the chargeback, politely first by email, then phone, then a collections agency for larger amounts. Track chargebacks **by reason**, show gross and **net after representment**, and track card-present and card-absent separately, and web separately from phone and mail. Card schemes watch merchant dispute and fraud ratios monthly; too high and your acquirer will ask for a reduction plan, and in the worst case you can lose protections or be placed in a higher-risk programme. Related: [Payment lifecycle](/knowledge/payment-lifecycle), [E-commerce fraud schemes](/knowledge/ecommerce-fraud-schemes).` });

pages.push({ slug: "wallet-provisioning-issuer-view", title: "Wallet provisioning and tokens: the issuer's view", category: "Concepts", summary: "What happens when a card is added to a phone wallet, how the issuer decides, and what it sees when the token is used.", markdown: `Adding a card to a phone or watch wallet involves four parties: the **cardholder**, the **wallet provider**, a **token service** run by the card network, and the **issuer**. This guide follows the flow from the issuer's side. The merchant and wallet side is in [Tokenization](/knowledge/tokenization).

## Two numbers

- The **funding account number** (FPAN) is the real card number.
- The **device account number** (DPAN, the token) replaces it. It lives in the token service's vault and on the device or a secure server. It is specific to that device, works only for wallet payments, matches the card's type, billing country, currency and issuer, comes from its own reserved number ranges and expires after a set period (often years, and the limit varies by service).

**Tokenization** is swapping the number. **Digitization** is delivering the tokenized card to the device. Because merchants and acquirers only ever see the token, a breach on their side exposes numbers that are useless elsewhere. Only the network turns the token back into the real number for the issuer.

## Step 1: the eligibility decision

The issuer is asked whether this card may be added. It receives the real card number and expiry, the wallet and device type, the security code and address the customer typed, and the wallet provider's own risk recommendation: device score, account score, device location, device network address, reason codes and how many tokens already exist for the card. It answers with one of three decisions:

- **Green path: approve.** The token is created at once.
- **Yellow path: approve, but verify first.** The issuer proves it is the real cardholder before activation.
- **Red path: decline.**

Good practice: one weak signal alone usually means verify, not refuse. Several signals that agree (new device, far from the cardholder, wrong code and address, many tokens) mean decline. Try the decisions in the [issuer lab](/labs/issuer).

## Step 2: the activation code

On the yellow path the issuer chooses how the cardholder gets a one-time code: a masked mobile number, a masked email, an automated or voice call, the call centre, a website or the banking app. Use a contact you already hold, never one typed into the request. A method chosen in the reply overrides any default set up for the card range. Limit the attempts: after too many wrong or expired codes the token is deactivated and the customer starts again.

## Step 3: notifications

The issuer is told when the code is delivered, when the token's state changes (suspended, resumed, deactivated, or an exception such as retries exceeded, expired code or a wrong code), and when tokenization completes, which includes the token, its expiry and the final decision (green or yellow). The issuer must reply, but the reply does not change the outcome.

## At payment time

1. The acquirer sends the token, its expiry, how the card was read and, for chip payments, the chip data.
2. The token service maps the token to the real number, checks the token's expiry, checks the transaction counter and validates the cryptogram (or the dynamic code for stripe-style contactless). The chip data is not forwarded.
3. The issuer receives the real number and expiry, the wallet identifier and flags saying a token was used and the cryptogram was valid.
4. The issuer checks the real card's expiry and standing and approves or declines. If the real card expires, the issuer must update the token service so the token keeps working.

In clearing the issuer again sees the real number plus a token marker, the assurance level and which party requested the token. Retrievals and chargebacks use the real number.

## Operations

Issuers need a way to map real numbers to tokens (messages, a customer-service API, a portal or bulk upload), customer-service tools to investigate and re-provision, and reporting on enablement, eligibility decisions, activation success and verification outcomes. An API is generally the better option than a portal for scale.

## Why customers like it

Tap-and-go is fast, the phone is always in hand and the real number never leaves the secure store. Related: [Tokenization](/knowledge/tokenization), [Risk scoring and fraud controls](/knowledge/risk-and-fraud), [Tokenization course](/academy/tokenization).` });

pages.forEach((p, i) => { p.order = i; });
const bySlug = Object.fromEntries(pages.map((p) => [p.slug, p]));
module.exports = { pages, bySlug, TERMS };
