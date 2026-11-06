# Releasing Zanboxx

Every push and pull request runs CI: smoke tests, an image check (rebuilds the Dockerfile file layout, boots the server, requests 16 pages), the browser UI test, secret scanning (gitleaks) and CodeQL. A red check means do not release.

## Ship a release
```
git tag v0.4.0
git push origin v0.4.0
```
The Release workflow then: runs tests, deploys to staging, verifies it, waits for your approval, deploys to production, verifies https://zanboxx.com, and rolls back to the previous image by itself if verification fails.

## Roll back by hand
- GitHub: Actions > Rollback > Run workflow. Run once with the image empty to list recent images in the log, then run again with the image to restore.
- Terminal: `fly releases --app paymentmentgateway --image` then `fly deploy --app paymentmentgateway --image <image> --ha=false`

## One-time setup
1. Staging app and volume:
   ```
   fly apps create zanboxx-staging
   fly volumes create dryrun_data --app zanboxx-staging --region ams --size 1
   fly secrets set --app zanboxx-staging ADMIN_TOKEN=<throwaway value>
   ```
   Staging uses its own data. Do not give it production secrets (Stripe live, backup passphrase).
2. Deploy tokens (one per app, so staging cannot touch production):
   ```
   fly tokens create deploy --app zanboxx-staging
   fly tokens create deploy --app paymentmentgateway
   ```
   Add them in GitHub > Settings > Secrets and variables > Actions as `FLY_API_TOKEN_STAGING` and `FLY_API_TOKEN_PRODUCTION`. Do not paste them anywhere else.
3. GitHub > Settings > Environments: create `staging`, and `production` with yourself as required reviewer.
4. Optional: branch protection on main requiring the CI checks.

## Before adding files
The Dockerfile copies files by name. Add any new top-level .js file to the COPY line; `npm run check:image` fails if you forget.

## Run locally
`npm test`, `npm run check:image`, and `npm i --no-save playwright && npx playwright install chromium && npm run test:ui`.
