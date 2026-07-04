# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state — read this first

This is a **creator monetization platform** (working name: Telegram Stars SaaS / creator-platform). The core is a channel-agnostic business engine; Telegram (via Telegraf) is the first client adapter. **There is zero implementation code yet** — the repo contains only architecture documentation. All code work is blocked on a gate: Tyler must approve `docs/DATABASE.md` (schema rev 2) and `docs/SYSTEM_ARCHITECTURE.md` before Session 3 / milestone M1 begins.

At the start of every session, read `docs/PROJECT-MEMORY.md` (cross-session handoff — current state, locked decisions, next-session plan) and update it before ending a session. Decisions listed there as "locked" (Q1–Q5, ADR-006/007/010/011/012) must not be re-litigated.

Document read order: `docs/SYSTEM_ARCHITECTURE.md` (authoritative) → `docs/DATABASE.md` → `docs/ARCHITECTURE_DECISIONS.md` (ADR-001…018) → `docs/SETUP.md` → `docs/ROADMAP.md` (M0–M6 milestones, debt register) → `docs/PROJECT-MEMORY.md`.

## Stack

TypeScript strict · Node 22 · pnpm · Telegraf (confined to the Telegram adapter) · Supabase Postgres + Storage · Drizzle ORM (`postgres-js`, pooler with `prepare:false`) · Zod · Pino · Vitest · ESLint/Prettier · Railway · GitHub Actions CI.

## Commands (planned — scripts land in M1)

```bash
pnpm dev              # tsx watch + pino-pretty
pnpm build / start
pnpm db:generate      # drizzle-kit — migrations must be human-reviewed before apply
pnpm db:migrate       # uses DATABASE_DIRECT_URL (port 5432), never the pooler
pnpm db:seed          # idempotent: creator, Premium plan, sample drops, settings
pnpm test / test:watch
pnpm test:integration # real Postgres; runs locally/on-demand, not in CI yet
pnpm lint / format / typecheck
```

CI (from M1): typecheck → lint (includes architecture boundary rules — violations fail the build) → unit tests.

## Architecture — the non-negotiables

Hexagonal-lite with three zones under `src/`: **core** (`core/` — services, engines, domain events, ports), **adapters** (`adapters/` — telegram, payments, content, cache, persistence), and **composition** (`app.ts` manual-DI root + `jobs/`). Full folder layout and flow diagrams are in `docs/SYSTEM_ARCHITECTURE.md`.

Dependency rules (ESLint-enforced via `import/no-restricted-paths`, CI-failing):

1. `core/` imports only `shared/`. Never `adapters/`, `jobs/`, `telegraf`, `drizzle-orm`, or `@supabase/*`.
2. Adapters import `core/` and `shared/` — never each other; they meet only through core ports.
3. Only `adapters/persistence/repositories` touches Drizzle. Repositories: SQL in, domain types out.
4. `jobs/` call core services; no business logic in job files.
5. `process.env` is read only in `config/env.ts` (Zod parse-or-crash); everything else gets config via constructors.
6. `app.ts` is the only file allowed to import everything — it is the wiring diagram, including event-handler registration.

Domain and correctness rules:

- Everything swappable lives behind ports: `PaymentProvider`, `ContentProvider`, `ContentTransport`, `CacheProvider`, `Notifier`, `Clock`. MVP implementations are MockPaymentProvider (configurable delay + failure rate), SupabaseStorageProvider, MemoryCacheProvider. The business layer never knows which provider ran.
- The PaymentProvider port is shaped after the **real** Telegram Stars lifecycle (`createIntent → awaitApproval → confirm → refund`); the mock adapts to it, not vice versa.
- Domain events (PurchaseCompleted, PaymentFailed, SubscriptionActivated, SubscriptionExpired, ContentUnlocked) dispatch **strictly after transaction commit** via an in-process synchronous dispatcher. Handlers are isolated (a throwing handler never fails the request) and idempotent. No message broker — explicitly out of scope.
- Every money/access mutation writes an audit row **in the same transaction** (audit is not event-driven; events only enrich).
- Multi-tenant from day one: every tenant-owned row carries `creator_id`; repositories always filter by it. One process, one bot, N creators.
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
