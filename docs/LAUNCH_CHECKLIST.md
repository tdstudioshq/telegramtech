# Launch checklist & security review — M6

Gate for tagging `v0.1.0-mvp`. Pair with `DEPLOYMENT.md`.

## Final security review

| Area | Control | Status |
|---|---|---|
| Secrets in code | `process.env` read only in `config/env.ts`; boundary lint fails otherwise. `.env` gitignored; prod secrets only in Railway. | ✅ |
| Secret redaction | Pino redacts `token`/`botToken`/`secret`/`secretToken`/`password`/`apiKey`/`serviceRoleKey`/`authorization`. Startup summary is a hand-picked, secret-free allowlist; raw env is never logged. | ✅ |
| Env safety | Zod parse-or-crash prints exact offending keys and exits 1 — nothing connects on bad config. Production requires `BOT_MODE=webhook`. | ✅ |
| Webhook auth | `WEBHOOK_SECRET_TOKEN` set on `setWebhook` and verified by telegraf on every update; server starts listening before `setWebhook`. | ✅ |
| Transport | Railway terminates TLS; webhook URL is HTTPS. Content moves only via short-lived server-signed URLs from a **private** bucket; the service-role key is used only by the storage adapter. | ✅ |
| Input validation | Every inbound Telegram payload is Zod-validated at the handler boundary; callback data is parsed, not trusted. | ✅ |
| Rate limiting | **Two channels, both via CacheProvider.** Telegram: per-user limiter (`RATE_LIMIT_POINTS`/`WINDOW`). JSON API (M7.3.1): per-IP (+per-email) on `login`/`register` before scrypt runs (`API_AUTH_RATE_LIMIT_*`), per-IP on public marketplace reads (`API_PUBLIC_RATE_LIMIT_*`), and per-creator over all authenticated routes incl. uploads (`API_RATE_LIMIT_*`), returning 429 + `Retry-After`. Client IP is the rightmost `X-Forwarded-For` hop (validated as an IP) per `API_TRUSTED_PROXY_HOPS=1` (Railway edge), so a spoofed leftmost XFF can't mint a fresh bucket. Per-process (single replica) — debt #1. | ✅ |
| Tenancy | `creator_id` on every tenant-owned row; repositories always filter by it. RLS deferred (debt #2) — interim safety = both channels route only through tenant-filtering core services. | ✅ (MVP) |
| Money integrity | Integer Stars only; every money/access mutation writes an audit row in the same transaction; events dispatch only after commit. One active subscription per creator is DB-enforced (M7.3.1) — concurrent distinct-plan subscribes cannot double-charge. | ✅ |
| SQL | Drizzle parameterized queries only; the one jsonb merge is a bound param, never interpolated. Pooler runs `prepare:false`. | ✅ |
| Health endpoint | Unauthenticated but exposes no secrets/tenant data (status, version, uptime, db ok/error). | ✅ |
| Error surface | `Result<T, AppError>` → user-safe messages; internals logged, never sent to users. | ✅ |
| DoS / abuse | Rate limiters on both channels (Telegram + API, M7.3.1). **Authenticated dashboard uploads exist** (per-drop media, 25 MB cap, streaming size enforcement) — gated by ownership checks + the per-creator API limiter; not open to anonymous users. | ✅ |

**No blocking security findings.** Accepted, documented risks: per-process cache (debt #1), no RLS (debt #2), non-durable in-process events (debt #6), mock payments at launch (Q4 / MVP posture — no real Stars charged).

## Pre-deploy

- [ ] Migrations reviewed and applied to prod DB (`pnpm db:migrate`), seed run once (`pnpm db:seed`).
- [ ] Private `drops` bucket exists in the prod Supabase project.
- [ ] Production bot token (not dev) set; dev webhook cleared if reusing a bot.
- [ ] All Railway variables set; `NODE_ENV=production`, `BOT_MODE=webhook`, `LOG_LEVEL=info`, `MOCK_PAYMENT_FAILURE_RATE=0`.
- [ ] `WEBHOOK_URL` path differs from `/health`; `WEBHOOK_SECRET_TOKEN` is a fresh random value.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` green; `pnpm test:integration` green against a throwaway Postgres.

## Post-deploy smoke (manual QA — the MVP definition of done)

- [ ] `curl /health` → 200 `{status:"ok"}`.
- [ ] `/start` registers a fresh user (audit `user.registered`).
- [ ] `/browse` lists free / premium / pay-per-unlock drops with correct badges.
- [ ] Free drop delivers immediately.
- [ ] Pay-per-unlock: `/unlock` → mock purchase → protected content delivered; audit + `ContentUnlocked` fire.
- [ ] Forced failure (`MOCK_PAYMENT_FAILURE_RATE=1` on a scratch deploy): failure message, no charge, retry works; `PaymentFailed` notification arrives on the next notification-job tick.
- [ ] `/subscribe` → Premium active → premium drops accessible.
- [ ] Expiry: advance a plan's `expires_at` in the DB; the sweep flips it to expired within the interval; premium access goes false; a renew notification is delivered.
- [ ] Cleanup: a stranded pending payment is failed within the cleanup interval (audit `payment.failed` actor `job`).
- [ ] Logs are structured JSON with correlation ids; no secrets present.

## Go / no-go

- [ ] Health green, webhook receiving updates, jobs ticking (see `job metric` logs).
- [ ] Rollback path confirmed (last-good deploy redeployable).
- [ ] Tag `v0.1.0-mvp` after sign-off.
