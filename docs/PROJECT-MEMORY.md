# PROJECT-MEMORY — Creator Platform

> Cross-session handoff. Read first every session; update before ending any session.

## Current state
- **Session 2 complete (Architecture Revision).** Platform-centric reframe applied: core business engine + adapters; Telegram = first client. **Zero implementation code.**
- **Blocking gate:** Tyler approves DATABASE.md rev 2 + SYSTEM_ARCHITECTURE.md → then Session 3 starts M1.

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

## Session 3 plan (= M1, on approval)
1. Scaffold: pnpm, strict tsconfig, ESLint boundary rules (import/no-restricted-paths mirroring the dependency graph), Prettier, Vitest.
2. CI workflow (typecheck/lint/unit).
3. config/env.ts (Zod, parse-or-crash) + tests · logging/logger.ts (Pino, redaction) · shared/ (Result, AppError, domain types).
4. core/events dispatcher + tests (after-commit ordering, handler isolation).
5. STOP. Review before M2 (schema → migration → review → repositories).

## Open items for Tyler
- Approve DATABASE.md rev 2 (esp. drop_assets, ADR-011 simplification, grant_type losing 'subscription').
- Confirm working name: repo "creator-platform"? (docs use it; cosmetic).
- Supabase: confirm a dev project + private `drops` bucket exist before M2.
