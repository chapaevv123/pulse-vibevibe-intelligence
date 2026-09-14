# Deployment — exact commands (NOT executed by this task)

This package is prepared but **not deployed**. Nothing below has been run.
Run these from inside `public_vibe_demo/` yourself, in order, once you've
reviewed the code and the Free-tier audit.

## 1. Install dependencies

```
npm install
```

## 2. Authenticate with Cloudflare (no credentials committed to the repo)

```
npx wrangler login
```

This opens a browser OAuth flow. It never writes a token into this
repository — Wrangler stores it in your local Cloudflare config directory,
outside the project.

## 3. Create the D1 database

```
npx wrangler d1 create pulse-vibe-demo
```

Copy the `database_id` from the output into `wrangler.jsonc` →
`d1_databases[0].database_id` (currently the placeholder
`REPLACE_WITH_D1_DATABASE_ID`).

## 4. Apply the schema

```
npx wrangler d1 migrations apply pulse-vibe-demo --remote
```

(Use `--local` first if you want to test against a local D1 emulator via
`npx wrangler dev` before touching the remote database.)

## 5. Local smoke test (optional but recommended)

```
npx wrangler dev
```

Visit the printed `http://localhost:8787` URL. The dashboard will show an
empty feed and `OWN PROJECT — NOT_YET_LAUNCHED` until a sync has run — you
can trigger one manually against the local dev D1 with:

```
curl -X POST http://localhost:8787/__scheduled?cron=*
```

(`wrangler dev` exposes this scaffolding-only test route for scheduled
handlers; it is not present in the deployed Worker.)

## 6. Deploy the Worker

```
npx wrangler deploy
```

Wrangler prints the live `*.workers.dev` URL on success.

## 7. Enable the cron trigger (separate, explicit step)

`wrangler.jsonc` ships with `"triggers": { "crons": [] }` — **sync does not
run automatically until you add a schedule and redeploy.** Per
`docs/FREE_TIER_AUDIT.md`, the recommended cadence is every 10 minutes:

```jsonc
"triggers": { "crons": ["*/10 * * * *"] }
```

Edit `wrangler.jsonc`, then re-run `npx wrangler deploy`.

## 8. Verify

```
curl https://pulse-vibevibe-intelligence.<your-subdomain>.workers.dev/api/health
```

Expect `{"ok": true, "d1": "OK", "last_sync_status": "NEVER_RUN", ...}`
immediately after deploy, before the first cron tick has fired.

---

## GitHub publishing — exact commands (also not executed)

```
cd public_vibe_demo
git init
git add .
git commit -m "Initial public release: Pulse Intelligence x vibe/vibe demo"
gh repo create pulse-vibevibe-intelligence --public --source=. --remote=origin
git push -u origin main
```

Review `git status` and the diff before the first commit — confirm nothing
outside `public_vibe_demo/` was accidentally staged, and that no `.env`,
`.dev.vars`, or `.wrangler/` content is included (`.gitignore` already
excludes these).

## Expected permanent URL pattern

```
https://pulse-vibevibe-intelligence.<your-cloudflare-subdomain>.workers.dev
```

(A custom domain can be attached later via Cloudflare's dashboard; not
required for a permanent Builder Season demo link.)
