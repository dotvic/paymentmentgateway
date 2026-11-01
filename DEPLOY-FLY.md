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

## Updating a deployed app (Windows, no Git needed)

1. Download the new ZIP from GitHub (Code → Download ZIP) and unzip it over a new folder.
2. In PowerShell, go into that folder and run `fly deploy --ha=false --app paymentmentgateway`.

Your data is on the volume, so it is kept across deploys.

## Opening signup to the public

The web page at `/` lets visitors create a free API key themselves. While `SIGNUP_TOKEN` is set, they are asked for an invite token. To open signup to everyone:

```
fly secrets unset SIGNUP_TOKEN --app paymentmentgateway
```

Safeguards that stay on: 5 signups per hour per IP address, at most 2000 accounts (`MAX_ACCOUNTS`), 500 stored payments per account, and the monthly plan limits. Set `fly secrets set SIGNUP_TOKEN=...` again to close signup.

## Using your own domain (zanboxx.com)

1. Request certificates (run in the project folder):
   ```
   fly certs add zanboxx.com --app paymentmentgateway
   fly certs add www.zanboxx.com --app paymentmentgateway
   fly ips list --app paymentmentgateway
   ```
2. At Namecheap: Domain List → Manage → Advanced DNS (nameservers must be "Namecheap BasicDNS"). Delete the default parking records, then add DNS records using the IPs from `fly ips list`:
   - `A` record, Host `@`, value = the IPv4 address
   - `AAAA` record, Host `@`, value = the IPv6 address
   - `CNAME` record, Host `www`, value = `paymentmentgateway.fly.dev`
   (`fly certs show zanboxx.com` prints the exact values and when the certificate is ready.)
3. Point the app at its new address and add the German legal details:
   ```
   fly secrets set PUBLIC_URL=https://zanboxx.com OPERATOR_PHONE="+49 ..." OPERATOR_VAT_ID="DE..." --app paymentmentgateway
   ```
   Also set `GOVERNING_LAW="Germany"` if it is not set yet.
4. Stripe: in the dashboard, check that the webhook endpoint is `https://zanboxx.com/stripe/webhook` (or keep the fly.dev one; both keep working).
5. The `/impressum` page (required for commercial sites in Germany) fills itself from `OPERATOR_NAME`, `OPERATOR_ADDRESS`, `CONTACT_EMAIL`, `OPERATOR_PHONE`, `OPERATOR_VAT_ID`.

## Email recovery (lost-key sign-in)

Accounts can add a confirmed email address and later sign in with a one-time link if they lose their API key. It needs an email provider. The code uses the Resend HTTP API (free tier: 3,000 emails a month).

1. Create an account at resend.com, add the domain `zanboxx.com` under Domains, and add the DNS records it shows you at Namecheap (Advanced DNS). Currently these are a TXT record for DKIM (`resend._domainkey`), two CNAME records (`rsend` and `send`) and an optional TXT `_dmarc` record. Copy every value with Resend's copy buttons and enter only the short host name. Wait until Resend shows the domain as Verified.
2. Create an API key in Resend (permission: sending access).
3. Set the secrets:
   ```
   fly secrets set EMAIL_API_KEY="re_..." EMAIL_FROM="Zanboxx <login@zanboxx.com>" --app paymentmentgateway
   ```
4. Redeploy. The recovery boxes appear on the page once `EMAIL_API_KEY` and `EMAIL_FROM` are set; without them the feature stays hidden and the rest works as before.

Limits: 3 sign-in emails per address per hour, 10 requests per IP per hour (`MAIL_IP_PER_HOUR`). Links expire after 15 minutes (sign-in) or 1 hour (confirmation) and work once. If you use another provider, set `EMAIL_API_BASE` to an API with the same `POST /emails` shape or tell me and I will adapt it.

## Database and backups (SQLite)

Data now lives in a SQLite database (`/data/zanboxx.db`) instead of one JSON file. Writes are transactional, so a crash or a deploy can no longer corrupt the data, and the app saves everything before it exits.

**First start after upgrading:** the app imports `/data/data.json` into the new database automatically and renames the old file to `data.json.migrated`. Nothing else to do. To go back to an older version afterwards, rename `data.json.migrated` back to `data.json` (anything created after the upgrade is lost on a rollback).

### Set up off-site backups (recommended, takes five minutes)

Local snapshots on the same volume protect against mistakes and bad deploys, but not against losing the volume. Fly's own object storage (Tigris) gives you an off-site copy:

1. Create a bucket. This also sets the secrets `AWS_ENDPOINT_URL_S3`, `BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION` for you:
   ```
   fly storage create --app paymentmentgateway --name zanboxx-backups
   ```
2. Choose an encryption passphrase (long and random) and **save it in your password manager**. Without it the off-site backups cannot be read. Then set it, together with a token for the admin page:
   ```
   fly secrets set BACKUP_PASSPHRASE="your-long-random-passphrase" ADMIN_TOKEN="another-long-random-string" --app paymentmentgateway
   ```
3. Redeploy. A backup runs about a minute after start and then every 6 hours: a local snapshot (the newest 8 are kept) and an encrypted copy in the bucket (a rolling set covering the last 7 days).

Settings (all optional): `BACKUP_EVERY_HOURS` (default 6, `0` turns scheduled backups off), `BACKUP_KEEP` (local snapshots, default 8).

### Check that backups work

```
curl.exe -H "Authorization: Bearer YOUR_ADMIN_TOKEN" https://zanboxx.com/admin/status
```
shows the account count, database size, the time of the last local and off-site backup, and the last error if there was one. `POST /admin/backup` with the same header runs a backup now. Check this once a week, or after any change to the secrets.

### Restore a backup

1. Open a shell on the machine: `fly ssh console --app paymentmentgateway`
2. List what exists: `node backup.js list`
3. Check one first (optional): `node backup.js verify zanboxx/slot-03.db.gz.enc`
4. Stage the one you want: `node backup.js restore zanboxx/slot-03.db.gz.enc` (or a local file such as `/data/backups/zanboxx-....db`).
5. Leave the shell and restart the machine: `fly machine restart <machine-id> --app paymentmentgateway`. At start-up the current database is moved aside as `zanboxx.db.before-restore-<time>` and the backup takes its place.

If the shell does not show your secrets, run `printenv | grep -E "AWS|BUCKET|BACKUP"` first; the restore needs `BACKUP_PASSPHRASE` and the storage settings.

### Also on by default

Fly takes a daily snapshot of the volume (`fly volumes snapshots list --app paymentmentgateway`) and keeps it for a few days. That is a second, independent safety net.

### Limits of this setup

One machine and one volume: if the machine is down, the site is down until it comes back. The database is fine up to many thousands of accounts. If you later need several machines, move to a hosted PostgreSQL; the storage code is in one file (`store.js`) for that reason.
