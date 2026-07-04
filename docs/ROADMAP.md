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

### M2 — Data layer (Session 4 — code complete; Supabase apply blocked on credentials)
- [ ] Drizzle schema exactly per DATABASE.md rev 2.2 → generate migration → **stop for review** ✅ → migration review **approved 2026-07-04** → apply: ✅ validated on local Postgres 17 (Docker) · ⬜ dev Supabase apply blocked — needs DATABASE_DIRECT_URL (db password) in .env
- [x] Unit-of-work/tx helper · repositories + integration tests (idempotency unique, one-active-sub, one-live-grant, entitlement predicate) — 13 integration tests green vs local PG17
- [x] Idempotent seed: creator, one Premium plan, drops of all three access types, settings (re-run proven a no-op by test)

### M3 — Ports, providers, core services
- [ ] Ports: PaymentProvider, ContentProvider, ContentTransport, CacheProvider, Notifier, Clock
- [ ] MockPaymentProvider (delay + failure rate, Q4) · SupabaseStorageProvider (private bucket, signed URLs) · MemoryCacheProvider + Noop
- [ ] User/Creator/Drop/Access services (+ unit tests incl. all three access types)
- [ ] PurchaseService state machine + events (+ failure-path tests) · SubscriptionService (subscribe/renew/expireLapsed, fake clock)
- [ ] AuditService in-transaction; event handlers (notification intents, audit enrichment, analytics no-op)

### M4 — Telegram adapter
- [ ] Telegraf factory (mode from config) · middleware chain (correlation→log→rate-limit(CacheProvider)→auth→error)
- [ ] /start /help /drops (browse w/ access-type badges + pagination) /library /premium
- [ ] Unlock + subscribe callback flows · TelegramContentTransport (signed-URL upload, protect_content, transport_cache write-back) · TelegramNotifier

### M5 — Jobs & lifecycle
- [ ] scheduler.ts (intervals, cache locks, crash isolation, run metrics logs)
- [ ] subscription-expiration.job · notification.job (drain + blocked-user handling → users.is_blocked) · cleanup.job (stale pending payments → failed; orphaned storage check) · analytics.job no-op registration

### M6 — Hardening & deploy
- [ ] Rate-limit tuning · error-message audit · manual QA checklist end-to-end (all three access types, payment failure path, expiry + renew)
- [ ] Railway deploy, secrets, log review · tag v0.1.0-mvp

**MVP definition of done:** fresh user registers, browses free/premium/pay-per-unlock drops, mock-purchases an unlock (including a forced failure retry), receives storage-backed protected content, buys Premium, accesses premium drops, is expired by the sweep, gets a renew notification — all audited, all events firing, zero business logic in the adapter.

## Technical debt register

| # | Debt | Trigger to repay |
|---|---|---|
| 1 | MemoryCacheProvider is per-process (rate limits, locks) | Second instance → RedisCacheProvider |
| 2 | No RLS | First non-bot client (dashboard/API) |
| 3 | Long-polling | Before real Stars → webhook + secret token |
| 4 | Settings cached at boot | Dashboard live-edit requirement |
| 5 | In-process scheduler, lock is advisory | Multi-instance → Redis locks or pg_cron |
| 6 | Domain events not durable (post-commit crash loses side effect) | External consumers/payouts → outbox table behind same dispatcher |
| 7 | No auto-renew | Real Stars native subscriptions |
| 8 | transport_cache invalidation is wipe-and-rebuild only | Fine indefinitely; revisit at multi-bot |
| 9 | Refund: schema+port ready, no service path/UX | First real-money dispute |
| 10 | CI runs unit tests only | Add test-DB workflow when repo settles (M2–M3) |
| 11 | Single-creator UX in bot (core is multi-tenant) | SaaS onboarding milestone (deep-link storefront routing) |
| 12 | Manual QA, no e2e bot tests | Post-MVP if regressions bite |

## Future integrations (not now)
Real Telegram Stars provider (same port; pre_checkout + successful_payment + refund + 21-day payout awareness) · Creator web dashboard (workspace package sharing core; triggers RLS + settings hot-reload) · Lumina integration (client adapter on core services) · REST API · Stripe/fiat provider · R2/S3 content adapters · Redis · outbox events · analytics (job slot + PurchaseCompleted handler already reserved) · gifting/comps (manual grants already modeled).
