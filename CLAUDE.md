# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state — read this first

This is a **creator monetization platform** (working name: Telegram Stars SaaS / creator-platform). The core is a channel-agnostic business engine; adapters are clients over it — currently a **Telegram bot** (Telegraf) and a **JSON HTTP API** for the creator web dashboard. **Milestones M1–M6 (MVP, tagged `v0.1.0-mvp`) and M7.0–M7.3 are complete and committed:** scaffold, schema/persistence, core business layer, Telegram adapter, jobs & lifecycle, production hardening/deploy, then multi-creator routing, creator dashboard API, creator onboarding, and marketplace/discovery. **Do not start the next M7 milestone (M7.4 Redis/scale onward) without Tyler's go-ahead.** The architecture docs are the source of truth.

The platform is **multi-creator**: the single-creator pin was `SEED_IDS` in `app.ts`; it is gone. The Telegram adapter resolves the "current creator" per update via `CreatorContext` (`/start` deep-link payload / slug → cache-backed session), and the API isolates by the authenticated creator's id. See `docs/M7_CURRENT_STATE_AUDIT.md` for the exhaustive reuse inventory before extending anything ("extend, don't rebuild").

At the start of every session, read `docs/PROJECT-MEMORY.md` (cross-session handoff — current state, locked decisions, next-session plan) and update it before ending a session. **Known doc drift: PROJECT-MEMORY.md and ROADMAP.md currently close out at M6 — the M7.0–M7.3 work landed after them and is only captured in the M7 docs + git history; reconcile them when you next update.** Decisions listed as "locked" (Q1–Q5, ADR-006/007/010/011/012) must not be re-litigated.

Document read order: `docs/SYSTEM_ARCHITECTURE.md` (authoritative) → `docs/DATABASE.md` → `docs/ARCHITECTURE_DECISIONS.md` (ADR-001…020; ADR-019 = DeliveryEngine, not PurchaseService, emits `ContentUnlocked` once per user+drop after actual delivery; ADR-020 = production requires `BOT_MODE=webhook`) → `docs/SETUP.md` → `docs/ROADMAP.md` (milestones + debt register) → `docs/M7_PLATFORM_EVOLUTION_PLAN.md` + `docs/M7_IMPLEMENTATION_PLAN.md` + `docs/M7_CURRENT_STATE_AUDIT.md` (the M7 platform plan) → `docs/PROJECT-MEMORY.md`. Deploy/launch: `docs/DEPLOYMENT.md`, `docs/LAUNCH_CHECKLIST.md`.

## Stack

TypeScript strict · Node 22 · pnpm · Telegraf (confined to the Telegram adapter) · Supabase Postgres + Storage · Drizzle ORM (`postgres-js`, pooler with `prepare:false`) · Zod · Pino · Vitest · ESLint/Prettier · Railway · GitHub Actions CI. The web dashboard's **API is hand-rolled Node `http`** (no Express/Fastify) with **`node:crypto`-only auth** (scrypt password hashing behind a `PasswordHasher` port; SHA-256-hashed opaque bearer session tokens behind a `SessionTokenService` port) — no auth library, no JWT, no managed provider. There is **no frontend in this repo yet**; the SPA is a future/separate deliverable that consumes the JSON API.

## Commands

```bash
pnpm dev              # tsx watch src/index.ts + pino-pretty
pnpm build / start    # tsc -p tsconfig.build.json → node dist/index.js
pnpm db:generate      # drizzle-kit — migrations must be human-reviewed before apply
pnpm db:migrate       # uses DATABASE_DIRECT_URL (port 5432), never the pooler
pnpm db:seed          # idempotent: creator, Premium plan, sample drops, settings
pnpm test             # vitest run tests/unit  (unit only; the CI + default suite)
pnpm test:watch       # vitest tests/unit
pnpm test:integration # vitest --config vitest.integration.config.ts — real Postgres, local/on-demand, not in CI
pnpm lint / format / typecheck
```

Run one test file: `pnpm test tests/unit/core/services/purchase.service.test.ts`. Filter by name: `pnpm test -t 'idempotency'`. Integration tests need local Postgres (M2 notes used PG17 via Docker on port 54329) and read `TEST_DATABASE_URL`.

CI (`.github/workflows/ci.yml`): typecheck → lint (includes architecture boundary rules — violations fail the build) → unit tests.

## Architecture — the non-negotiables

Hexagonal-lite with three zones under `src/`: **core** (`core/` — services, engines, domain events, ports), **adapters** (`adapters/` — `telegram`, `api` [JSON HTTP for the dashboard], `auth` [scrypt hasher + session tokens], `payments`, `content`, `cache`, `persistence`), and **composition** (`app.ts` manual-DI root + `jobs/` + `server/` [the Node `http` server that mounts `/health`, the API under `/api`, and — in webhook mode — the Telegram update route]). Full folder layout and flow diagrams are in `docs/SYSTEM_ARCHITECTURE.md`.

Dependency rules (ESLint-enforced via `import/no-restricted-paths`, CI-failing):

1. `core/` imports only `shared/`. Never `adapters/`, `jobs/`, `telegraf`, `drizzle-orm`, or `@supabase/*`.
2. Adapters import `core/` and `shared/` — never each other; they meet only through core ports.
3. Only `adapters/persistence/repositories` touches Drizzle. Repositories: SQL in, domain types out.
4. `jobs/` call core services; no business logic in job files.
5. `process.env` is read only in `config/env.ts` (Zod parse-or-crash); everything else gets config via constructors.
6. `app.ts` is the only file allowed to import everything — it is the wiring diagram, including event-handler registration.

Domain and correctness rules:

- Everything swappable lives behind ports: `PaymentProvider`, `ContentProvider`, `ContentTransport`, `CacheProvider`, `Notifier`, `Clock`, and (M7.1) `PasswordHasher` + `SessionTokenService`. MVP implementations: MockPaymentProvider (configurable delay + failure rate), SupabaseStorageProvider, MemoryCacheProvider, ScryptPasswordHasher, CryptoSessionTokenService. The business layer never knows which provider ran.
- The PaymentProvider port is shaped after the **real** Telegram Stars lifecycle (`createIntent → awaitApproval → confirm → refund`); the mock adapts to it, not vice versa.
- Domain events (PurchaseCompleted, PaymentFailed, SubscriptionActivated, SubscriptionExpired, ContentUnlocked) dispatch **strictly after transaction commit** via an in-process synchronous dispatcher. Handlers are isolated (a throwing handler never fails the request) and idempotent. No message broker — explicitly out of scope.
- Every money/access mutation writes an audit row **in the same transaction** (audit is not event-driven; events only enrich).
- Multi-tenant from day one: every tenant-owned row carries `creator_id`; repositories always filter by it. One process, N creators. The Telegram bot resolves the current creator per update (`CreatorContext`); the JSON API isolates by the authenticated creator's id (`AuthService.authenticate` → `principal.creatorId`). Both channels go **through core services** — the API never touches repos/DB directly, since (with RLS not yet enabled) service-level `creator_id` ownership checks are the sole tenant boundary for the dashboard.
- Entitlement (AccessService is the single oracle): `free` → published; `premium` → live check for an active subscription with `expires_at > now()` (never materialized as grants — ADR-011); `pay_per_unlock` → unrevoked `access_grants` row. `purchases` (commerce) and `access_grants` (entitlement ledger) are distinct concepts.
- Supabase Storage (private `drops` bucket) is the content source of truth; Telegram `file_id` lives only in `drop_assets.transport_cache` as a rebuildable optimization, never authoritative.
- Expected failures return `Result<T, AppError>`; exceptions mean bugs/infrastructure.
- Migrations are generated only from the approved schema in `docs/DATABASE.md` and are human-reviewed before apply. Money is integer Stars, never floats.

## Testing strategy

- **Unit (majority):** core services/engines/dispatcher with hand-written fakes in `tests/fakes/` (in-memory repos, FakeClock, scriptable FakePaymentProvider, NoopCache). No mocking libraries — core has zero adapter imports, so none are needed.
- **Integration:** repositories + DB constraints against real Postgres (idempotency uniqueness, one-active-subscription, one-live-grant, entitlement predicate).
- **Expiration tests always use FakeClock, never sleeps.** Event tests cover after-commit ordering and handler isolation.

## Workflow expectations

- The roadmap (`docs/ROADMAP.md`) has deliberate stop points — e.g. M2 generates the migration then **stops for review** before applying. Respect them.
- ADRs are never deleted, only superseded. New significant decisions get a new ADR entry in `docs/ARCHITECTURE_DECISIONS.md` (Decision · Alternatives · Why · Trade-offs · Future).
- Known limitations are tracked in the debt register in `docs/ROADMAP.md` with explicit repayment triggers — check it before "fixing" something that is documented, accepted debt (e.g. per-process cache, no RLS, non-durable events).
