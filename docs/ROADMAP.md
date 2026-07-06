# Roadmap (Revision 2)

## Milestones

### M0 — Foundation & revision ✅
- [x] Session 1 architecture + Session 2 revision (platform-centric, ports for payment/content/cache, domain events, jobs layer, multi-tenant schema)
- [x] **Gate: Tyler approves revised schema (DATABASE.md rev 2) + SYSTEM_ARCHITECTURE.md** — approved 2026-07-04

### M1 — Skeleton, config, CI (Q5: CI immediately) ✅ (Session 3, 2026-07-04)
- [x] Repo scaffold: strict tsconfig, ESLint (incl. `import/no-restricted-paths` boundary rules), Prettier, Vitest, pnpm
- [x] `.github/workflows/ci.yml`: typecheck + lint + unit tests on push/PR
- [x] `config/env.ts` Zod parse-or-crash (+ tests) · Pino logger + redaction · `shared/` Result, AppError, domain types
- [x] Domain event dispatcher (+ tests: after-commit ordering, handler isolation)

### M2 — Data layer ✅ (Session 4; dev Supabase applied + seeded 2026-07-04)
- [x] Drizzle schema exactly per DATABASE.md rev 2.2 → generate migration → **stop for review** ✅ → migration review **approved 2026-07-04** → apply: ✅ validated on local Postgres 17 (Docker) · ✅ applied + seeded on dev Supabase (Tyler ran db:migrate/db:seed; closeout verified)
- [x] Unit-of-work/tx helper · repositories + integration tests (idempotency unique, one-active-sub, one-live-grant, entitlement predicate) — 13 integration tests green vs local PG17
- [x] Idempotent seed: creator, one Premium plan, drops of all three access types, settings (re-run proven a no-op by test)

### M3 — Ports, providers, core services ✅ (Session 5, 2026-07-04)
- [x] Ports: PaymentProvider, ContentProvider, ContentTransport, CacheProvider, Notifier, Clock
- [x] MockPaymentProvider (delay + failure rate, Q4) · SupabaseStorageProvider (private bucket, signed URLs) · MemoryCacheProvider + Noop
- [x] User/Creator/Drop/Access services (+ unit tests incl. all three access types)
- [x] PurchaseService state machine + events (+ failure-path tests) · SubscriptionService (subscribe/renew/expireLapsed, fake clock)
- [x] AuditService in-transaction; event handlers (notification intents, audit enrichment, analytics no-op)
- [x] Also delivered (core-layer completeness): DeliveryEngine + NotificationEngine (§1 engines — port-only, unit-tested; Telegram transport/notifier remain M4)

### M4 — Telegram adapter ✅ (Session 6, 2026-07-04)
- [x] Telegraf factory (polling/webhook mode from config) · middleware chain (correlation→log→rate-limit(CacheProvider)→auth→error)
- [x] /start /help /browse (access-type badges + pagination) /unlock /subscribe /my_access · detail callback flow
- [x] Unlock + subscribe callbacks · TelegramContentTransport (signed-URL upload, protect_content, tenant-scoped transport_cache write-back) · TelegramNotifier
- [x] Composition root (`app.ts`) + boot/shutdown (`index.ts`) · 142 unit + 21 integration tests · typecheck/lint/build green

### M5 — Jobs & lifecycle ✅ (Session 7, 2026-07-04)
- [x] scheduler.ts (intervals, per-job cache lock, crash isolation, per-run correlation id, run metrics hook + structured logs, graceful start/stop awaiting in-flight)
- [x] subscription-expiration.job · notification.job (drain + blocked-user handling → users.is_blocked) · cleanup.job (stale pending payments → failed via new PurchaseService.failStalePending) · analytics.job no-op registration
- [x] Wired in app.ts (scheduler starts before the blocking bot.launch, stops before pool close); 161 unit + 25 integration tests · typecheck/lint/build green
- [ ] Deferred (debt #13): cleanup.job orphaned-storage / transport_cache pruning — needs a ContentProvider list capability + expiry metadata (schema/port change, out of M5 scope)

### M6 — Hardening & deploy ✅ (Session 8, 2026-07-04)
- [x] Production boot: fail-fast DB ping, secret-free startup diagnostics, structured logging, graceful shutdown (force-timeout, uncaught/unhandled handlers)
- [x] Health endpoint (`GET /health`, DB liveness → 200/503) on a single HTTP server shared with the webhook route; webhook mode + polling-disabled-in-production enforced by env validation (ADR-020)
- [x] Railway config (`railway.json`, single replica, healthcheck-gated), `docs/DEPLOYMENT.md`, `docs/LAUNCH_CHECKLIST.md` (security review + manual QA), monitoring hook (`loggingJobMetrics`)
- [x] Verified: 172 unit + 25 integration + compiled-artifact e2e (health 200/404/503, env parse-or-crash, prod-webhook enforcement, full boot sequence); typecheck/lint/build green
- [ ] Remaining (owner action): apply prod migrations, set Railway secrets, deploy + smoke per LAUNCH_CHECKLIST, tag `v0.1.0-mvp`

**MVP definition of done:** fresh user registers, browses free/premium/pay-per-unlock drops, mock-purchases an unlock (including a forced failure retry), receives storage-backed protected content, buys Premium, accesses premium drops, is expired by the sweep, gets a renew notification — all audited, all events firing, zero business logic in the adapter.

### M7 — Platform evolution (adoption-first; governed by the M7 plan trio in docs/)

> Post-MVP. Milestone order and scope live in `M7_IMPLEMENTATION_PLAN.md` / `M7_PLATFORM_EVOLUTION_PLAN.md` / `M7_CURRENT_STATE_AUDIT.md`. Migrations are additive + human-reviewed; RLS activation is its own reviewed step.

### M7.0 — Multi-creator routing (shared bot) ✅ COMPLETE (committed 2026-07-05, validated by Tyler 2026-07-06)
- [x] `creators.slug` (migration `0001`) + `follows` (migration `0004`); backfill/uniqueness per plan
- [x] `CreatorResolver` + creator-context middleware at the Telegram edge; `/start` deep-link payload parsed; `SEED_IDS` single-creator pin removed (repays debt #11)
- [x] `CreatorService.findBySlug`/`listActive`; `FollowRepository`
- [x] Human validation (test suite + multi-creator isolation)

### M7.1 — Creator dashboard (API surface) ✅ COMPLETE (committed 2026-07-05, validated by Tyler 2026-07-06)
- [x] REST/JSON adapter `src/adapters/api/` mounted on the M6 `HttpServer` (auth, me, profile, content drops/assets/publish, plans, analytics, onboarding, public marketplace) — routes only, calls core services
- [x] `AuthService` + ports `PasswordHasher` (scrypt) / `SessionTokenService` (opaque bearer, SHA-256 at rest); `creator_identities` (migration `0002`); `creators.user_id` nullable
- [x] Human validation
- [ ] **Web frontend NOT in this repo** — API/backend only; the Next.js dashboard the plan calls for is absent (open follow-up)
- [ ] Managed-auth recommendation (Supabase Auth/Clerk) NOT taken — hand-rolled behind ports instead; accepted deviation to confirm
- [ ] **RLS not activated** though the dashboard/API is now a live non-bot client (trips debt #2) — schedule ADR-025

### M7.2 — Creator onboarding ✅ COMPLETE (committed 2026-07-05, validated by Tyler 2026-07-06)
- [x] `onboarding.service.ts`; `/api/onboarding` + `/complete`; `creators.onboarding_completed_at` (migration `0003`); `pending → active`
- [x] Human validation
- [ ] Onboarding UI (depends on the absent M7.1 frontend — open follow-up)

### M7.3 — Marketplace / discovery ✅ COMPLETE (committed 2026-07-05, validated by Tyler 2026-07-06)
- [x] `discovery.service.ts` + `follow.service.ts`; public marketplace/search API routes (creators/featured/categories/profile)
- [x] Bot-side `/discover`/`/search`/`/follow` commands
- [x] Search indexes (pg_trgm/GIN) + human validation

### M7.4–M7.8 — Redis/scale · real Stars + payouts · admin/ops · dedicated bots · public API/channels
- [ ] Not started. **M7.4 (Redis + horizontal scaling) is the next undelivered milestone** — plan → Tyler approval → build, per the project's per-milestone rhythm.

## Technical debt register

| # | Debt | Trigger to repay |
|---|---|---|
| 1 | MemoryCacheProvider is per-process (rate limits, locks) | Second instance → RedisCacheProvider |
| 2 | No RLS (still `isRLSEnabled: false` on all tables) | **TRIGGER TRIPPED 2026-07-05** — dashboard/API (`src/adapters/api/`) is now a live non-bot client. Interim safety = API routes only via tenant-filtering core services. Activate `creator_id` RLS (ADR-025) as defense-in-depth — schedule before write-heavy dashboard use / public API. |
| 3 | Long-polling | Before real Stars → webhook + secret token |
| 4 | Settings cached at boot | Dashboard live-edit requirement |
| 5 | In-process scheduler, lock is advisory | Multi-instance → Redis locks or pg_cron |
| 6 | Domain events not durable (post-commit crash loses side effect) | External consumers/payouts → outbox table behind same dispatcher |
| 7 | No auto-renew | Real Stars native subscriptions |
| 8 | transport_cache invalidation is wipe-and-rebuild only | Fine indefinitely; revisit at multi-bot |
| 9 | Refund: schema+port ready, no service path/UX | First real-money dispute |
| 10 | CI runs unit tests only | Add test-DB workflow when repo settles (M2–M3) |
| 11 | ~~Single-creator UX in bot (core is multi-tenant)~~ | **REPAID by M7.0** (slug deep-link routing + CreatorResolver; committed 2026-07-05, validated 2026-07-06). |
| 12 | Manual QA, no e2e bot tests | Post-MVP if regressions bite |
| 13 | cleanup.job does not prune orphaned storage / stale transport_cache (log-only stub) | ContentProvider gains a bucket-list capability + assets carry cache expiry metadata (schema/port change) |

## Future integrations (not now)
_Status note: the REST API + creator-dashboard backend and multi-creator routing below shipped under M7.0–M7.3 (committed 2026-07-05, validated 2026-07-06); the rest of this list remains future._

Real Telegram Stars provider (same port; pre_checkout + successful_payment + refund + 21-day payout awareness) · Creator web dashboard (workspace package sharing core; triggers RLS + settings hot-reload) · Lumina integration (client adapter on core services) · REST API · Stripe/fiat provider · R2/S3 content adapters · Redis · outbox events · analytics (job slot + PurchaseCompleted handler already reserved) · gifting/comps (manual grants already modeled).
