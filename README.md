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
| `GET/PUT/DELETE /v1/script` | Failure script (Pro or trial): `{"rules":[{"when":{"every":3},"then":{"outcome":"decline"}}]}`. Fields: when `nth`, `every`, `amount_gte`, `amount_lte`, `currency`, `method`, `transaction_type`, `scheme`, `probability`; then `outcome`, `latency_ms`, `http_error` (500/502/503, no payment created), `webhook` (`duplicate`, `delay_ms`, `drop`, `bad_signature`) |
| `GET /v1/webhook/deliveries/{id}` | One delivery with the stored event body and every attempt (status, time taken, response snippet) |
| `POST /v1/webhook/deliveries/{id}/replay` | Send a stored event again (same event id, fresh signature, header `X-DryRun-Replay: true`). Pro or trial |
| `POST /v1/payments/{id}/3ds` | Complete a challenge with `{"result":"approve"\|"fail"}` |
| `PUT/GET/DELETE /v1/webhook` | Manage the webhook; PUT returns a signing `secret` |
| `POST /v1/webhook/test` | Send a `ping` event |
| `GET /v1/webhook/deliveries` | Delivery attempts and retries |
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
