# Zanboxx API

A hosted sandbox that behaves like a payment gateway. Customers send test payments, trigger declines, timeouts and 3D Secure challenges, and receive signed webhooks. No real money or real card data is ever handled.

Zero dependencies. Needs Node 18+. Run `npm test` to exercise every flow.

## Run it

```bash
SIGNUP_TOKEN=choose-a-secret npm start        # local, port 8080
docker build -t dryrun-api . && docker run -p 8080:8080 -v dryrun-data:/data -e SIGNUP_TOKEN=choose-a-secret dryrun-api
```

Deploy the Dockerfile to Fly.io, Render, Railway or any VPS. **Attach a persistent volume at `/data`**, otherwise accounts vanish on every restart. Put it behind HTTPS (these platforms do this for you).

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | 8080 | Listen port |
| `DATA_FILE` | ./data.json | Where accounts and payments are stored |
| `SIGNUP_TOKEN` | empty | If set, `POST /v1/accounts` needs header `X-Signup-Token`. Leave empty for open signup |
| `ALLOW_PRIVATE_WEBHOOKS` | off | Set to `1` only for local testing. Production blocks webhooks to private/internal addresses |

## Quick start

```bash
# 1. Create an account (the key is shown once)
curl -X POST $HOST/v1/accounts -H "X-Signup-Token: $SIGNUP_TOKEN"

# 2. Create a payment
curl -X POST $HOST/v1/payments -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"request_id":"order-1001","method":"card","transaction_type":"purchase","amount":49.90,"currency":"EUR","card_number":"4111111111111111"}'

# 3. Refund part of it
curl -X POST $HOST/v1/payments -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"request_id":"refund-1","method":"card","transaction_type":"refund","amount":10,"parent_transaction_id":"tx_..."}'

# 4. Register a webhook
curl -X PUT $HOST/v1/webhook -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"url":"https://example.com/hooks"}'
```

## Endpoints

| Method and path | Purpose |
|---|---|
| `POST /v1/accounts` | Create account, returns `api_key` once |
| `POST /v1/payments` | Create a transaction (purchase/debit, authorization, capture-authorization, refund, void) |
| `GET /v1/payments`, `GET /v1/payments/{id}` | List (`?state=&limit=`) or fetch |
| `GET /v1/payments/{id}/3ds-log` | Step-by-step 3-D Secure message log (AReq/ARes, CReq/CRes, RReq/RRes, authorization, liability shift). Latest 20 per account are kept |
| `POST /v1/account/email` | Send a confirmation link to an email address (`{"email":"..."}`) |
| `DELETE /v1/account/email` | Remove the account's email |
| `POST /v1/account/rotate-key` | Create a new API key; the old one stops working |
| `POST /v1/login` | Email a sign-in link to a confirmed address (always answers 200) |
| `POST /v1/login/redeem` | Exchange a sign-in link token for a new API key |
| `POST /v1/email/verify` | Confirm an email with the token from the link |
| `POST /mcp` | MCP server (JSON-RPC 2.0). See the MCP section. |
| `GET/PUT/DELETE /v1/script` | Failure script (Pro or trial): `{"rules":[{"when":{"every":3},"then":{"outcome":"decline"}}]}`. Fields: when `nth`, `every`, `amount_gte`, `amount_lte`, `currency`, `method`, `transaction_type`, `scheme`, `initiator`, `probability`; then `outcome`, `latency_ms`, `http_error` (500/502/503, no payment created), `webhook` (`duplicate`, `delay_ms`, `drop`, `bad_signature`) |
| `GET /v1/webhook/deliveries/{id}` | One delivery with the stored event body and every attempt (status, time taken, response snippet) |
| `POST /v1/webhook/deliveries/{id}/replay` | Send a stored event again (same event id, fresh signature, header `X-DryRun-Replay: true`). Pro or trial |
| `POST /v1/payments/{id}/3ds` | Complete a challenge with `{"result":"approve"\|"fail"}` |
| `PUT/GET/DELETE /v1/webhook` | Manage the webhook; PUT returns a signing `secret` |
| `POST /v1/webhook/test` | Send a `ping` event |
| `GET /v1/webhook/deliveries` | Delivery attempts and retries |
| `POST /v1/settlements` | Close the day: clear everything not yet cleared up to the end of `date` (UTC, default today) into one batch with clearing files, a settlement report and payouts |
| `GET /v1/settlements`, `GET /v1/settlements/{id}` | List batches or fetch one with totals, payouts and records |
| `GET /v1/settlements/{id}/files`, `GET /v1/settlements/{id}/files/{name}` | List the files of a batch, or download one |
| `POST /v1/settlements/{id}/reconcile` | Compare your ledger (`{"csv": "..."}` or `{"ledger": [...]}`) with a batch |
| `GET /v1/settlements/fees` | The fictional fee schedule |
| `GET /v1/reports/transactions?date=` | CSV of every transaction created on a UTC day, all methods, with scheme, dispute and settlement columns |
| `GET /v1/agreements`, `GET /v1/agreements/{id}` | Card-on-file agreements created by a first payment with `store_credential` |
| `POST /v1/agreements/{id}/cancel` | Cancel an agreement; later merchant-initiated payments on it are refused |
| `POST /v1/payments/{id}/dispute` | Play the cardholder's bank and raise a dispute on a successful card purchase or capture. Optional `reason_code` (the payment's scheme code, e.g. `13.1`, `4837`, `F29`) or `reason` (`fraud`, `not_received`, `not_as_described`, `duplicate`), `amount`, `response_window_seconds` (1 to 604800), `outcome` (`auto`, `win`, `lose`) |
| `GET /v1/disputes`, `GET /v1/disputes/{id}` | List (`?state=&limit=`) or fetch, with evidence requirements, timeline and resolution |
| `POST /v1/disputes/{id}/evidence` | Submit evidence once (`{"customer_ip":"...","customer_email":"..."}`). Accepted fields depend on the reason |
| `POST /v1/disputes/{id}/accept` | Accept the dispute (you lose it) |
| `GET /v1/schemes` | Public. Visa, Mastercard and American Express profiles: number formats, security codes, 3DS branding and ECI, response codes, chargeback reasons, test cards |
| `GET /v1/usage` | Plan and monthly usage |
| `DELETE /v1/payments` | Wipe sandbox data |

Methods: `card`, `paypal`, `ideal`, `sepa`. Currencies: EUR, USD, GBP. Optional `scenario`: `auto` (default), `approve`, `decline`, `timeout`, `3ds`.

## Test cards (scenario `auto`)

| Card | Result |
|---|---|
| 4111 1111 1111 1111 | Approved |
| 4000 0000 0000 0002 | Declined (SBX-4002) |
| 4000 0000 0000 9995 | Insufficient funds (SBX-4051) |
| 4000 0000 0000 0069 | Expired (SBX-4054) |
| 4000 0000 0000 3220 | 3D Secure challenge (HTTP 202, then call `/3ds`) |
| 4000 0000 0000 3000 | 3DS frictionless success (transStatus Y) |
| 4000 0000 0000 3238 | 3DS denied (N, SBX-4030) |
| 4000 0000 0000 3253 | 3DS attempted (A, liability shift) |
| 4000 0000 0000 3261 | 3DS unavailable (U, SBX-2002, no liability shift) |
| 4000 0000 0000 3279 | 3DS rejected (R, SBX-4032) |
| 4000 0000 0000 0408 | Gateway timeout (HTTP 504, resolves by webhook after about 3 s) |

Non-card methods and follow-up transactions approve automatically unless you set `scenario`.

### Card schemes

The same outcomes exist for three schemes. Visa cards use the numbers above; the full list per scheme is at `GET /v1/schemes` and under "Test cards" on the site.

| Outcome | Visa | Mastercard | American Express |
|---|---|---|---|
| Approved | 4111 1111 1111 1111 | 5555 5555 5555 4444 | 3782 822463 10005 |
| Declined | 4000 0000 0000 0002 | 5200 0000 0000 0007 | 3700 0000 0000 002 |
| Insufficient funds | 4000 0000 0000 9995 | 5200 0000 0009 9959 | 3700 0000 0009 9954 |
| 3DS challenge | 4000 0000 0000 3220 | 5200 0000 0003 2208 | 3700 0000 0003 2203 |

What differs per scheme (all simplified teaching values; Zanboxx never contacts the real networks):

- **Number and security code:** Amex has 15 digits and a 4-digit CID; Visa and Mastercard 16 digits and a 3-digit CVV2/CVC2. Send an optional `card_cvv` to have its length checked. It is never stored. Numbers that fail the Luhn check get `SBX-4014` (Visa and Mastercard code 14, Amex 111).
- **3-D Secure:** Visa Secure, Mastercard Identity Check, American Express SafeKey. ECI is 05/06/07 for Visa and Amex, 02/01/00 for Mastercard. The authentication value is called CAVV, AAV or AEVV.
- **Decline codes:** payments and webhook events carry `scheme` and, on failures, `scheme_response` with the scheme's own code (Visa and Mastercard 05, 51, 54; Amex 100, 116, 101) and a retry hint.
- **Failure script:** `"when": {"scheme": "amex"}` targets one scheme.

## Clearing, settlement and payouts

A successful card payment still has to be cleared and paid out. `POST /v1/settlements` collects everything not yet cleared up to the end of the given UTC day (Visa, Mastercard and Amex test cards only) and writes one batch:

- **Records:** sales (purchases and captures), refunds, chargebacks and chargeback reversals (disputes you won). Failed, voided and authorization-only payments are not cleared. Each record is cleared once; later events go into the next batch. A cleared payment can no longer be voided (`SBX-4234`); refund it instead.
- **Files:** one clearing file per scheme with records, a settlement report and a payout file. Layouts are made up for teaching and are **not** the real networks' formats: Visa-style fixed width (95-character detail records), Mastercard-style pipe-delimited, Amex-style record-typed CSV. Each has a header, detail records and a trailer with a count and a total you can check. The layouts are listed in the `layout` field of `GET /v1/settlements/{id}/files`.
- **Fees:** a fictional schedule (`GET /v1/settlements/fees`): Visa 1.4% + 0.10, Mastercard 1.5% + 0.10, Amex 2.5% per sale, 15 per chargeback, nothing returned on refunds.
- **Payouts:** net per currency = sales - refunds - chargebacks + reversals - fees, paid two days after the cutoff. A negative payout is money collected from you. The event `settlement.created` is sent when a batch closes.
- **Reconciliation:** `POST /v1/settlements/{id}/reconcile` matches your ledger to the batch by transaction ID and reports `matched`, `amount_mismatch`, `currency_mismatch`, `missing_in_clearing`, `missing_in_ledger` and `duplicate_in_ledger`. Chargebacks come back separately as adjustments, since a ledger of sales will not contain them. CSV may use commas or semicolons.
- Up to 10 batches and 500 records per batch are kept per account.

### Interchange fee report

`GET /v1/settlements/{id}/interchange` (and the file `zbx-interchange-YYYYMMDD.csv`) splits the fees of a batch into **interchange** (paid to the cardholder's bank), the **scheme fee** (paid to the network) and the **acquirer margin** (what is left of the blended fee you were charged). Rows are grouped by scheme, card type (consumer debit, consumer credit, commercial), issuing region (domestic, EEA, international) and currency. The report also prices the same sales with **interchange++** (each cost passed through plus a fixed markup) so you can see which pricing model is cheaper for your card mix. Amex is a three-party scheme with one discount rate, so it is shown but not split. All rates are fictional (`schedule` in the response).

Card type and region follow the card number (same number, same profile) unless you set `card_type` and/or `card_region` on a customer-initiated card payment. Refunds and card-on-file payments inherit them.

## Card on file and merchant-initiated payments (MIT)

Subscriptions, instalments and top-ups charge a stored card without the customer present.

1. **Customer-initiated first payment.** Add `"store_credential": {"type": "recurring"}` (or `"instalment"` with `"instalments": 3`, or `"unscheduled"`) to a card purchase or authorization. When it succeeds (including after a 3-D Secure challenge) an agreement `agr_...` is created and the payment carries `agreement_id` and a `network_transaction_id`. Only the last four digits and the scheme are kept.
2. **Merchant-initiated payments.** Send `"initiator": "merchant"` and `"agreement_id"` instead of a card number. No `card_number`, `card_cvv` or 3-D Secure; `scenario` can be `auto`/`approve`, `decline`, `nsf`, `expired` or `timeout`. The payment quotes the first payment's ID as `original_network_transaction_id` and gets its own.
3. **After a decline**, `scheme_response.merchant_advice` says what the scheme wants next: `do_not_retry`, `retry_later` or `update_credentials`, with the scheme's own label (Visa decline categories 1 to 3, Mastercard MAC 03, 02 and 01; Amex plain wording). These are simplified.

Rules: an agreement must be `active` (not cancelled or completed); for instalments the first payment is number 1 and the agreement completes after the last instalment (failed charges do not use one); `mit_type` must match the agreement type. If the first payment was not authenticated with 3-D Secure and a later payment is in EUR, the response carries a `warnings` entry, because EU issuers may decline such MITs. Events: `agreement.created`, `agreement.cancelled`, `agreement.completed`. Up to 50 active agreements per account.

## Disputes (chargebacks)

Raising a dispute withdraws the amount from the payment and starts a deadline (7 days by default; shorten it with `response_window_seconds` to test the expiry path).

```
needs_response --submit evidence--> under_review --> won | lost
needs_response --accept-----------> lost
needs_response --deadline passes--> lost
```

- **Reason and evidence:** each scheme's codes map to four categories. Fraud wants `customer_ip` and `customer_email`; not received wants `tracking_number` and `proof_of_delivery`; not as described wants `product_description` and `customer_communication`; duplicate wants `original_transaction_reference` and `explanation`. Other fields are accepted too (see `evidence_requirements` on the dispute).
- **Outcome:** with `outcome: auto` the bank rules for you if every needed field is present and against you otherwise, and the loss says which fields were missing. `win` and `lose` force the result.
- **3-D Secure:** a fraud dispute on a payment whose authentication shifted liability is reversed without evidence. Other reasons, and payments without a liability shift, follow the normal flow.
- **Money:** while a dispute is open or lost, its amount counts against the refundable balance, and the payment can no longer be voided. If you win, the amount is released.
- **Webhooks:** `dispute.created`, `dispute.updated` (evidence submitted), `dispute.won`, `dispute.lost`. The event `data` is the dispute. Review takes about 5 seconds (`DISPUTE_REVIEW_DELAY_MS`).
- One dispute per payment, 50 per account. Real schemes also have retrieval requests, pre-arbitration and arbitration, which are not simulated.

## MCP server (use Zanboxx from an AI assistant)

`POST /mcp` speaks the Model Context Protocol (Streamable HTTP, JSON-RPC 2.0, stateless). An assistant can create test payments, finish 3-D Secure challenges, raise and answer disputes, set failure scripts, close settlement days and reconcile, using your own API key. Each tool calls the normal REST API, so limits, quotas and plan rules are the same.

Connect (replace the key with your `sk_test_...` key):

```
# Claude Code
claude mcp add --transport http zanboxx https://zanboxx.com/mcp --header "Authorization: Bearer sk_test_..."

# Clients that only speak stdio (for example Claude Desktop), through mcp-remote
npx mcp-remote https://zanboxx.com/mcp --header "Authorization: Bearer sk_test_..."
```

Tools: `create_payment`, `get_payment`, `list_payments`, `complete_3ds_challenge`, `get_3ds_log`, `get/set/clear_failure_script`, `list_webhook_deliveries`, `replay_webhook_delivery`, `create_dispute`, `list_disputes`, `get_dispute`, `submit_dispute_evidence`, `accept_dispute`, `list_agreements`, `cancel_agreement`, `close_settlement_day`, `get_settlement`, `get_interchange_report`, `reconcile_ledger`, `get_usage`, `list_test_cards`, `explain_status_code`.

Safety: test cards only. `create_payment` refuses card numbers that look real. Key rotation, account deletion, billing and "delete all payments" are not exposed. Browser clients need their origin listed in `MCP_ALLOWED_ORIGINS` (comma separated); other clients send no Origin and work as is. There is no OAuth yet, so connectors that require it (the claude.ai connector screen) cannot connect for now.

## Webhooks

Events: `payment.succeeded`, `payment.failed`, `ping`. Each is POSTed with `X-DryRun-Signature: t=<unix>,v1=<hex>`, where `v1` is HMAC-SHA256 of `"<t>.<raw body>"` with your webhook secret. Failed deliveries retry after 2 s, 10 s and 30 s. Verify like this:

```js
const crypto = require("crypto");
function verify(rawBody, header, secret) {
  const [t, v1] = header.split(",").map((p) => p.split("=")[1]);
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1)) && Math.abs(Date.now() / 1000 - t) < 300;
}
```

## Plans and limits

Free: 200 payments/month, 30 requests/minute. Pro: 20,000 payments/month, 300 requests/minute. To upgrade a customer, set `"plan": "pro"` on their account in the data file (or add a small admin endpoint). Wiring this to a billing provider such as Stripe Checkout and its webhooks is the next step to start charging.

## Before you launch publicly

- Single process with a JSON file is fine for a beta. Move to Postgres once you have real customers or more than one server.
- Rate limits and signup limits are in memory and reset on restart.
- Webhook delivery checks DNS before sending, but a determined attacker could still try DNS rebinding. Run the service in a network with no access to internal systems.
- Add a privacy policy and terms. Tell customers never to send real card numbers; consider rejecting any card number that passes a Luhn check and is not in the test list.
- Do not use Wirecard's name or logo in your branding.

## Billing, Terms and Privacy

See `BILLING.md` for Stripe setup, the operator details shown on `/terms` and `/privacy`, going live, and account deletion (`DELETE /v1/account`).


## Free trial

Confirming an email address starts a 14-day Pro trial (once per address and once per account, no card). During the trial the account gets Pro limits plus failure scripting and webhook replay. When it ends the account returns to Free; scripts stay saved but are not applied. Change the length with `TRIAL_DAYS` (set `0` to switch the trial off). The trial needs email to be configured (`EMAIL_API_KEY`, `EMAIL_FROM`).


## Storage and backups

Data is stored in SQLite (`DB_FILE`, default next to `DATA_FILE`) using the `node:sqlite` module built into Node 22. Scheduled backups, encrypted off-site copies to any S3-compatible storage, and the restore command are described in `DEPLOY-FLY.md`. Admin endpoints (only when `ADMIN_TOKEN` is set): `GET /admin/status`, `POST /admin/backup`.
