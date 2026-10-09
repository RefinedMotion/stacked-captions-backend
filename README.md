# Stacked Captions — Backend (Phase 4a)

Cloudflare Worker + D1 database. Issues signed tokens to plugin installs,
proxies AI calls to Anthropic, will receive Lemon Squeezy subscription
webhooks in Phase 4c.

## Endpoints

| Method | Path                          | Auth                       | Purpose                          |
|--------|-------------------------------|----------------------------|----------------------------------|
| POST   | `/v1/activate`                | License key + fingerprint  | First-time machine activation    |
| POST   | `/v1/heartbeat`               | License key + fingerprint  | Re-validate + refresh token      |
| POST   | `/v1/ai-apply`                | Signed token from activate | Proxy to Anthropic               |
| POST   | `/v1/admin/create-license`    | `Authorization: Bearer …`  | Dev/admin: manually mint license |
| POST   | `/v1/machines`                | License key (+ fingerprint) | Machines using a license (display ids) |
| POST   | `/v1/deactivate`              | License key (+ fingerprint) | Free a machine slot (own or by row id) |
| POST   | `/v1/admin/remove-machine`    | `Authorization: Bearer …`  | Admin: free a customer's slot    |
| POST   | `/v1/admin/set-license-status`| `Authorization: Bearer …`  | Admin: correct a license status  |
| POST   | `/v1/webhooks/lemon-squeezy`  | HMAC signature             | Lemon Squeezy subscription events |
| GET    | `/`                           | none                       | Health check                     |

## Local setup (Windows PowerShell)

### 1. Install Node.js LTS

If you don't have it yet: https://nodejs.org → LTS installer. Verify:

```powershell
node --version   # should be v18 or higher
npm --version
```

### 2. Install dependencies

```powershell
npm install
```

This also installs `wrangler` (Cloudflare's CLI) locally.

### 3. Log in to Cloudflare

```powershell
npx wrangler login
```

Browser opens → authorize → done.

### 4. Create the D1 database

```powershell
npx wrangler d1 create stacked-captions-db
```

This prints something like:

```
✅ Successfully created DB 'stacked-captions-db'
[[d1_databases]]
binding       = "DB"
database_name = "stacked-captions-db"
database_id   = "abcdef12-3456-7890-abcd-1234567890ab"
```

**Copy that `database_id`** and paste it into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_DB_ID_FROM_STEP_5`.

### 5. Apply the schema (locally + remote)

Local (for `wrangler dev`):

```powershell
npm run db:init-local
```

Remote (the actual D1 in production):

```powershell
npm run db:init
```

### 6. Set up local secrets

```powershell
Copy-Item .dev.vars.example .dev.vars
```

Open `.dev.vars` and fill in:

- `TOKEN_SECRET` — any long random string (≥32 chars). Generate one:
  ```powershell
  -join ((1..64) | ForEach-Object { [char](Get-Random -Min 33 -Max 126) })
  ```
- `ADMIN_TOKEN` — same idea, different value.
- `ANTHROPIC_API_KEY` — your existing key from console.anthropic.com.

### 7. Run locally

```powershell
npm run dev
```

Worker listens on **http://localhost:8787**. Hit it:

```powershell
curl.exe http://localhost:8787/
```

Should return `{"ok":true,"name":"stacked-captions-api",...}`.

## Test flow (PowerShell with curl.exe)

> Use **`curl.exe`** explicitly on Windows — `curl` is aliased to
> `Invoke-WebRequest` in PowerShell and has different syntax.

### Create a test license

```powershell
$admin = "your-admin-token-from-.dev.vars"

curl.exe -X POST http://localhost:8787/v1/admin/create-license `
  -H "Authorization: Bearer $admin" `
  -H "Content-Type: application/json" `
  -d '{\"email\":\"test@example.com\",\"plan\":\"monthly\",\"days\":30}'
```

Response:
```json
{ "ok": true, "licenseKey": "SC-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX", "plan": "monthly", "expiresAt": ... }
```

### Activate a machine

```powershell
$key = "SC-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"

curl.exe -X POST http://localhost:8787/v1/activate `
  -H "Content-Type: application/json" `
  -d "{\"licenseKey\":\"$key\",\"fingerprint\":\"test-machine-1\",\"os\":\"windows\",\"appVersion\":\"0.9\"}"
```

Response includes a `token` — save it.

### Heartbeat

```powershell
curl.exe -X POST http://localhost:8787/v1/heartbeat `
  -H "Content-Type: application/json" `
  -d "{\"licenseKey\":\"$key\",\"fingerprint\":\"test-machine-1\"}"
```

### AI proxy

```powershell
$token = "<token from activate response>"

curl.exe -X POST http://localhost:8787/v1/ai-apply `
  -H "Content-Type: application/json" `
  -d "{\"token\":\"$token\",\"system\":\"Antworte mit exakt 'OK'.\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":16}"
```

Should return Anthropic's response (~"OK").

### Verify caps

Try activating a 3rd machine with the same key (machines_allowed defaults to 2):

```powershell
curl.exe -X POST http://localhost:8787/v1/activate `
  -H "Content-Type: application/json" `
  -d "{\"licenseKey\":\"$key\",\"fingerprint\":\"test-machine-2\"}"
# OK

curl.exe -X POST http://localhost:8787/v1/activate `
  -H "Content-Type: application/json" `
  -d "{\"licenseKey\":\"$key\",\"fingerprint\":\"test-machine-3\"}"
# → 403 "machine limit reached"
```

## Deploy to production

When local testing passes:

```powershell
# Set production secrets (interactive — paste values when prompted)
npx wrangler secret put TOKEN_SECRET
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY

# Deploy
npm run deploy
```

The Worker becomes available at `https://stacked-captions-api.<your-cf-subdomain>.workers.dev`.
We'll point a custom domain at it later (e.g. `api.stackedcaptions.com`).

## What this does NOT do yet (later phases)

- ❌ Lemon Squeezy webhook integration (Phase 4c)
- ❌ Token rate-limiting per license (Phase 4c)
- ✅ Self-service machine-slot release (2026-10, panel v1.1.0): see "Machine slots" below
- ❌ Plugin-side: license-key UI + token caching + AI calls routed through proxy (Phase 4b)

## Machine slots (2026-10, panel v1.1.0)

Each license runs on `machines_allowed` (default 2) machines = rows in `machines`.
Since 2026-10 a slot can be released without support:

- `POST /v1/machines` `{ licenseKey, fingerprint? }` -> the machines of a license
  (`id`, `displayId` = first 8 hex of SHA-256(fingerprint) — the raw fingerprint is
  never returned, with the key it would let a third computer impersonate a
  registered one on /v1/heartbeat —, `os`, `appVersion`, `firstSeenAt`,
  `lastSeenAt`, `current` = the calling machine). The key is the credential;
  works for expired licenses too (tidying up is always allowed).
- `POST /v1/deactivate` `{ licenseKey, fingerprint?, machineId? }` -> releases the
  calling machine's slot (panel "Sign out") or another machine by row id (panel
  "Manage machines" / the machine-limit notice). Idempotent (`removed: 0|1`),
  logs `machine_deactivated` (`reason: self_service`).
- `/v1/activate` at the limit: the longest-idle machine yields its slot when it
  has not been seen for 30 days (`machine_deactivated`, `reason: idle_evicted`);
  otherwise the 403 carries `machines: [...]` so the panel can offer
  "Sign out & activate here".
- Admin: `POST /v1/admin/remove-machine` `{ licenseKey, machineId? | displayId? | fingerprint? }`
  (display id as the panel shows it, or a unique fingerprint prefix) -> `admin-remove-machine.ps1`.
  `customer-detail` prints both ids per machine.
- Admin: `POST /v1/admin/set-license-status` `{ licenseKey, status, reason? }` ->
  used by `admin-sync-unpaid.ps1` (dry run by default, `-Apply` retires the
  `past_due` licenses whose Lemon Squeezy subscription is `unpaid`/`expired`/ended).
  The webhook now maps LS `unpaid` -> `expired` (a later `subscription_payment_success`
  reactivates). Fixed in the same round: the payment events carry a
  Subscription INVOICE, so the subscription id is read from
  `attributes.subscription_id` (before, `data.id` = the invoice id never matched a
  license — renewals only worked through the parallel `subscription_updated`), and
  a late `subscription_payment_failed` no longer revives an expired license.

Tests: `npm test` (`test/run.mjs`) runs the real Hono app on an in-memory SQLite
that mimics D1 (node:sqlite, Node 22.5+): activate / limit / list / release /
eviction / admin / webhook (invoice-shaped payment events) / status sync.
