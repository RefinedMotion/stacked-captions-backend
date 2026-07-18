# Stacked Captions — Backend (restore guide)

This repo is the **Cloudflare Worker + D1 backend** for the Stacked Captions AE
plugin: license activation, Lemon Squeezy billing webhooks, the Anthropic/
ElevenLabs AI proxy, update endpoints, and the per-license token budget.

## Where it lives
- **Local path:** `C:\Users\Philipp Kies\stacked-captions-backend`
- **Deploys to:** Cloudflare Worker `stacked-captions-api` → `https://api.refinedmotion.de`
- **Database:** Cloudflare D1 `stacked-captions-db` (id `7ae1a0b4-8bca-4c27-9bf8-8aa02526f9b8`)

## What is NOT in this repo (by design)
Secrets are never committed. The following are gitignored and must be recreated:
- `.dev.vars` — local dev secrets. Recreate from `.dev.vars.example`; real values
  live in **Cloudflare** (set via `npx wrangler secret put <NAME>`) and/or your
  password manager: `TOKEN_SECRET`, `ADMIN_TOKEN`, `ANTHROPIC_API_KEY`,
  `ELEVENLABS_API_KEY`, `LS_WEBHOOK_SECRET`, `RESEND_API_KEY`, `GITHUB_TOKEN`.
- `node_modules/`, `.wrangler/`, `body.json` (local test payload).

## Restore on a fresh machine
1. `git clone` this repo into `stacked-captions-backend`.
2. `npm install`
3. `npx wrangler login` (authenticate as `mail@refinedmotion.de`).
4. Recreate `.dev.vars` from `.dev.vars.example` for local runs. Production
   secrets are already in Cloudflare — only re-`wrangler secret put` if they were lost.
5. Deploy: `npx wrangler deploy`. Migrations live in `schema/` (run with
   `npx wrangler d1 execute stacked-captions-db --remote --file schema/<file>.sql`).

## Backup
Auto-pushed by the Claude Code backup hook after each session. See the master
guide **BACKUP-AND-RESTORE.md** in the `stacked-captions-notes` repo.
