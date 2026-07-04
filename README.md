# Creator Platform (working name: Telegram Stars SaaS)

A **creator monetization platform**. The core is a channel-agnostic business engine — catalog, payments, entitlements, subscriptions, content delivery, domain events. **Telegram is the first client adapter.** Creators sell free, premium-gated, and pay-per-unlock content; the MVP uses mock payments shaped after the real Telegram Stars lifecycle.

## Status
**Session 2 complete — architecture revised, zero implementation code.** Blocking gate: schema + architecture approval. See `PROJECT-MEMORY.md`.

## Read in this order
1. `docs/SYSTEM_ARCHITECTURE.md` — zones, all flow diagrams, dependency rules, multi-tenancy, jobs, events *(supersedes ARCHITECTURE.md)*
2. `docs/DATABASE.md` — schema revision 2 (11 tables)
3. `docs/ARCHITECTURE_DECISIONS.md` — ADR-001…018 *(supersedes DECISIONS.md)*
4. `docs/SETUP.md` — env vars, scripts, testing strategy
5. `docs/ROADMAP.md` — M0–M6, debt register, future integrations
6. `PROJECT-MEMORY.md` — cross-session handoff

## Stack
TypeScript strict · Node 22 · Telegraf (confined to one adapter) · Supabase Postgres + Storage · Drizzle · Zod · Pino · pnpm · Vitest · ESLint/Prettier · Railway · GitHub Actions CI.

## Golden rules
1. `core/` imports nothing from adapters, Telegraf, Drizzle, or Supabase. Ever. (ESLint-enforced, CI-failing.)
2. Clients → services → repositories → DB. Payments, content, cache, transport, notifications live behind ports.
3. Domain events dispatch **after commit**; handlers are isolated and idempotent.
4. Every money/access mutation writes an audit row in the same transaction.
5. Every tenant-owned row carries `creator_id`.
6. Migrations only from approved schema, generated and human-reviewed.
