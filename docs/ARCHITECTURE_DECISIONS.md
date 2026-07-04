# ARCHITECTURE_DECISIONS

> Supersedes `DECISIONS.md` (Session 1). Format per entry: **Decision · Alternatives considered · Why selected · Trade-offs · Future considerations.** ADRs are never deleted, only superseded.

---

## ADR-001 — Drizzle over Prisma / Kysely / supabase-js

**Decision.** Drizzle ORM + `postgres-js` (Supabase pooler, `prepare:false`); `drizzle-kit` migrations reviewed before apply.
**Alternatives.** Prisma; Kysely; supabase-js/PostgREST; raw SQL.
**Why.** TypeScript-native schema = single source of truth; generated migrations are plain SQL a human can review (a project rule); no runtime query engine (smaller container, faster boot); first-class transactions for payment finalization. Prisma adds an engine binary and a second schema language; Kysely lacks a migration/schema story; supabase-js is an HTTP client built for browser/RLS contexts — wrong layer server-side; raw SQL sacrifices type safety at scale.
**Trade-offs.** Smaller ecosystem than Prisma; some advanced Postgres features need `sql` escape hatches.
**Future.** Repositories are the only Drizzle-aware layer, so even Drizzle is replaceable. `@supabase/supabase-js` enters the codebase only inside the storage adapter (ADR-009).

## ADR-002 — PostgreSQL over NoSQL

**Decision.** Postgres (Supabase-managed) as the only datastore.
**Alternatives.** MongoDB/DynamoDB (document); Firebase; polyglot.
**Why.** This domain is relational and transactional to its bones: a purchase atomically touches payments, purchases, access_grants, and audit_logs; entitlement checks are joins; uniqueness constraints (idempotency key, one-active-subscription) are *correctness features* that document stores can't enforce declaratively. Multi-tenancy via `creator_id` + future RLS is a solved Postgres pattern.
**Trade-offs.** Vertical-scaling ceiling far beyond any realistic horizon here; jsonb columns give document flexibility where needed (settings, raw payloads).
**Future.** Read replicas / partitioning by creator_id if the platform genuinely reaches thousands-of-creators scale.

## ADR-003 — Telegraf over grammY (confined)

**Decision.** Telegraf, with a hard rule: no Telegraf type escapes `adapters/telegram/`.
**Alternatives.** grammY (more active maintenance, arguably better TS ergonomics, runs on edge runtimes); raw Bot API client.
**Why.** Project spec names Telegraf; it's mature, battle-tested, and fully sufficient for polling/webhook + middleware. The meaningful risk (maintenance pace) is neutralized by confinement — Telegram is one adapter among future many.
**Trade-offs.** If grammY pulls decisively ahead, we carry a known migration.
**Future.** A swap touches exactly one directory by construction. Re-evaluate at real-Stars integration time.

## ADR-004 — Railway over Fly.io / serverless

**Decision.** Railway; Fly.io documented fallback.
**Alternatives.** Fly.io; Render; VPS; Cloudflare Workers / Vercel / Lambda.
**Why.** The platform is a persistent Node process (long-polling, in-process scheduler, warm caches) — serverless is a shape mismatch. Railway: git-push deploys, secrets, logs, zero-downtime restarts, instant HTTPS domain for webhook mode.
**Trade-offs.** Less regional control than Fly; modest cost premium over a VPS (bought back in ops time).
**Future.** Fly for multi-region; the app is 12-factor (env-config, stateless-ish, JSON logs) so the host is swappable.

## ADR-005 — Payment abstraction (`PaymentProvider` port)

**Decision.** All payment logic behind one port shaped after the **real** Telegram Stars lifecycle: `createIntent → awaitApproval(pre-checkout) → confirm → refund`. Implementations: `MockPaymentProvider` (MVP; configurable latency + failure rate per Q4), `TelegramStarsProvider` (future). Business layer never learns which provider ran.
**Alternatives.** Direct Telegraf payment calls in services (fastest, fatal coupling); generic "charge()" one-shot interface (simpler, but hides the async/event-driven reality of real Stars and guarantees a painful migration).
**Why.** The single largest MVP→production risk is mock/real drift. Modeling the real lifecycle now means the mock does extra work (auto-resolving phases) and the real provider slots in with zero service changes.
**Trade-offs.** The mock is slightly more elaborate than a toy.
**Future.** Stripe/fiat becomes a third implementation; `payments.provider` enum already reserves values; refund path exists in the port and schema even though MVP exposes no refund UX.

## ADR-006 — Content abstraction (`ContentProvider` port) + Supabase Storage primary (Q1)

**Decision.** `ContentProvider` port: `store / getDeliverable(signed URL or stream) / delete / exists`. MVP implementation: **SupabaseStorageProvider** (private bucket, tenant-prefixed paths). `PurchaseService`/`DeliveryEngine` request delivery; they never know where bytes live.
**Alternatives.** Telegram `file_id` as system of record (free/instant but bot-token-bound, unportable, invisible to future web clients); R2/S3 directly (fine tech, second vendor with no MVP benefit — Supabase Storage is already in the account and is S3-compatible-ish to migrate from).
**Why.** Q1 decision: platform independence from day one. Content must be servable to a web dashboard and survivable across bot migrations.
**Trade-offs.** Delivery costs an upload hop on first send. Mitigation: cache the returned `telegram_file_id` per (asset, bot) as a pure optimization — losable, rebuildable, never authoritative.
**Future.** R2/S3 adapters implement the same port; `TelegramFileProvider` exists only as a delivery-cache strategy, not storage.

## ADR-007 — Cache abstraction (`CacheProvider` port)

**Decision.** Redis-*shaped* port (`get/set/del/expire/incr/withLock`) with `MemoryCacheProvider` (MVP), `NoopCacheProvider` (tests), `RedisCacheProvider` (future). Consumers: rate limiter, job locks, idempotency fast-path, hot settings.
**Alternatives.** Redis from day one (infra + cost for a single-process MVP with zero benefit); no abstraction, in-memory maps sprinkled ad-hoc (guarantees a painful retrofit).
**Why.** Rate limiting and locking are needed at MVP; distribution is not. The port makes "add Redis" a composition-root one-liner instead of a refactor.
**Trade-offs.** Memory cache is per-process — documented as debt with the trigger "second instance."
**Future.** Redis unlocks distributed rate limits, real locks, and lightweight queues; the port's semantics (TTL, atomic incr, lock token) are chosen so Redis satisfies them exactly.

## ADR-008 — Hexagonal-lite architecture

**Decision.** Ports & adapters with three zones (core / adapters / composition); manual constructor injection in a single composition root; no DI container.
**Alternatives.** Classic MVC-ish bot app (fast, then rots — business logic migrates into handlers); full DDD (aggregates, value objects everywhere) — ceremony exceeding team size; DI container (tsyringe/Inversify) — reflection magic for ~20 injectables.
**Why.** The replaceability requirements (Telegram, payments, storage, cache, DB — all swappable) are exactly what ports buy, and nothing more is needed. `app.ts` doubles as a readable wiring diagram.
**Trade-offs.** More files than a script; composition root grows linearly (revisit past ~40 injectables).
**Future.** If a second deployable (dashboard API) shares core, promote `core/` + `shared/` to a workspace package.

## ADR-009 — Repository pattern

**Decision.** One repository per aggregate, defined as interfaces consumed by core, implemented in `adapters/persistence/`. Repositories speak SQL in, domain types out. A unit-of-work helper composes multi-repo transactions.
**Alternatives.** Services calling Drizzle directly (fewer files, but core becomes DB-aware and untestable without Postgres); generic repository<T> (leaky abstraction that fights SQL); active record (couples domain types to persistence).
**Why.** Keeps core pure (unit tests need zero DB), makes the ORM swappable, and concentrates every query where it can be reviewed and indexed deliberately.
**Trade-offs.** Some pass-through methods early on. Accepted.
**Future.** Query-heavy analytics may later bypass repositories via a dedicated read-model module — explicitly, not accidentally.

## ADR-010 — Event-driven (in-process domain events)

**Decision.** Typed domain events (`PurchaseCompleted`, `PaymentFailed`, `SubscriptionActivated`, `SubscriptionExpired`, `ContentUnlocked`) dispatched by a **synchronous in-process dispatcher, strictly after transaction commit**. Handlers isolated (a throwing handler logs; never fails the request). Registration in composition root. No Kafka/RabbitMQ/NATS (explicitly excluded).
**Alternatives.** Direct service→service calls for side effects (couples PurchaseService to notifications/analytics forever); message broker (operational weight absurd at this scale); Postgres LISTEN/NOTIFY or outbox table (real durability, real complexity).
**Why.** Events decouple *causes* (purchase completed) from *reactions* (notify, audit-enrich, count) so new reactions — analytics, webhooks, Lumina — are added by registering handlers, not editing services.
**Trade-offs.** In-process events are **not durable**: a crash between commit and dispatch loses the side effect. Accepted for MVP because every handler's effect is either reconstructible (audit core rows are written in-transaction, not via events) or low-stakes (a missed notification).
**Future.** If durability becomes required (payouts, external webhooks), introduce a transactional **outbox table** behind the same dispatcher interface — the seam already exists.

## ADR-011 — Subscription entitlement = live check, not granted rows

**Decision.** Premium access is computed live: `EXISTS active subscription for (user, creator) with expires_at > now()`. `access_grants` records only pay-per-unlock purchases and manual comps. (Revises Session 1, enabled by Q2's free/premium/pay-per-unlock model.)
**Alternatives.** Session 1 design: mint subscription-scoped grants, revoke on expiry (sweep must revoke correctly or users keep access — a security-relevant failure mode).
**Why.** One indexed query, zero revocation bookkeeping, expiration becomes a status flip + event. Fewer moving parts in the exact place where bugs mean unauthorized access.
**Trade-offs.** Entitlement history isn't materialized in grants — reconstructed from subscriptions + audit when needed.
**Future.** If per-drop premium curation arrives (premium unlocks a *subset*), reintroduce grants for that case only.

## ADR-012 — Multi-tenant data model from day one

**Decision.** `creator_id` on every tenant-owned table; services take tenant scope; repositories always filter by it. One process, one bot, N creators. RLS deferred with an explicit trigger (first non-bot client).
**Alternatives.** Single-tenant now + migrate later (the classic regret); schema-per-tenant or DB-per-tenant (operational madness before product-market fit); RLS now (cost with no second client to protect against).
**Why.** Column-level tenancy is nearly free at design time and brutally expensive to retrofit. Everything SaaS-shaped later (creator onboarding, per-tenant settings, dashboards) assumes it.
**Trade-offs.** Slightly wider tables and indexes today.
**Future.** RLS policies keyed on creator_id; partitioning by creator_id only at genuine scale.

## ADR-013 — Zod everywhere (carried, unchanged)

Env parse-or-crash · handler-boundary payload validation · jsonb settings validation · drizzle-zod inference. Alternatives (Valibot, TypeBox) optimize for constraints (bundle size, JSON Schema) we don't have.

## ADR-014 — pnpm (carried, unchanged)

Strict node_modules (no phantom deps), fast content-addressed installs, workspaces ready for the future core package split. Bun runtime risk not acceptable for a payments platform; npm strictly dominated.

## ADR-015 — Pino logging (carried, unchanged)

Structured JSON, child loggers per module, correlationId per update/job-run, redaction of tokens/keys. Pretty-print in dev only. Pipes to Railway now, Axiom/Better Stack later without code change.

## ADR-016 — Result<T, AppError> for expected failures (carried)

Expected outcomes (already-owned, payment-declined, not-found) return typed Results; exceptions mean bugs/infrastructure. Error middleware maps both to user-safe output.

## ADR-017 — Long-polling MVP → webhook production (carried)

Launch mode is config. Webhook adds secret-token verification and fast-ack + idempotent handlers (Telegram retries non-200s). Flip before real payments.

## ADR-018 — CI from day one (Q5)

GitHub Actions on push/PR: `pnpm typecheck && pnpm lint && pnpm test` (unit). Integration tests run locally/on-demand until a test-DB workflow is added (tracked debt). Boundary-rule ESLint runs in CI, so architectural violations fail the build — the dependency rules are enforced, not aspirational.
