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

pages.push({ slug: "test-cards", title: "Test cards", category: "Reference", summary: "Every test card for Visa, Mastercard and American Express, and what each one does.",
  markdown: "Use these numbers with any future expiry. Visa and Mastercard use a 3-digit security code, American Express a 4-digit one. The PIN for card-present tests is `1234`. Real card numbers are always refused.\n\n" +
    Object.values(SCH.SCHEMES).map((s) => `## ${s.name}\n\n${s.note}\n\n| Number | What it does |\n| --- | --- |\n` + SCH.TEST_CARDS.filter((c) => c.scheme === s.id).map((c) => `| \`${c.number}\` | ${c.label} |`).join("\n")).join("\n\n") });
const codeRows = Object.entries(GLOSS).map(([k, v]) => `| \`${k}\` | ${v} |`).join("\n");
pages.push({ slug: "status-codes", title: "Status and response codes", category: "Reference", summary: "What every SBX status code, 3-D Secure status and card-present response code means.",
  markdown: "Payment results carry a status `code` and `message`. Scheme response codes differ by scheme:\n\n## Zanboxx codes\n\n| Code | Meaning |\n| --- | --- |\n" + codeRows + "\n\n## Scheme response codes\n\n| Scheme | Decline | Insufficient funds | Expired | Invalid card |\n| --- | --- | --- | --- | --- |\n" +
    Object.values(SCH.SCHEMES).map((s) => `| ${s.name} | ${s.responses.decline.code} ${s.responses.decline.message} | ${s.responses.nsf.code} | ${s.responses.expired.code} | ${s.responses.invalid_card.code} |`).join("\n") });
pages.push({ slug: "glossary", title: "Glossary", category: "Reference", summary: `${TERMS.length} payments terms in plain language.`,
  markdown: TERMS.slice().sort((a, b) => a[0].localeCompare(b[0])).map(([t, d]) => `### ${t}\n\n${d}`).join("\n\n") });

pages.forEach((p, i) => { p.order = i; });
const bySlug = Object.fromEntries(pages.map((p) => [p.slug, p]));
module.exports = { pages, bySlug, TERMS };
