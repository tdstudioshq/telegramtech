# Deployment (Railway) — M6

Production runtime: one Railway service (Node 22, Nixpacks), **single replica**, webhook mode, health-gated. Postgres + Storage stay on Supabase.

## Why a single replica (do not scale horizontally yet)

`MemoryCacheProvider` is per-process: it backs per-user rate limits and the advisory job locks (debt #1, #5). A second replica would split rate-limit counters and let two schedulers run the same sweep concurrently. The sweeps are idempotent so correctness holds, but rate limiting would weaken. `railway.json` pins `numReplicas: 1`. Repaying debt #1 (RedisCacheProvider) is the trigger to scale out.

## One-time provisioning

1. **Supabase** (already done for dev — repeat for a prod project if separating envs): private `drops` bucket; capture `DATABASE_URL` (pooler :6543), `DATABASE_DIRECT_URL` (:5432), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. See `SETUP.md`.
2. **Bot token**: a dedicated **production** bot from @BotFather (never the dev token).
3. **Webhook secret**: generate a random token, e.g. `openssl rand -hex 32`.
4. **Railway**: create a project from the GitHub repo. Railway reads `railway.json` (build = Nixpacks, start = `pnpm start`, healthcheck = `/health`) and `.nvmrc` (Node 22).

## Environment variables (Railway → Variables)

Set every key from `.env.example`. Production-specific:

| Key | Production value |
|---|---|
| `NODE_ENV` | `production` (enforced: requires `BOT_MODE=webhook`) |
| `LOG_LEVEL` | `info` |
| `BOT_MODE` | `webhook` |
| `WEBHOOK_URL` | `https://<app>.up.railway.app/telegram/webhook` (use the Railway domain; distinct path from `/health`) |
| `WEBHOOK_SECRET_TOKEN` | the random secret from step 3 |
| `PORT` | injected by Railway — do not hardcode |
| `BOT_TOKEN` / `DATABASE_*` / `SUPABASE_*` | production secrets |
| `MOCK_PAYMENT_FAILURE_RATE` | `0` in production |

Secrets live only in Railway; never commit them. `process.env` is read only in `config/env.ts` — a missing/invalid key crashes at boot with the exact offending key.

## Database migrations (manual — never auto-applied)

Migrations are **human-reviewed and applied out of band**, not in `startCommand` (project rule; a migration is a stop point). After the SQL in `src/adapters/persistence/db/migrations/` is reviewed:

```bash
DATABASE_DIRECT_URL=<prod direct :5432> pnpm db:migrate   # applies reviewed migrations
DATABASE_URL=<prod pooler :6543>       pnpm db:seed        # idempotent; first deploy only
```

Run these before/independently of the deploy that expects the new schema.

## Deploy

1. Push to the deploy branch → Railway builds (`pnpm build`) and starts (`pnpm start`).
2. Boot logs a secret-free config summary, then `database reachable`, `http server listening`, `webhook registered — accepting updates`.
3. Railway probes `GET /health` until 200; the deploy goes live only when healthy. A `503` (DB unreachable) fails the deploy / restarts the instance (`restartPolicyType: ON_FAILURE`, up to 10 retries).
4. Verify: `curl https://<app>.up.railway.app/health` → `{"status":"ok","version":"0.1.0-mvp","checks":{"database":"ok"},...}`.

## Health endpoint

`GET /health` → `200 {status:"ok"}` when the DB round-trips, `503 {status:"degraded"}` otherwise. `HEAD` allowed; other methods `405`. Any other path `404`. It is unauthenticated and safe to expose (no secrets, no tenant data).

## Rollback

Railway → Deployments → pick the last-good deployment → **Redeploy**. Because migrations are applied out of band, a code rollback never fights the schema; if a rollback crosses a migration boundary, roll the schema decision separately (see the reviewed migration). The webhook re-registers itself on the next boot.

## Graceful shutdown

`SIGTERM`/`SIGINT` (Railway sends `SIGTERM` on redeploy) → stop the HTTP server (stop accepting updates) → best-effort `deleteWebhook` → drain in-flight jobs → close the pool → exit. A 10s watchdog force-exits if shutdown hangs. `uncaughtException`/`unhandledRejection` are logged `fatal` and trigger the same shutdown with exit code 1.

## M7.4 — Redis + horizontal scaling (deploy procedure)

Railway **auto-deploy is OFF** — pushing `main` does not deploy. Trigger a deploy of the latest `main` commit with `railway redeploy --from-source -y`.

Ordered rollout (learned during the M7.4.1 production rollout; order matters):

1. **Migrations first.** Apply `0005`/`0006` to the shared Supabase (`DATABASE_DIRECT_URL=<direct url> pnpm db:migrate`) **before** deploying the new code. `0005` is a constraint replacement — pre-check `SELECT user_id,creator_id,count(*) FROM subscriptions WHERE status='active' GROUP BY 1,2 HAVING count(*)>1` returns zero rows first.
2. **Deploy the code on the DEFAULT (memory) cache.** Do NOT set `CACHE_PROVIDER=redis` yet — older builds throw on `redis` and would crash-loop on restart. Deploy, confirm `/health`→`0.2.x`.
3. **Provision Redis:** `railway add --database redis` (creates a `Redis` service).
4. **Engage Redis:** set on the app service `CACHE_PROVIDER=redis` and `REDIS_URL=${{Redis.REDIS_URL}}` (private internal URL). This redeploys; if the reference is wrong, env validation fails the *new* deploy and the current build keeps serving (safe). Confirm rate limiting still 429s (Redis counters live; a broken Redis fails **open**).
5. **Scale:** set `railway.json` `numReplicas: 2`, push, `railway redeploy --from-source`. **Never raise `numReplicas` before Redis is engaged** (per-replica memory cache reintroduces N× rate limits, stranded notifications, duplicate locks).

Multi-replica notes: every replica registers the same shared webhook on boot; `registerTelegramWebhook` retries on Telegram 429 and is non-fatal (the webhook is shared/persistent). Scheduled jobs run on every replica but are gated by the Redis distributed lock and are idempotent (status-guarded sweeps + atomic shared-queue drain), so there are no duplicate *effects*.
