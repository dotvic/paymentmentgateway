# Billing, legal pages and account deletion

DryRun sells one paid plan, **Pro**, as a monthly subscription through Stripe Checkout. Stripe handles cards, VAT invoices and cancellations, so card data never touches this server.

Billing switches on only when all three Stripe secrets are set. Until then the Pro card on the website says "Not open yet".

## 1. Operator details for the Terms and Privacy pages

The pages at `/terms` and `/privacy` show your details, taken from these settings. Until you set them, the pages show visible placeholders such as `[operator name not set]`, so **do not promote the site before setting them**.

```
fly secrets set OPERATOR_NAME="Your legal name or company" --app paymentmentgateway
fly secrets set OPERATOR_ADDRESS="Street 1, 00-000 City, Country" --app paymentmentgateway
fly secrets set CONTACT_EMAIL="support@yourdomain.com" --app paymentmentgateway
fly secrets set GOVERNING_LAW="Poland" --app paymentmentgateway
```

Use an email address you are happy to publish. Each `fly secrets set` restarts the machine briefly, so set them together:

```
fly secrets set OPERATOR_NAME="..." OPERATOR_ADDRESS="..." CONTACT_EMAIL="..." GOVERNING_LAW="..." --app paymentmentgateway
```

Have a lawyer review both pages. They are a sensible starting point written for this service, not legal advice.

## 2. Set up Stripe (test mode first)

1. Create an account at https://dashboard.stripe.com and switch on **Test mode** (top right).
2. **Product:** Product catalogue → Add product → name it "DryRun Pro", add a recurring monthly price (for example EUR 19). Copy the **Price ID** (starts with `price_`).
3. **Customer portal:** Settings → Billing → Customer portal → turn it on, and allow customers to cancel subscriptions. Without this, "Manage billing" fails.
4. **API key:** Developers → API keys. Either use the secret key (`sk_test_...`), or better, create a **restricted key** with write access to *Checkout Sessions*, *Customer portal* and *Subscriptions*.
5. **Webhook:** Developers → Webhooks → Add endpoint.
   - URL: `https://paymentmentgateway.fly.dev/stripe/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - Copy the **Signing secret** (starts with `whsec_`).

## 3. Give the server the Stripe settings

```
fly secrets set STRIPE_SECRET_KEY="sk_test_..." STRIPE_PRICE_ID="price_..." STRIPE_WEBHOOK_SECRET="whsec_..." PRO_PRICE_LABEL="EUR 19 per month" --app paymentmentgateway
```

`PRO_PRICE_LABEL` is only the text shown on the website and in the Terms. It must match the price you created in Stripe. Then redeploy from the project folder: `fly deploy --ha=false --app paymentmentgateway`. The startup log should say `billing on`.

## 4. Test the whole flow in test mode

1. Open the site, create a key, click **Upgrade to Pro**.
2. Pay with Stripe's test card `4242 4242 4242 4242`, any future expiry date, any CVC.
3. You return to the site, and within a few seconds it should say "You are on the Pro plan". The usage line then shows a 20000 limit.
4. Click **Manage billing**, cancel the subscription, and check that the plan returns to Free.
5. In Stripe, Developers → Webhooks → your endpoint, check that deliveries show `200`.

The billing code has been tested only against a simulated Stripe, so this real test-mode run is an essential step before you take real money.

## 5. Going live

1. In Stripe, activate your account (business details, bank account). This is needed to take real payments.
2. Switch Test mode off and repeat steps 2.2 to 2.5 in live mode: a live price, a live key (`sk_live_...` or a restricted `rk_live_...`), and a live webhook endpoint with its own signing secret.
3. Replace the three Stripe secrets with the live values (section 3) and make one real payment with your own card, then refund it in Stripe.
4. **VAT:** if you sell to customers in the EU, VAT rules apply. Stripe Tax (Settings → Tax) can calculate and collect it. Register for VAT or the EU One-Stop Shop where required. Ask an accountant, because this depends on your country and company.

## How the plan changes

| Stripe event | What the server does |
|---|---|
| `checkout.session.completed` (paid) | Links the Stripe customer to the account, plan becomes Pro |
| subscription `active` / `trialing` / `past_due` | Pro (a failed payment keeps Pro while Stripe retries) |
| subscription `unpaid` / `canceled` / `incomplete_expired` | Free |
| `customer.subscription.deleted` | Free |

## Account deletion and retention

- Customers can delete their account on the website, or with `DELETE /v1/account` and body `{"confirm": true}`. An active subscription is cancelled at Stripe first. If cancelling fails, the account is not deleted, so nobody keeps paying for a deleted account.
- Free accounts unused for 365 days are deleted automatically (checked at startup and once a day). Paying accounts are never deleted automatically.
- Stripe keeps invoices and payment records as tax law requires. The Privacy policy says so.

## Settings reference

| Secret | Purpose |
|---|---|
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | All three are needed for billing to switch on |
| `PRO_PRICE_LABEL` | Price text on the website and in the Terms |
| `PUBLIC_URL` | Where Stripe sends customers back. Defaults to `https://<app>.fly.dev`. Set it if you add your own domain |
| `OPERATOR_NAME`, `OPERATOR_ADDRESS`, `CONTACT_EMAIL`, `GOVERNING_LAW` | Shown on the Terms and Privacy pages |
