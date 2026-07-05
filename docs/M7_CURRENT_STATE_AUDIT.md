# M7 — Current-State Audit

> **Purpose:** exhaustive inventory of what already exists, before any M7 code. The governing rule: **extend, don't rebuild.** Companion to `docs/M7_IMPLEMENTATION_PLAN.md` and `docs/M7_PLATFORM_EVOLUTION_PLAN.md`.
> **Method:** direct read of `src/` (core services, telegram adapter, persistence, server, jobs, config) at MVP `v0.1.0`.
> **Headline:** the core is already multi-creator; the single-creator pin is the `SEED_IDS` wiring in `src/app.ts:120-121`. Most of M7.0–M7.3 is *routing + web surface + additive tables*, not new business logic.

---

## 0. The one-line finding

`src/app.ts` binds `SEED_IDS.creator` / `SEED_IDS.premiumPlan` into `configureTelegramBot(...)`. That is the **entire** single-creator constraint. Every service below it already takes `creatorId` as a parameter and enforces tenant ownership. Remove that binding + resolve `creatorId` per update = multi-creator.

---

## 1. Existing reusable functionality (what M7 builds on)

### 1.1 Core services — already multi-creator, reuse verbatim

| Service | Methods that already exist | Reused by | Gap for M7 |
|---|---|---|---|
| `UserService` (`core/services/user.service.ts`) | `ensureRegistered(profile)` (find-or-create by `telegram_id`, audited), `findById` | Bot auth middleware; **future dashboard/API user lookups** | Users are **platform-level, not tenant-owned** ("one Telegram user buys from many creators" — comment in file). Nothing to change for multi-creator. |
| `CreatorService` (`core/services/creator.service.ts`) | `getById`, `findByUserId`, `requireActive` (tx-bound money-flow guard) | Drop/Purchase/Subscription flows | **Add** `findBySlug`, `listActive`/`search`, `register`/`onboard` (M7.0/7.2). |
| `DropService` (`core/services/drop.service.ts`) | `createDrop`, `addAsset`, `publishDrop`, `listPublished(creatorId)`, `getPublishedDrop` — all **creator-scoped with ownership checks** (`drop.creatorId !== input.creatorId → not_found`) | Bot browse/detail | **This is the entire creator-dashboard content backend, already built.** Dashboard (M7.1) is an API over these methods. |
| `AccessService` (`core/services/access.service.ts`) | `resolveAccess(userId, dropId)` (read path), `canAccess(repos,...)` (tx primitive). Live oracle: free/subscription/grant (ADR-011) | Bot detail/my_access, Purchase, Delivery | None. Reused as-is by every channel. |
| `SubscriptionService` (`core/services/subscription.service.ts`) | `subscribe`, `getActivePlan`, `hasActiveSubscription`, `expireLapsed`, replay/idempotency | Bot subscribe; M5 sweep | None for routing; pricing UI (M7.1) reuses `getActivePlan` + plan repo. |
| `PurchaseService` (`core/services/purchase.service.ts`) | `purchaseDrop`, `beginAttempt/runProvider/finalize*`, `failStalePending` | Bot unlock; M5 cleanup | Real Stars provider swaps behind `PaymentProvider` (M7.5). |
| `AuditService` (`core/services/audit.service.ts`) | `record` (Zod-validated vocabulary, in-tx) | Everywhere | **Add** `admin` actor + new actions (M7.6) — additive to the Zod enum. |

### 1.2 Engines, events, jobs, ports — reused unchanged

- `DeliveryEngine`, `NotificationEngine` (`core/engines/`) — channel-agnostic; new channels are new `ContentTransport`/`Notifier` implementations.
- Event dispatcher + typed events (`core/events/`) — the seam for analytics rollups + outbox (later milestones).
- Scheduler + 4 jobs (`jobs/`) — reused; new jobs (scheduled publish, rollups) register the same way.
- Ports (`core/ports/`): `PaymentProvider`, `ContentProvider`, `ContentTransport`, `CacheProvider`, `Notifier`, `Clock` — all reused; M7 adds implementations, not new core.

### 1.3 Telegram adapter — reusable pieces

| Piece | File | Reuse in M7 |
|---|---|---|
| Pure view builders (`welcome`, `browseHeader`, `dropDetail`, `dropButtonLabel`, `accessBadge`, `myAccessView`, `escapeHtml`, …) | `telegram/views/views.ts` | Reused; **add** creator storefront + discovery views. `escapeHtml` already handles creator-supplied strings. |
| Keyboards (`browseKeyboard`, `openKeyboard`, `confirmUnlock/SubscribeKeyboard`) | `telegram/keyboards/keyboards.ts` | Reused; **add** creator-list / follow keyboards. |
| Callback codec (`code:value`, `parseCallbackData`, discriminated-union Zod) | `telegram/handlers/callback-data.ts` | **Extend** with creator-scoped actions (view creator, follow, paged browse within a creator). |
| Middleware chain (correlation → logging → rate-limit → auth) | `telegram/middleware/middleware.ts` | Reused; **add** a `creatorContext` middleware. Auth already attaches `ctx.user`. |
| Command/callback handlers | `telegram/handlers/handlers.ts` | **Extend**: replace `deps.creatorId` with a resolved current-creator; add `/discover /follow /creators`; parse `/start` payload. |
| Custom context (`correlationId`, `log`, `user`) | `telegram/context.ts` | **Add** `currentCreatorId`/`creator`. |
| Bot factory + webhook/polling launch + `BotRegistry`-ready `bot_settings`/`transport_cache` | `telegram/bot.ts` | Reused; dedicated bots (M7.7) build on `createTelegramWebhookHandler`/`registerTelegramWebhook`. |

### 1.4 Infrastructure already in place (net-new-avoidance)

- **HTTP server** (`server/http-server.ts`, M6): production Node http server with path routing, health, graceful shutdown. **This is the mounting point for the dashboard/public API** — adding routes, not a new server.
- **Health/liveness** (`server/health.ts`) — extend for readiness/dependency checks.
- **Persistence**: `UnitOfWork` (tx + after-commit events), `buildRepositories`, all repos. Repos **always tenant-filter** (ADR-012).
- **Config**: `config/env.ts` parse-or-crash (single `process.env` reader) — extend with auth/dashboard keys.
- **Test infrastructure**: hand-written fakes (`tests/fakes/`), integration harness against real Postgres, boundary lint. Every M7 addition stays testable the same way.

### 1.5 Domain vocabulary already sufficient (or nearly)

- `CREATOR_STATUSES = ['active','suspended','pending']` — **onboarding states already exist** (`shared/domain.ts`). May add `payout_ready`/`banned` (additive).
- `PLAN_STATUSES = ['active','retired']` — tiers are just more plan rows (Q3, schema tier-ready).
- `GRANT_TYPES = ['purchase','manual']` — comps already modeled.
- `AUDIT_ACTOR_TYPES = ['user','system','job']` — **add** `admin` (M7.6).
- Money is `Stars` (integer), `STARS_CURRENCY='XTR'` — payout/ledger (M7.5) adds minor-unit fiat.

---

## 2. Files that will change (by milestone, precise)

### M7.0 — Multi-creator routing (small, localized)
- `src/app.ts` — remove `SEED_IDS.creator`/`premiumPlanId` binding; wire a `CreatorResolver` + `CreatorService`/follow deps.
- `src/adapters/telegram/handlers/handlers.ts` — `deps.creatorId` → per-update resolved creator; parse `/start` payload; add `/discover`, `/follow`, `/creators`; group `/my_access` by creator.
- `src/adapters/telegram/context.ts` — add `currentCreatorId`/`creator`.
- `src/adapters/telegram/middleware/middleware.ts` — add `creatorContextMiddleware` (payload/cache → current creator).
- `src/adapters/telegram/handlers/callback-data.ts` — add creator-scoped actions (view/follow/paged browse).
- `src/adapters/telegram/views/views.ts` + `keyboards/keyboards.ts` — storefront + discovery views/keyboards.
- `src/core/services/creator.service.ts` — `findBySlug`, `listActive`/`search`.
- `src/core/repositories/index.ts` + `adapters/persistence/repositories/repositories.ts` — `CreatorRepository.findBySlug`/`listActive`; new `FollowRepository`.
- `src/adapters/persistence/db/schema/creators.ts` — add `slug` (+ profile columns as needed). New `schema/follows.ts`.
- `tests/fakes/memory-repositories.ts` + `tests/fakes/world.ts` — mirror new repo methods + `givenCreator(slug)`.

### M7.1 — Creator dashboard (largest net-new: web + auth + API)
- **New** `src/adapters/api/` (or `src/adapters/http/`) — REST/JSON adapter mounting on the existing `HttpServer`; calls core services with the authenticated creator's `creatorId`.
- **New** `src/core/services/creator-identity.service.ts` + repo — web login distinct from Telegram `users`.
- `src/config/env.ts` — auth provider + API config keys.
- `src/server/http-server.ts` — mount API routes alongside `/health` + webhook (extend `route`).
- `src/app.ts` — compose the API adapter + identity service.
- **New frontend** (separate app/dir, e.g. `dashboard/` or a workspace package) — Next.js SPA calling the API.
- Schema: `creator_identities`; `creators` profile columns (`avatar_url`, `links`, `theme`).

### M7.2 — Onboarding
- `src/core/services/creator.service.ts` — `register`/`onboard` state transitions (`pending → active`).
- API + dashboard onboarding routes/screens; slug reservation; bot-mode choice (shared default).
- Schema: none beyond M7.1 (reuse `creators`/`creator_identities`).

### M7.3 — Marketplace/discovery
- `creator.service.ts` — `search`/`listActive` (paged); `FollowService` (or fold into CreatorService).
- Telegram handlers + views — `/discover`, `/search`, creator storefront, deep-link entry.
- Schema: `follows` (may already exist from M7.0); search indexes (pg_trgm/tsvector).

### M7.4–M7.8 (summarized; detailed in the plan)
- **M7.4 Redis/scale**: new `RedisCacheProvider` (implements `CacheProvider`), `railway.json` replica bump. No core change.
- **M7.5 Stars + payouts**: new `TelegramStarsPaymentProvider` (implements `PaymentProvider`), new `PayoutProvider`; schema `ledger_entries`/`payout_accounts`/`payouts`; refund path (debt #9).
- **M7.6 admin/ops**: admin API + RBAC; `audit_actor_type='admin'`; `feature_flags`, moderation tables.
- **M7.7 dedicated bots**: `BotRegistry` runtime + `creator_bots` (encrypted tokens); per-bot transport/notifier.
- **M7.8 API/mobile/AI/channels**: public API + `api_keys`; new `Notifier`/`ContentTransport` (email/push/Discord); MCP adapter.

---

## 3. Database migrations required (all additive; human-reviewed per project rule)

| Milestone | Migration (additive) | Notes |
|---|---|---|
| M7.0 | `creators.slug` (nullable, unique index) + **backfill** the seed creator; new table `follows (user_id, creator_id, followed_at)` | Slug enables deep-links + storefront. Backfill is a data step, not schema. |
| M7.1 | new `creator_identities`; `creators` profile columns (`avatar_url`, `links` jsonb, `theme` jsonb) — nullable | Web identity separate from Telegram `users`. |
| M7.2 | (none new) | Uses M7.1 tables; possibly `creator_status` enum `+banned/+payout_ready` (`ADD VALUE`, forward-only). |
| M7.3 | search indexes (`pg_trgm`/GIN on `creators.display_name`, `drops.title`); `follows` if deferred from M7.0 | |
| M7.4 | none | Redis is infra. |
| M7.5 | `ledger_entries`, `payout_accounts`, `payouts`; `purchases.referral_id` (nullable) | Integer money preserved; fiat as minor units. |
| M7.6 | `feature_flags`, `content_reports`, `moderation_actions`, `team_members`; `audit_actor_type +admin` | |
| M7.7 | `creator_bots` (encrypted token, webhook secret) | Secret custody risk. |
| M7.8 | `api_keys`, `affiliates`, `referrals` | |

**No drops/renames anywhere.** Enum additions are forward-only (plan the vocabulary). RLS is a discrete reviewed migration when a non-bot DB client first appears (see risks).

---

## 4. Routes that already exist

**Telegram (the only "routes" today):**
- Commands: `/start`, `/help`, `/browse`, `/unlock [dropId]`, `/subscribe`, `/my_access`.
- Callback actions (`code:value`): `b`=browse(page), `d`=detail(dropId), `up`=unlock_prompt(dropId), `u`=unlock(dropId), `sp`=subscribe_prompt(planId), `s`=subscribe(planId).

**HTTP (M6):**
- `GET /health` (+ `HEAD`), webhook `POST <WEBHOOK_URL path>`. Everything else 404.

**Does not exist yet:** any dashboard/API/auth route, any web frontend, any `/discover`/`/search`/`/follow` bot command. `/start` currently **ignores** its deep-link payload (reads `ctx.from.first_name` only) — M7.0 must parse it.

---

## 5. Components that can be reused (quick index)

- **Business logic:** all of `core/services/*`, `core/engines/*`, `core/events/*`, `AccessService` oracle. Zero rewrites for multi-creator.
- **Persistence:** `UnitOfWork`, `buildRepositories`, every repo (tenant-filtering built in).
- **Telegram UI:** pure `views/*`, `keyboards/*`, callback codec, middleware chain.
- **Infra:** `HttpServer` (mount API here), health, scheduler, config parse-or-crash, logging+redaction, graceful shutdown.
- **Ports:** all six — new channels/providers are new implementations.
- **Tests:** fakes + integration harness + boundary lint.

---

## 6. Technical risks

| Risk | Milestone | Severity | Mitigation |
|---|---|---|---|
| **Callback statelessness vs current-creator context** — a user browses multiple creators; a `b:<page>` callback has no creator. | M7.0 | Med | dropId/planId callbacks already imply a creator (via the entity); for browse/discovery, carry creator context in a cache-backed session keyed on `telegram_id`, or encode `creatorId` in the callback. Prefer cache session + slug in `/start` payload. |
| **Default-creator fallback** when `/start` has no payload. | M7.0 | Low | Land on marketplace/discovery home rather than a hardcoded creator; keep the seed creator only as a demo. |
| **Slug backfill + uniqueness** for the existing seed creator. | M7.0 | Low | Deterministic backfill in the migration/seed; unique index added after backfill. |
| **Dashboard tenant safety without RLS** — reprioritization ships the dashboard (M7.1) *before* RLS. | M7.1 | **High** | Mitigated by design: the dashboard must go through the **same core services**, which already enforce `creator.id` ownership (`DropService` checks `drop.creatorId !== input.creatorId`) and repos tenant-filter. **Never** let the API touch repos/DB directly. RLS remains the defense-in-depth follow-up (schedule it before the *public* API in M7.8, or sooner). Document this as an explicit accepted risk + guardrail. |
| **Web/auth is fully net-new** — no framework, auth, or API precedent in the repo (deps: telegraf/drizzle/pino/postgres/supabase-js/zod only). | M7.1 | Med | Reuse the M6 `HttpServer` for the API adapter (no new server); pick a managed auth provider (Supabase Auth or Clerk) rather than hand-rolling; keep core untouched. |
| **Core reuse across bot + dashboard** — share code without duplication. | M7.1 | Med | Decide: single deployable (API adapter in the same process, simplest, fits single-replica reality) **vs** pnpm workspace `core` package (ADR-014 anticipated it). Recommend single-process API adapter first; split to a package only when a separate deploy is needed. |
| **Single replica still in force** through M7.0–M7.3 (Redis moved to M7.4). | M7.0–M7.3 | Med | Acceptable at early-adoption volume: rate limits + job locks are per-process but there is one process. Bot + API on one replica is fine to launch; Redis (M7.4) removes the ceiling before scale. Note the cap explicitly. |
| **Deep-link/session UX ambiguity** across many creators. | M7.0/M7.3 | Med | Explicit "current creator" indicator in replies + easy switch via `/creators`; group `/my_access` by creator. |
| **Bot-token custody** for dedicated bots. | M7.7 | High | Deferred; encrypt at rest, rotate, isolate. Out of M7.0–M7.3 scope. |
| **Financial correctness** (real Stars, ledger, payouts). | M7.5 | High | Deferred; integer money + in-tx audit already in place; add double-entry ledger + reconciliation tests. |
| **No e2e bot tests** (debt #12). | cross-cutting | Low-Med | Add a thin e2e/smoke harness as multi-creator flows grow. |

---

## 7. Estimated implementation order & sizing

Order follows the approved **adoption-first** reprioritization. Sizing is relative effort, informed by how much already exists.

| # | Milestone | Net-new vs extend | Rel. size | Why |
|---|---|---|---|---|
| **M7.0** | Multi-creator routing | Mostly **extend** (edge only) | **S** | Core already multi-creator; change is `SEED_IDS` → resolver + slug + follows. |
| **M7.1** | Creator dashboard | **Largest net-new** (web+auth+API) | **XL** | Content backend exists; web/auth/API surface is new. Reuse `HttpServer` + core services. |
| **M7.2** | Onboarding | Extend (services) + dashboard screens | **M** | Reuses M7.1 identity/API; `creator_status` states already exist. |
| **M7.3** | Marketplace/discovery | Extend (bot + services) + search | **M** | Reuses browse/views + `follows`/slug from M7.0. |
| **M7.4** | Redis + horizontal scale | Net-new adapter (drop-in) | **S–M** | `CacheProvider` port already abstracts it. Unpins replicas. |
| **M7.5** | Real Stars + payouts | Net-new provider + ledger tables | **L** | `PaymentProvider` swap + new `PayoutProvider` + money tables. High care. |
| **M7.6** | Admin/ops | Net-new admin surface | **M–L** | Reuses audit/services; new RBAC + moderation/flags. |
| **M7.7** | Dedicated bots (white-label) | Extend bot runtime + tables | **L** | Seams exist (`bot_settings`, `transport_cache`); runtime + secrets new. |
| **M7.8** | API/mobile/AI/channels | Net-new adapters | **L** | Public API + new channel `Notifier`/`ContentTransport` + MCP. |

**Sequencing note (advisory, not a change to the approved order):** M7.0 is small and unblocks everything; M7.1 is the heaviest lift and its tenant-safety-without-RLS risk is the single most important thing to design carefully. Consider scheduling RLS activation immediately after M7.1's read path lands (before write-heavy dashboard use), even though full RLS was originally later.

---

*Audit complete. No code, migrations, or existing systems were modified. See `docs/M7_IMPLEMENTATION_PLAN.md` for the milestone-by-milestone build plan.*
