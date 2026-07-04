# PROJECT-MEMORY — Creator Platform

> Cross-session handoff. Read first every session; update before ending any session.

## Current state
- **Session 3 complete (2026-07-04): M1 implemented.** Gate was approved by Tyler; architecture docs are frozen source of truth.
- Delivered: pnpm/strict-tsconfig/ESLint(boundary zones)/Prettier/Vitest scaffold · CI workflow (typecheck→lint→unit) · `config/env.ts` Zod parse-or-crash + tests · Pino logger with redaction · `shared/` (Result, AppError, domain enums/ids) · `core/events` (typed events + after-commit dispatcher + EventBuffer) + tests. 25 unit tests green; boundary rules verified to fail on deliberate violations; parse-or-crash and redaction verified at runtime.
- Toolchain notes: ESLint pinned to v9 (eslint-plugin-import lacks v10 peer support); local Node is 26, `.nvmrc`/CI pin 22; deps: zod 4, pino 10, vitest 4, typescript 6.
- Conventions set in M1: ESM (`"type": "module"`, NodeNext, `.js` import specifiers) · `EventBuffer.drain()` after commit → `dispatcher.dispatchAll()` (rollback = never drain) · dispatcher takes a minimal `DispatcherLogger` via constructor (core stays logging-free) · Prettier never touches docs/README (frozen).
- **Session 4 (2026-07-04): M2 first half done.** DATABASE.md rev 2.2 approved. Added drizzle-orm/postgres/drizzle-kit · schema in `src/adapters/persistence/db/schema/` (12 physical tables — §11 holds two settings tables — 11 Postgres enums mirrored 1:1 from shared/domain with a drift-guard unit test) · migration `0000_right_katie_power.sql` generated, re-generate confirms no drift. 51 unit tests green. **STOPPED at the documented review point — migration NOT applied.** Interpretation flagged for Tyler: drop_assets storage_bucket/storage_path made nullable because the §4 CHECK ("text ⇒ text_content; media ⇒ storage path") contradicts their not-null annotation; CHECK enforces shape per content_type. bot_settings uses native `UNIQUE NULLS NOT DISTINCT` (PG15+) for the documented "coalesced unique index" intent. BRIN on audit_logs.created_at deliberately omitted (doc says "at volume").
- **Session 4 second half (2026-07-04): M2 code complete.** Migration review approved (drop_assets nullable-storage ruling confirmed). Built: repository interfaces in `core/repositories` + Drizzle impls in `adapters/persistence/repositories` · DrizzleUnitOfWork (tx-bound repos + EventBuffer drained strictly after commit; rollback never dispatches — proven by test) · idempotent seed (`runSeed` + `db:seed` CLI, deterministic 5eed… uuids, ON CONFLICT DO NOTHING) · 13 integration tests green against local Postgres 17 (Docker, port 54329): idempotency unique, one-active-sub, one-live-grant, entitlement predicate (strict `>` at expiry boundary), uow atomicity, seed idempotency. Migration `0000` applies cleanly via drizzle migrator on PG17.
- **UNBLOCKED (2026-07-04): dev Supabase fully credentialed.** `.env` complete: DATABASE_URL (pooler `aws-1-us-west-2.pooler.supabase.com:6543`, user `postgres.cfjrxassteeevkrodttj`) + DATABASE_DIRECT_URL both verified with live queries (PG 17.6) · SUPABASE_SERVICE_ROLE_KEY (legacy service_role JWT via `supabase projects api-keys`) verified against Storage API · private bucket `drops` created and confirmed · dev BOT_TOKEN verified via getMe (@Cabanatelebot "CABANABOT"). Note: db password + bot token passed through chat — rotate before anything real. `supabase link` ran; `supabase/.temp/` gitignored. Tyler ran `pnpm db:migrate` + `pnpm db:seed` successfully.
- **M2 COMPLETE — closeout verified (2026-07-04):** dev Supabase has all 12 tables + 11 public enums + 1 recorded migration · seed present (Demo Creator `5eed…0002`, 1 user, 1 plan, 3 drops/assets, bot+system settings; transactional tables empty as expected) · `drops` bucket private · typecheck ✓ lint ✓ 51 unit ✓ 13 integration ✓ (local PG17 Docker). M1+M2 committed by Tyler.
- **Session 5 (2026-07-04): M3 COMPLETE — core business layer.** Delivered: 6 ports (Payment shaped on real Stars lifecycle createIntent→awaitApproval→confirm→refund · Content · ContentTransport · Cache Redis-shaped incl. withLock skip-semantics · Notifier with sent/blocked/failed · Clock) · services (Access = the oracle; Audit with Zod action/entity vocabulary; User ensureRegistered; Creator requireActive guard; Drop create/addAsset/publish mirroring DB CHECKs; Purchase = the state machine TX1-pending → provider outside tx → TX2 finalize, idempotency replay returns original outcome; Subscription subscribe/renew/expireLapsed — renewal extends from max(now, expiresAt)) · engines (Delivery: access→ContentProvider→Transport, I/O outside tx, protect always true; Notification: intent queue, drain, blocked→users.is_blocked, failed→requeue) · handlers (payment-failed/sub-activated/sub-expired intents; audit enrichment `event.*` rows; analytics no-op) · adapters (MockPaymentProvider injectable random; SupabaseStorageProvider — only @supabase/* import; Memory+Noop cache) · repo extensions (payment/purchase mark*, findByPaymentId, subscription findActive/renew/listLapsed/markExpired w/ status guards, drops.publish, users.setBlocked). Tests: 125 unit (hand-written fakes in tests/fakes: MemoryStore w/ constraint enforcement + cloning proxy, FakeUow w/ snapshot-rollback, scriptable FakePaymentProvider, FakeClock) + 19 integration. **Verified end-to-end** via composition-boundary script (recipe persisted in `.claude/skills/verify/SKILL.md`): full journey incl. real Supabase Storage signed-URL fetch. eslint: added argsIgnorePattern `^_`.
- **Interpretations flagged for Tyler (Session 5):** (1) ~~ContentUnlocked emitter conflict~~ — **RULED (ADR-019, 2026-07-04): DeliveryEngine emits ContentUnlocked after actual delivery (first per user+drop via audit lookup); PurchaseService emits PurchaseCompleted only. Applied before M4.** (2) Audit vocabulary extended with `purchase.failed` and enrichment namespace `event.purchase_completed`/`event.content_unlocked` (varchar-by-design accommodates; Zod list updated). (3) publishDrop requires ≥1 asset (invented guard: empty drop delivers nothing). (4) SubscriptionActivated is raised on renewal too (no separate renewal event exists; audit distinguishes via subscription.renewed).
- **Session 6 (2026-07-04): M4 COMPLETE — Telegram adapter.** Delivered: Telegraf factory + polling/webhook launch · context and middleware chain (correlation/log/rate-limit/auth/error) · pure views/keyboards and Zod-validated callbacks · `/start`, `/help`, `/browse` pagination/detail/delivery, `/unlock`, `/subscribe`, `/my_access` · signed-URL TelegramContentTransport with `protect_content`, stale-file-id fallback, and tenant-scoped `transport_cache` merge · TelegramNotifier with sent/blocked/failed mapping · `app.ts` composition/event registration + graceful boot/shutdown in `index.ts`. ADR-019 applied: DeliveryEngine emits first-delivery `ContentUnlocked` only after every asset is sent; PurchaseService emits `PurchaseCompleted` only. Added `PORT` config for webhook listener and tenant-scoped repo support for transport cache/first-delivery lookup. Verification: typecheck ✓ lint ✓ 142 unit ✓ 21 integration (local PG17) ✓ build ✓.
- **Next session: M5 (jobs & lifecycle). Do not start without Tyler.** PurchaseService.failStalePending remains deliberately deferred to the cleanup job milestone.

## Decisions locked this session (do not re-litigate)
- Q1: Supabase Storage is content source of truth (private bucket, signed URLs); telegram file_id only as rebuildable `transport_cache`.
- Q2: drops.access_type = free | premium | pay_per_unlock (CHECK ties price to unlock type).
- Q3: one Premium plan seeded; schema tier-ready.
- Q4: MOCK_PAYMENT_FAILURE_RATE stays; failure UX built + tested in MVP.
- Q5: GitHub Actions CI from M1 (typecheck, lint incl. boundary rules, unit tests).
- ADR-011: premium entitlement = LIVE subscriptions check; access_grants = pay-per-unlock + manual only; no subscription grants, no grant revocation sweep.
- ADR-010: in-process domain events (PurchaseCompleted, PaymentFailed, SubscriptionActivated, SubscriptionExpired, ContentUnlocked), synchronous, AFTER COMMIT, isolated handlers, registered in app.ts. No broker. Outbox = future seam.
- ADR-006/007: ContentProvider + CacheProvider ports; MVP impls SupabaseStorage + MemoryCache(+Noop).
- ADR-012: creator_id tenancy on every tenant-owned table; repositories always tenant-filter.
- Jobs layer: scheduler + subscription-expiration, notification, cleanup, analytics(no-op stub).
- Provider enum value renamed `mock` (provider-neutral). New table: drop_assets.

## Non-negotiables (carried + revised)
1. core/ imports only shared/. No Telegraf/Drizzle/@supabase anywhere in core. ESLint-enforced in CI.
2. Clients → services → repositories → DB; adapters never import each other.
3. PaymentProvider port shaped on REAL Stars lifecycle; mock adapts to it.
4. Purchases (commerce) ≠ access_grants (entitlement ledger). Audit rows in-transaction; events after commit.
5. Result<T, AppError> for expected failures. Env access only in config/env.ts.
6. Migrations only from approved schema, human-reviewed.

## File map (docs/)
SYSTEM_ARCHITECTURE.md (authoritative; supersedes ARCHITECTURE.md) · DATABASE.md rev 2 (11 tables) · ARCHITECTURE_DECISIONS.md ADR-001..018 (supersedes DECISIONS.md) · SETUP.md rev 2 · ROADMAP.md rev 2 (M0–M6, 12 debts) · README.md · this file.

## Session 3 plan (= M1, on approval) — DONE ✅
1. ~~Scaffold: pnpm, strict tsconfig, ESLint boundary rules (import/no-restricted-paths mirroring the dependency graph), Prettier, Vitest.~~
2. ~~CI workflow (typecheck/lint/unit).~~
3. ~~config/env.ts (Zod, parse-or-crash) + tests · logging/logger.ts (Pino, redaction) · shared/ (Result, AppError, domain types).~~
4. ~~core/events dispatcher + tests (after-commit ordering, handler isolation).~~
5. STOP. Review before M2 (schema → migration → review → repositories). ← **we are here**

## Session 4 plan (= M2, on M1 approval)
1. Drizzle + drizzle-kit deps · `drizzle.config.ts` · schema exactly per DATABASE.md rev 2.
2. Generate migration → **STOP for human review** → apply via DATABASE_DIRECT_URL.
3. Unit-of-work/tx helper (drains EventBuffer into dispatcher after commit) · repositories + integration tests.
4. Idempotent seed (creator, Premium plan, drops of all three access types, settings).
Note: the "As S1" column gaps are resolved — DATABASE.md rev 2.2 (2026-07-04) fully specifies audit_logs and system_settings inline (rev 2.1 approved by Tyler with revisions: varchar not enum for action/entity_type, system_settings category + updated_by, AuditRepository append-only contract). Rev 2.2 awaits Tyler's go-ahead before schema/migration generation.

## Open items for Tyler
- ~~Approve DATABASE.md rev 2~~ — **approved 2026-07-04**; review M1 output next.
- Confirm working name: repo "creator-platform"? (docs use it; cosmetic — package.json uses creator-platform, dir is telegramtech).
- Supabase: confirm a dev project + private `drops` bucket exist before M2.
- ~~Spec the exact audit_logs + system_settings columns~~ — done; rev 2.1 approved with revisions, applied as rev 2.2 (2026-07-04). **Confirm rev 2.2 → M2 (Drizzle schema + migration generation) may begin.**
