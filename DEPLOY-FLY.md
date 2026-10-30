# Deploy DryRun API to Fly.io (Frankfurt)

Why Fly.io: it builds your Dockerfile directly, gives you HTTPS automatically, has a Frankfurt region (`fra`), and lets you attach a persistent volume, which this app needs because accounts and payments are stored in a file. Cost is pay-as-you-go with no free tier for new accounts; expect a few dollars a month for one small machine plus a 1 GB volume. Check https://fly.io/pricing before you start.

## 1. Install the Fly command-line tool

- macOS: `brew install flyctl`
- Linux: `curl -L https://fly.io/install.sh | sh`
- Windows (PowerShell): `iwr https://fly.io/install.ps1 -useb | iex`

## 2. Create your account

```
fly auth signup
```

Fly requires a credit card after the short trial. Add one at https://fly.io/dashboard under Billing.

## 3. Pick an app name

Open `fly.toml` and change the first line to a unique name, for example `app = "dryrun-yourname"`. Your API address will be `https://dryrun-yourname.fly.dev`.

## 4. Create the app and the data volume

Run these from the `dryrun-api` folder:

```
fly apps create dryrun-yourname
fly volumes create dryrun_data --region fra --size 1 --app dryrun-yourname
```

The volume name must stay `dryrun_data` because `fly.toml` refers to it.

## 5. Set the signup token

This keeps strangers from creating accounts while you test. Choose any long random string:

```
fly secrets set SIGNUP_TOKEN=pick-a-long-random-string --app dryrun-yourname
```

## 6. Deploy

```
fly deploy --ha=false --app dryrun-yourname
```

`--ha=false` keeps exactly one machine. This matters: the app stores data in a local file, so two machines would each have a different copy of your data.

## 7. Check that it works

```
curl https://dryrun-yourname.fly.dev/health
```

Expected: `{"ok":true}`. Then create an account and a test payment:

```
curl -X POST https://dryrun-yourname.fly.dev/v1/accounts -H "X-Signup-Token: pick-a-long-random-string"

curl -X POST https://dryrun-yourname.fly.dev/v1/payments \
  -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{"request_id":"first-test","method":"card","transaction_type":"purchase","amount":10,"currency":"EUR","card_number":"4111111111111111"}'
```

The response should show `"transaction_state":"success"`.

## 8. Test webhooks

Get a free temporary receiver URL from https://webhook.site, then:

```
curl -X PUT https://dryrun-yourname.fly.dev/v1/webhook \
  -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://webhook.site/YOUR-ID"}'

curl -X POST https://dryrun-yourname.fly.dev/v1/webhook/test -H "Authorization: Bearer YOUR_API_KEY"
```

A `ping` event should appear on the webhook.site page within a few seconds.

## 9. Add your own domain (optional)

```
fly certs add api.yourdomain.com --app dryrun-yourname
```

Fly prints the DNS record to add at your domain registrar. HTTPS is issued automatically once it resolves.

## Day-to-day commands

- Logs: `fly logs --app dryrun-yourname`
- Status: `fly status --app dryrun-yourname`
- Redeploy after changes: `fly deploy --ha=false --app dryrun-yourname`
- Back up your data: `fly ssh sftp get /data/data.json` (run this regularly; it contains all accounts and keys)

## Things to know

- The machine is set never to stop, because webhook retries and the timeout simulation run on timers. This is also why it is billed continuously.
- Fly takes automatic daily snapshots of volumes, which can add a small charge. Check the pricing page.
- Do not scale to more than one machine until you move storage to a database.
