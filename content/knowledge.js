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

pages.push({ slug: "terminal-messages-and-batches", title: "Terminal messages, reversals and batches", category: "Concepts", summary: "How a terminal and its acquirer host talk: reading a message type, the data elements that matter, what to do when an answer is lost, voids, tips, offline sales and closing the day.", markdown: `A payment terminal and its acquirer host exchange short, strict messages. Most networks base them on the ISO 8583 standard, but every acquirer fixes its own layout, so the details below are the common ideas, not any one host's specification. Practise them in the [Terminal messaging lab](/labs/terminal).

## Reading a message type

The **message type** is four digits, and each digit has a job.

1. **Version of the standard.** 0 is the oldest layout, 1 and 2 are later ones, 8 and 9 are for national and private use.
2. **Class.** 1 authorisation, 2 financial (the money moves now), 3 file action, 4 reversal, 5 reconciliation (settlement totals), 8 network management (log on, echo test, key change).
3. **Function.** 0 request, 1 response, 2 advice (this already happened, you can only accept it), 3 advice response.
4. **Origin.** 0 acquirer side, 2 issuer side, with a repeat variant of each.

So **0210** is a financial response, and **0400** is a reversal request. A **request** can be refused. An **advice** cannot: it tells the host what the terminal has already done.

## The message body

After the type comes a **bitmap**, a row of bits that says which **data elements** follow. A few appear almost everywhere.

- **Processing code**: what kind of transaction (sale, refund, void, balance) and which account type.
- **Amount**: whole minor units, so 12.50 is 1250.
- **Trace number (STAN)**: six digits, assigned by the terminal, unique for that terminal. It names the transaction in every later message about it.
- **Entry mode**: how the card was read (typed, stripe, chip, contactless) and whether a PIN could be taken. Issuers use it for risk and for liability.
- **Condition code**: the situation, such as customer present, mail or telephone order, or recurring.
- **Terminal and merchant identifiers**: which terminal, in which shop.
- **Chip data**: one large element carrying the chip's tags, such as the cryptogram and the terminal's verification results.
- **Reference number and approval code**: assigned by the host in the answer. The terminal must keep both.
- **Response code**: 00 means approved. Others say why not: do not honour, insufficient funds, unable to locate, duplicate.
- **Message authentication code**: proves the message was not altered on the way.

## When the answer is lost

The terminal sends a sale and the line drops. The host may have approved it, and the customer's money may be held, but the terminal never saw the answer. It cannot assume either outcome. It must send a **reversal** carrying the original's trace number and amount, and **repeat it until the host answers**. No other transaction and no batch close may go first. If the host never saw the sale, it simply says there is nothing to undo.

A reversal is a technical undo of something that did not complete. It is **not a refund**. A refund is a separate, customer-visible transaction.

## Void, refund and tip

- A **void** cancels a sale that is still in the open batch. The host finds the original by matching several fields: amount, trace number, time and reference. All must repeat the original exactly. If the batch has closed, the sale has already gone to settlement and the merchant must **refund** instead.
- A **refund** is a new transaction with its own processing code.
- A **tip** is added after the first approval. The final amount is the base plus the tip, and good designs carry the base and the tip as separate values so the totals and the receipt can both be right. The screen must make clear that the customer is typing a tip, never a PIN.

## Offline sales and the floor limit

When a terminal cannot reach the host, it may approve small amounts on its own, up to a **floor limit** set by the acquirer for that kind of merchant. It stores the sale and later sends an **advice** with a marker showing it approved the sale locally. Above the floor limit the sale must go online. Two rules keep this safe: offline approval only below the limit, and every stored sale sent **before** the batch closes.

## Closing the batch

At the end of the day, usually automatically, the terminal sends a **batch close** with its totals: count and amount of sales, count and amount of refunds. The host compares them with what it holds.

1. The terminal first settles anything outstanding: any reversal, then any offline advices.
2. It sends the totals. If they match, the batch is closed and a new one opens.
3. If they do not, the host answers with a mismatch code. The terminal **uploads** its transactions one by one so the host can rebuild the totals, then closes again with a later-attempt code.

An open batch should not sit for long. Many terminals prompt, or close on their own, after a week at most, because unsent sales are unsettled money.

## Security of the link

Messages travel over an encrypted channel and carry a message authentication code. PINs have their own protection and key scheme: see [EMV decision flow and PIN keys](/knowledge/emv-decision-flow-and-pin-keys). Card numbers are not written into logs. A terminal that logs them has a compliance problem.

## Quick checks when a test fails

- A void not found: compare amount, trace number, time and reference with the original answer, not with your memory.
- A duplicate: you reused a trace number. Each new sale needs a new one.
- A mismatch at close: look for an offline sale not yet sent, a tip you adjusted on the terminal but never sent, or a reversal that never finished.
- Chip data disagreeing with the amount field: the cryptogram was signed over the amount, so the issuer cannot trust it.` });
pages.push({ slug: "emv-decision-flow-and-pin-keys", title: "EMV decision flow and PIN keys", category: "Concepts", summary: "From card power-up to the issuer's answer: what the terminal and the chip each decide, how action codes work, and how PIN keys are managed with master/session keys and DUKPT.", markdown: `This guide follows a chip transaction step by step and then looks at how the PIN is protected on its way to the issuer. The [card-present course](/academy/card-present) covers the cryptogram itself. Try the decision in the [Terminal messaging lab](/labs/terminal).

## The steps

1. **Power up.** The terminal powers the chip and the chip answers.
2. **Application selection.** The chip lists its applications, each named by an **application identifier**: a five-byte registered prefix for the scheme or domestic network, then an extension for the product. The terminal picks one it also supports. Domestic networks have their own identifiers, so a card may be accepted at home and not abroad.
3. **Start processing.** The terminal sends a **Get Processing Options** command with the data the chip asked for in a **processing options data object list**. The chip answers with an **application interchange profile** (what it supports) and an **application file locator** (which records to read).
4. **Read the records.** The terminal reads those records. The data inside is in **tag-length-value** form: a tag naming the item, its length, then its value.
5. **Processing restrictions.** Version match, expiry date, not-yet-effective date, and whether this kind of use is allowed (domestic or international, goods or cash). A failure sets a bit but does not decline by itself.
6. **Offline data authentication.** The terminal checks the card is genuine without calling anyone. **Static** authentication checks that data was signed, which stops edits but not copies. **Dynamic** and **combined** authentication make the chip sign fresh data, which also stops copies. Static is being retired.
7. **Cardholder verification.** The chip holds a ranked **verification method list**: online PIN, offline PIN (plain or enciphered), signature, none, or a check done on the customer's own device. The terminal takes the first method it supports that applies.
8. **Terminal risk management.** The terminal checks the floor limit, may randomly choose the transaction to go online, and checks how long since the card last went online.
9. **Terminal action analysis.** The terminal decides: decline, go online or approve offline. See below.
10. **First cryptogram request.** The terminal asks the chip for one of three answers: a **transaction certificate** (approve offline), an **authorisation request cryptogram** (go online), or an **application authentication cryptogram** (decline).
11. **Online.** If asked to go online, the terminal sends the request with the cryptogram. The issuer checks it and answers with a response code, and usually its own response cryptogram.
12. **Second cryptogram request.** The terminal tells the chip the outcome. The chip can still decline, for example when the issuer's response cryptogram fails to verify.
13. **Issuer scripts.** The issuer may send commands to update the card, such as changing limits or blocking it.

Contactless and quick-chip flows shorten this: the card may leave before the issuer's answer, so the response cryptogram and scripts are skipped.

## Action codes in detail

The terminal keeps a record of what it saw: the **terminal verification results**, five bytes of flags such as expired, floor limit exceeded or PIN not entered. It compares those flags with two sets of **action codes**: one stored in the terminal, set with the acquirer and scheme's advice, and one stored in the chip, set by the issuer. Each set has three codes:

- **Denial**: if a matching flag is set, decline.
- **Online**: if a matching flag is set, go online.
- **Default**: used when the terminal cannot go online.

The terminal combines the terminal's and the issuer's code with OR, then checks which TVR bits match. The order is fixed: denial first, then online (when it can), otherwise approve offline. A terminal that cannot go online uses the default code instead of the online code.

## The card has the last word, but only downward

The chip may answer differently from what the terminal asked. The ranking is approve offline, then go online, then decline. The chip can **move toward decline** (asked for offline approval, it answers go online or decline) but **never toward approval** (asked to go online, it cannot answer approve offline). That one rule is why a stolen terminal cannot talk a card into approving more than the card's own limits allow.

## PIN keys

An online PIN is typed on an encrypted PIN pad and leaves the pad as an **encrypted PIN block**: the PIN mixed with the card number, then encrypted, so the same PIN looks different on each card. The question is which key encrypts it.

### Master and session keys

- A **terminal master key** is loaded once, in a key ceremony, and shared with the acquirer's host.
- For each transaction (or periodically) the host sends a **new session key**, encrypted under the master key.
- The terminal encrypts the PIN block under the session key. The host decrypts the session key with the master key, then the PIN block.
- Weakness: a leaked master key exposes everything under it, and the host must keep a key per terminal.

### DUKPT: a new key for every transaction

**Derived unique key per transaction** puts a **base derivation key** at the acquirer, never in a terminal. Each terminal is loaded with an initial key derived from it and a **key serial number**. For every transaction the terminal derives a fresh key from its stored keys and a counter inside the serial number, uses it once, and erases it.

- The terminal sends the encrypted PIN block and the key serial number.
- The host re-derives the same key from the base key and the serial number, and decrypts.
- A stolen terminal reveals no earlier keys, and one leaked transaction key tells you nothing about the next.

Older schemes use triple DES. Newer ones use AES. Either way the PIN block is decrypted only inside a **hardware security module**, a tamper-resistant device, and never in ordinary software.

## Offline PIN

With offline PIN, the terminal sends the PIN to the chip itself, which compares it with its stored value. The PIN never goes to the host, so no PIN block travels in the message. The terminal may encipher it with the card's own public key. Offline methods suit places with poor connections but leave less trail for the issuer.

## Common mistakes

- Treating a bit in the verification results as a decline. It is only a flag until the action codes are applied.
- Assuming the online code applies when the terminal cannot reach the network.
- Logging a PIN block, or any unencrypted PIN, for debugging.
- Using one test key everywhere and then reusing it in production.` });
pages.push({ slug: "settlement-routing-and-the-acquirer", title: "Settlement, routing and what an acquirer does", category: "Concepts", summary: "On-us and off-us transactions, dual and single message processing, how netting and funding work, and what an acquirer does from onboarding to account closure.", markdown: `The [payment lifecycle](/knowledge/payment-lifecycle) page shows the four parties. This guide goes one level deeper on routing, settlement and the acquirer's side.

## On-us and off-us

When the **same bank** is both acquirer and issuer, the payment is **on-us**. It never needs to cross a card network: the bank checks the account, approves and settles internally. The merchant is usually unaware and is charged as usual. The bank keeps both sides of the fee and pays little or nothing to the network, which is why banks like on-us volume.

When the acquirer and issuer differ, the payment is **off-us**. It is routed over a network to find the issuer. Network fees apply, and the acquirer pays **interchange** to the issuer. Cross-border payments are always off-us.

## Dual message and single message

- **Dual message.** The authorisation is one message and the clearing is a second one, usually in a file later. In between, the amount is only held. This leaves room for tips, adjustments, partial shipments and fraud checks. It is the norm for credit and for travel, hotels and fuel.
- **Single message.** One message carries both the approval and the money movement, so it is final at once. It suits cash withdrawals and many debit payments, where the amount is known and nothing changes afterwards.

The split is not strict. Many networks run debit in dual message, and some credit schemes use single message domestically. Check which one your acquirer and the scheme use before designing a flow.

## Settlement step by step

1. **Authorisation.** The issuer approves. No money has moved.
2. **Batching.** The acquirer collects approved transactions from its terminals, usually daily.
3. **Submission.** The acquirer sends the batch to the network in a clearing file.
4. **Netting.** The network adds up what each issuer owes and each acquirer is owed, and produces **one net position per member** instead of millions of small transfers.
5. **Fund transfer.** Net amounts move between issuers and acquirers. Cardholders are billed by their issuers separately.
6. **Merchant funding.** The acquirer credits the merchant, net of fees, on the agreed schedule. The whole journey takes from hours to a few days.

Files used in this exchange are structured, standardised data files, which is why many members call them **electronic data interchange**.

## Four-party contracts

The cardholder has a contract with the issuer. The issuer and acquirer are each members of a network. The acquirer has a contract with the merchant. The merchant and the cardholder have a sales contract under consumer law. **There is no contract between issuer and acquirer** or between acquirer and cardholder. They are bound together by network rules, which is why a network rule can decide a dispute.

## What an acquirer does

1. **Recruit.** Understand the merchant's needs, agree pricing and terms.
2. **Underwrite.** Assess credit and fraud risk before the first transaction. What is sold and how long until it is delivered (a ticket for next year is a long exposure), the merchant's finances, checks against fraud databases and against money-laundering and sanctions lists.
3. **Deploy.** Provide terminals or a gateway, assign a merchant and a terminal identifier, and get each terminal approved (see [POS acquiring and certification](/knowledge/pos-acquiring-and-certification)).
4. **Support.** Terminal faults, reconciliation questions, changes of bank account.
5. **Handle disputes.** When an issuer charges a sale back, the acquirer checks the claim against network rules and either represents it with evidence or debits the merchant. See [Chargeback defence and evidence](/knowledge/chargeback-defence-and-evidence).
6. **Monitor.** Networks measure acquirers on fraud and dispute rates and fine them when thresholds break, so the acquirer watches each merchant continuously and may hold funds or close accounts.
7. **Close.** When a merchant stops trading, especially through insolvency, sales already settled can still be disputed for months. If the merchant cannot repay, **the acquirer absorbs the loss**. This is the credit exposure underwriting tries to price.

## Why fees differ

An acquirer that takes more risk charges more. High-dispute sectors, long delivery times and new businesses pay higher rates, and may be asked for a reserve that the acquirer holds back. Pricing is either blended (one rate for everything) or **interchange plus** (the pass-through cost plus a clear markup). The second is more transparent.

## Other parties you will meet

- **Payment service provider**: lets a merchant accept many methods through one contract, often taking on the merchant relationship itself.
- **Independent sales organisation**: sells acquiring services on behalf of an acquirer but does not hold the merchant's funds.
- **Gateway**: the secure link that passes the payment request to the acquirer.
- **Payment initiation provider**: starts a bank transfer on the customer's consent, bypassing the card networks entirely.

## Checking your understanding

If a payment fails after a hotel stay, is it dual or single message? Which party absorbs a sale charged back after the merchant has gone bankrupt? Why can netting turn many billions of purchases into a handful of transfers? The [Terminal messaging course](/academy/terminal-messaging) asks these and more.` });

pages.push({ slug: "how-interchange-and-fees-work", title: "How interchange and fees work", category: "Concepts", summary: "Who sets interchange, what decides the rate, four fee shapes with worked examples, incentives, blended versus interchange-plus pricing, and the cost of settling late.", markdown: `When a customer pays 100.00 by card, the merchant does not receive 100.00. Part of the amount goes to the issuer as **interchange**, part to the card scheme, and part stays with the acquirer. This guide shows how the interchange part is built. Try it in the [Fees lab](/labs/fees). Every rate on this site is invented for teaching.

## Who sets interchange, and who earns it

Interchange is paid by the **acquirer** to the **issuer** on each payment. The card scheme usually publishes the rates but does not keep the interchange itself. Participants do not negotiate it payment by payment. The scheme earns its own, separate **scheme fee**.

## What decides the rate

1. **Where the merchant and the issuer are.** Both in the same country is **domestic**. Different countries in the same region is **intraregional**. Different regions is **interregional**. Cheapest to dearest is usually in that order.
2. **The kind of card.** Debit usually costs less than credit, and premium or corporate cards cost more.
3. **How the card was used.** Chip, contactless and strongly authenticated online payments cost less. Manually keyed and unauthenticated online payments cost more, because they carry more fraud.
4. **Local conditions.** Markets differ in maturity, how many people use cards, fraud levels, and what a cash or bank transfer would cost instead. Rates also reflect competition between schemes.

A **rate designator** is the code attached to a transaction so everyone applies the same row of the rate table. If the acquirer sends the wrong one, the issuer or the clearing system may reject the message.

## Four fee shapes

- **Flat**: a fixed amount per payment, such as 0.10.
- **Percentage**: a share of the amount, such as 0.30%.
- **Combined**: a flat part plus a percentage, such as 0.05 + 0.35%.
- **Percentage with a minimum and maximum**: the percentage is worked out, then held between a floor and a ceiling.

Worked example, percentage: 0.30% of 100.00 is 0.30. The issuer keeps 0.30 out of the 100.00 it owes, so the acquirer is credited **99.70**.

Worked example, combined, on a cash withdrawal: a flat 0.50 plus 0.15% of 200.00 (0.30) is 0.80. For cash the issuer paid out money, so the acquirer is credited the cash amount **plus** the fee: **200.80**.

Worked example, minimum and maximum: 1.10% of 10.00 is 0.11, but the minimum is 0.20, so the fee is 0.20. On a very large payment the maximum would apply instead.

## Incentives

Rates are used to steer behaviour. A lower rate for chip, contactless and strongly authenticated online payments rewards the ways of paying that cut fraud. A higher rate for keyed or unauthenticated payments passes the cost of risk to the people who take it.

## What the merchant pays

The merchant's total fee is interchange + scheme fee + acquirer markup. How it is shown is the **pricing model**:

- **Interchange-plus**: the merchant sees each part. Costs move with the real cost of each payment. It is more transparent and cheaper when most payments are cheap.
- **Blended**: one flat rate for everything. It is simple to understand and budget, but the merchant overpays on cheap payments (domestic debit, contactless) and underpays on dear ones (foreign credit, keyed). The acquirer keeps the difference.

Compare both for your own mix of payments before signing. The [Fees lab](/labs/fees) does this for any single payment.

## Late settlement costs money too

A participant in a net debit position must fund its settlement account by the **value date**. Failing to do so brings interest, cost recovery and a daily assessment. A typical rule is a flat daily charge for small amounts and a percentage of the unpaid amount for large ones. Example with invented numbers: owing 30,000.00 for 20 days at 200.00 a day costs 4,000.00. The charge is usually worked out only after the debt is paid, so it arrives later as its own bill.

## Where the numbers come from

Real rates are published by the card schemes and by regulators in some regions, which cap them. Rates change, so always use the current published table and your own contract. See also [Settlement, routing and what an acquirer does](/knowledge/settlement-routing-and-the-acquirer) and [Clearing, settlement advice and reconciliation](/knowledge/clearing-settlement-advice-and-reconciliation).` });

pages.push({ slug: "clearing-settlement-advice-and-reconciliation", title: "Clearing, settlement advice and reconciliation", category: "Concepts", summary: "The three clearing steps, presentment windows, rejections, net settlement and value dates, billing, how to reconcile an advice, and the dispute ladder with who pays what.", markdown: `Authorisation checks that a payment can happen. **Clearing** and **settlement** make it pay. This guide follows the acquirer's side of that path and shows how to check that the money that arrives is the money you expected. Practise it in the [Clearing and reconciliation lab](/labs/clearing).

## The three steps of clearing

1. **Submission.** The acquirer collects the day's captured sales, mostly from the files its terminals and gateways upload, and sends them to the clearing system in a file. Each sale becomes a **first presentment** message carrying the amount, date and time, approval code, merchant and terminal identifiers, and the rate designator.
2. **Acknowledgement.** The clearing system checks every file and message and replies. It acknowledges groups of accepted messages, not each transaction.
3. **Notification.** The issuer is sent the messages that were accepted. The acquirer is told about chargebacks the issuer raised.

The acquirer starts clearing, because it wants to be paid. The issuer starts the dispute cycle.

## Windows and cycles

A sale must be presented within a fixed number of days: shorter for electronically recorded sales (seven in our lab) and longer for manual ones (thirty). After that, clearing refuses it. Files may be sent at any hour, but the system processes them in scheduled **cycles** several times a day, and a file sent after the last **cut-off** waits for the next settlement day. Some days have no processing at all.

## Checks and rejections

Every file and message is edited. A **file** is rejected whole for things like a repeated file id, a missing header or trailer, or a trailer count that does not match the messages. A **message** is rejected for things like an invalid expiry date, a rate designator that does not exist, or a sale already presented. The rejection report names the file, the field and up to ten error codes.

If every message in a file is rejected, the file is rejected too. Rejected items are **never paid**. The acquirer must fix them and send them again in a new file, within the presentment window. That is why an unnoticed rejection becomes lost money.

## Settlement and the advice

Clearing moves data. **Settlement** moves money. At each settlement cut-off the settlement system adds up all credits and debits for each participant and works out one **net position**. It then sends a **settlement advice** to the settlement bank: the net amount, the settlement date and the **value date**, which is the day funds must move.

Funds move only on days the settlement bank is open, so holidays and weekends push the value date. A participant in net debit must fund its account by then. A participant in net credit is paid.

The advice gives you **one** number. It does not list what is in it.

## Billing arrives in the same flow

The scheme bills participants for its services and for fees. Those charges can be collected through settlement itself, by direct debit, or as fee-collection messages in the clearing file. Three different organisations can appear on one invoice: the one being invoiced, the one that received the service, and the one that pays. They may all be different.

## Reconciliation: the three-way match

To check the advice, you add together the cycle summary reports for the files that settled that day. The summary lists each file, how many messages were accepted and their total. The advice net should equal:

accepted totals − fees − chargebacks and other debits

Then compare that against **your own** total of what you sent. Any gap must be explained by something on the reports:

- sales **rejected** and not yet paid,
- **fees** deducted,
- **chargebacks** received,
- **timing**, such as a file that settled on a later day,
- **currency** differences if settlement is in another currency.

If the gap cannot be explained, it is a real break and must be investigated before the money is assumed to be safe.

Two worlds exist. In **dual message** processing, clearing is separate from authorisation, so the clearing reports above are your source. In **single message** processing (typical for PIN debit), authorisation carries the financial data, so the daily control report from the switch is matched against the advice instead, and fees come through as separate fee-collection messages.

## The dispute ladder

Disputes run through the same clearing files, and money moves at each step:

1. **First presentment**: acquirer credited, issuer debited.
2. **First chargeback**: the issuer returns it with a reason code. Issuer credited, acquirer debited.
3. **Second presentment**: the acquirer answers with evidence. Acquirer credited again.
4. **Arbitration chargeback**: the issuer still disagrees. Issuer credited again.
5. **Arbitration case**: either side asks the scheme to rule. The loser pays filing and administrative fees. A participant that broke dispute-processing rules also pays a technical fee for each violation.

Chargeback reasons fall into four groups: authorisation, fraud, cardholder dispute and processing errors. If someone broke the rules and caused a loss but no chargeback reason fits, a **compliance case** is used instead, usually after a pre-compliance attempt. Merchants should read the evidence advice in [Chargeback defence and evidence](/knowledge/chargeback-defence-and-evidence).

All figures, windows and fees in our labs are invented. Use your scheme's current rules for real work.` });

pages.forEach((p, i) => { p.order = i; });
const bySlug = Object.fromEntries(pages.map((p) => [p.slug, p]));
module.exports = { pages, bySlug, TERMS };
