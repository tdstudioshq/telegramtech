# M7 — Platform Evolution Plan: Single-Demo → Multi-Creator SaaS

> **Status:** Planning only. No code, no migrations, no changes to existing docs or systems.
> **Author framing:** principal-architect pass — decisions here should still be correct in three years.
> **Read first:** `SYSTEM_ARCHITECTURE.md`, `DATABASE.md` (rev 2.2), `ARCHITECTURE_DECISIONS.md` (ADR-001…020), `ROADMAP.md` (debt register).

## TL;DR — the thesis

The hard part is already done. The MVP is **not** a single-tenant system that needs to be "made multi-tenant." It is a **multi-tenant core (ADR-012) running a single-tenant edge**. Every tenant-owned row already carries `creator_id`; every repository already filters by it; the Telegram handlers already take `deps.creatorId` and operate per creator. The only thing pinning us to one creator is the composition root wiring `SEED_IDS.creator` / `SEED_IDS.premiumPlan` into the bot (`src/app.ts:120-121`) — that is debt #11, and it is a routing decision at the adapter edge, not a data-model or business-logic problem.

Therefore M7 is overwhelmingly **additive**: a routing/identity layer at the edges, new operational surfaces (dashboards, payouts, moderation), and infrastructure to lift the deliberate single-replica constraint (debt #1/#5/#6). The core business engine (`src/core/`) should change **very little**. The architecture's central promise — *"adding the dashboard or another channel means writing an adapter and turning on RLS, zero changes inside `core/`"* (SYSTEM_ARCHITECTURE §12) — is exactly the promise M7 cashes in.

---

## 1. Current Architecture Review

### 1.1 Strengths (the assets we build on)

| Strength | Evidence | Why it matters for M7 |
|---|---|---|
| **Enforced hexagonal boundaries** | ESLint `import/no-restricted-paths` zones, CI-failing (ADR-018). `core/` has zero adapter imports. | New clients (web, mobile, API) and new providers (payouts, Redis, CDN) attach without touching core. Non-negotiable safety for a big expansion. |
| **Multi-tenant from day one** | `creator_id` on every tenant-owned table; repos always tenant-filter (ADR-012). | The data model already scales to thousands of creators. No re-tenanting migration. |
| **Ports abstract the volatile parts** | `PaymentProvider`, `ContentProvider`, `ContentTransport`, `CacheProvider`, `Notifier`, `Clock`. | Payment-provider agnostic (ADR-005); cache/storage/transport are swappable. Redis, R2/CDN, Stripe, Discord/email are provider swaps, not rewrites. |
| **Entitlement is a single live oracle** | `AccessService` (ADR-011); `purchases` (commerce) vs `access_grants` (entitlement) cleanly separated. | Adding tiers, comps, affiliates, or channels never forks entitlement logic. |
| **After-commit events + in-transaction audit** | ADR-010 dispatcher; audit row written in the same tx as every money/access mutation. | Clean seam to a durable outbox + analytics/rollup workers with no service rewrites. |
| **Multi-bot already anticipated in the schema** | `drop_assets.transport_cache` keyed `{"telegram:<botId>": "<file_id>"}`; `bot_settings` is tenant-scopable (`creator_id NULL` = platform default, non-null = per-creator override, `UNIQUE NULLS NOT DISTINCT`). | The white-label / bot-per-creator path has its storage seams pre-built. |
| **Production-grade edges (M6)** | Health endpoint, graceful shutdown, structured logging, env parse-or-crash, webhook + secret-token, single HTTP server. | Operational baseline for horizontal scale and new HTTP surfaces (API/dashboard). |
| **Everything testable without mocks** | Hand-written fakes in `tests/fakes/`; core has no adapter imports. | Every M7 addition stays unit-testable the same way. |

### 1.2 Scalability limits (all deliberate MVP choices, tracked as debt)

| Limit | Source | Impact at scale |
|---|---|---|
| **Single replica** | MemoryCacheProvider is per-process (rate limits + advisory job locks) — debt #1/#5; `railway.json` pins `numReplicas: 1`. | Blocks horizontal scale. **This is the keystone constraint** — nearly everything else waits on Redis. |
| **In-process, non-durable events** | ADR-010 / debt #6: a post-commit crash loses the side effect; no external consumers. | Fine for one bot; insufficient for payouts, external analytics, cross-service fan-out. |
| **In-process scheduler** | Interval timers + advisory lock (debt #5). | Correct on one instance; multi-instance needs distributed locks / pg_cron / a queue. |
| **Single hardcoded creator at the edge** | `app.ts` wires `SEED_IDS.creator` into the bot (debt #11). | **The actual single-creator constraint.** Small, localized fix. |
| **No RLS** | debt #2; safe while the bot is the sole DB client. | A web/API client sharing the DB requires RLS keyed on `creator_id`. |
| **Settings cached at boot** | debt #4. | No live config/feature-flag edits until a cache-invalidation path exists. |
| **No search / thin browse** | offset browse in handlers; no full-text. | Marketplace discovery needs search (pg_trgm → external engine). |
| **Storage without CDN** | Supabase Storage, server-signed URLs (Q1/ADR-006). | Global delivery + egress cost need a CDN/R2 ContentProvider. |
| **transport_cache wipe-and-rebuild** | debt #8. | Acceptable indefinitely; revisit at multi-bot. |
| **Cleanup orphan scan is a stub** | debt #13. | Needs a `ContentProvider.list` capability to prune orphans. |

### 1.3 Technical debt map (register → M7 repayment)

`#1` per-process cache → **M7.1 Redis**. `#2` no RLS → **M7.3**. `#5` advisory job lock → **M7.1/M7.2**. `#6` non-durable events → **M7.2 outbox**. `#4` boot-cached settings → **M7.2/M7.3 (Redis-backed live settings)**. `#8` transport_cache invalidation → **M7.7 (dedicated bots)**. `#9` refund path → **M7.5 (PaymentProvider.refund already in the port)**. `#10` CI unit-only → **cross-cutting (add test-DB workflow)**. `#11` single-creator UX → **M7.0**. `#12` no e2e bot tests → **cross-cutting**. `#13` orphan storage cleanup → **M7.5/infra (ContentProvider.list)**.

### 1.4 MVP assumptions being lifted (and which stay)

**Lifted by M7:** one creator / one bot / one seeded plan · creator == a Telegram user (`creators.userId → users.id`, no web identity) · no KYC/payout · mock payments · single replica · no discovery/search · no dashboards.

**Preserved (do not "fix" — they are load-bearing):** integer Stars money · Supabase Storage as content source of truth with Telegram `file_id` only a rebuildable cache · entitlement as a live check, never materialized grants (ADR-011) · audit-in-transaction, events after-commit · handlers idempotent + isolated · ports own everything swappable.

---

## 2. Multi-Creator Architecture

**Framing:** the core already serves N creators. The decision is the **edge model** — how an inbound update resolves to a creator, and how creators present a storefront.

### Option A — one shared platform bot, many creators
- **How:** a single `@PlatformBot`. The creator is resolved per update from a deep-link start payload (`t.me/PlatformBot?start=c_<slug>`), then the existing handlers run with that `creatorId`. Browse/library become creator-scoped by a "current creator" context.
- **Pros:** one token, one webhook, trivial ops; **zero onboarding friction** (no BotFather step); enables cross-creator **discovery/search/marketplace**; cheapest to run; best funnel.
- **Cons:** shared bot identity (no white-label branding); one Telegram rate-limit/throughput budget (~30 msg/s per bot) shared across all creators; a single platform-ban blast radius; no per-creator bot customization.
- **Fit:** near-perfect with today's code — only the `SEED_IDS` wiring changes to a per-update resolver (debt #11).

### Option B — dedicated bot per creator
- **How:** each creator connects a BotFather token; the platform runs many webhooks (one path per bot) and a `BotRegistry` maps `botId → creatorId`. Tokens/config live in `creator_bots` (+ existing `bot_settings`).
- **Pros:** full **white-label branding**; per-creator rate-limit budget (throughput scales ~linearly with creators); fault isolation (one creator's ban/outage doesn't affect others); the creator owns their bot.
- **Cons:** onboarding friction; operational complexity (N webhooks, `setWebhook`, secret management, token rotation); **no cross-creator discovery** (each bot is an island); larger security surface (custody of N tokens).
- **Fit:** the seams already exist (`bot_settings` per creator, `transport_cache` per `botId`, `ContentTransport`/`Notifier` ports), but the runtime must manage many bots and secrets.

### Option C — Hybrid ✅ **RECOMMENDED**
- **Model:** shared bot is the **default** (Option A) — every creator gets an instant storefront on `@PlatformBot` via slug deep-link, and the shared surface powers discovery/marketplace. Dedicated bots are an **upgrade** (Option B) for paid/white-label/high-volume creators and agencies. Both run the **same core and the same handlers**, selected at the edge.
- **Unifying abstraction:** introduce a thin `CreatorResolver` + `BotRegistry` at the Telegram adapter edge:
  - `CreatorResolver`: `(botId, startPayload, chat) → creatorId`. On the shared bot, resolves from the start payload / stored context; on a dedicated bot, `botId → creatorId` is 1:1.
  - `ContentTransport` and `Notifier` become **per-bot instances** chosen by the creator's bot binding. `bot_settings`/`creator_bots` provide the token; `transport_cache` already namespaces `file_id`s per bot.
- **Why hybrid is the correct 3-year answer:**
  - A marketplace needs a **shared discovery surface** (network effects, organic growth) → Option A.
  - Serious creators/agencies/white-label need **their own brand + throughput + isolation** → Option B.
  - Building **only A** permanently blocks white-label; building **only B** kills discovery *and* the onboarding funnel. Hybrid keeps both open.
  - It puts all variation **at the adapter edge**, exactly where the architecture already isolates channel concerns — the core never learns whether a creator is on the shared or a dedicated bot.
  - It matches the schema's latent design (multi-bot `transport_cache`, tenant-scoped `bot_settings`) — we are completing an intended path, not bending the model.
- **Throughput reasoning:** most creators are small and coexist comfortably under the shared bot's budget; delivery is via **signed URLs** (the client pulls bytes from Storage/CDN, the bot mostly sends *messages*), and `transport_cache` avoids re-uploading media — so per-bot message rate, not bandwidth, is the ceiling. Heavy creators graduate to dedicated bots, naturally sharding load.
- **Phasing:** ship A first (**M7.0**, smallest possible step to real multi-creator), add B later (**M7.7**) once identity, payouts, and Redis are in place. The shared bot can deep-link **hand off** to a creator's dedicated bot when they upgrade.

**Decision:** adopt **Option C (hybrid)**, delivered A-first. (Proposed **ADR-021 — Hybrid bot model with a `BotRegistry`/`CreatorResolver` edge.**)

---

## 3. Creator Onboarding Lifecycle

The creator becomes a first-class, self-serve entity with a state machine. Today a "creator" is a Telegram user with a seeded row; M7 gives creators a **web identity** distinct from any Telegram `users` row (a creator may never use the bot themselves).

**Creator state machine:** `pending → email_verified → active (can publish free content) → payout_ready (KYC complete) → { suspended | banned }`. Backed by additive `creator_status` enum values + a `verification_status` field.

| Stage | What happens | Data / seam | Channel | Gate |
|---|---|---|---|---|
| **Signup** | Creator registers with email/OAuth (not a Telegram identity). | New `creator_identities` (auth provider external_id) + `creators` row (`status=pending`, unique `slug`). New **`IdentityProvider`** seam (Clerk / Supabase Auth / Auth0). | Web dashboard | — |
| **Identity verification** | Tiered: email verify → basic; full KYC (name/tax/ID) required before payouts. | `verification_status`; KYC handled by the payout provider (Stripe Connect) — store status, not PII. | Web | Publish-paid & payout gated on tier |
| **Bot connection** | Choose **shared** (instant, default) or **dedicated** (paste BotFather token → validate via `getMe` → store encrypted → register webhook). | `creator_bots` (encrypted token, webhook secret, mode, status); `BotRegistry` refresh; `bot_settings` for non-secret per-creator config. | Web | — |
| **Profile creation** | Display name, bio, avatar, slug, links, theme (white-label). | Additive `creators` columns / `creator_profiles`. | Web | Required before publish |
| **Content upload** | Upload media/text → stored privately; drafts created. | `ContentProvider.store` → `drops`/`drop_assets` (`status=draft`); ordering via `drop_assets.position` (exists). | Web (→ later, bot) | — |
| **Pricing** | Set subscription tiers + per-drop unlock prices (integer Stars; multi-currency later). | `subscription_plans` (already tier-ready, Q3); `drops.price_stars`. | Web | — |
| **Publishing** | Draft → published; enforce ≥1 asset (existing guard) and verification tier for paid. | `DropService.publish` (exists); optional `publish_at` for scheduling. | Web | Tier check for paid |
| **Receiving payments** | Buyers unlock/subscribe via the bot; commerce is unchanged. | `PaymentProvider` (Stars now; Stripe/fiat later); `payments`/`purchases` (exist). | Telegram (+ future channels) | Active creator |
| **Analytics** | Per-creator revenue, unlocks, subs, churn, funnels. | Replace the analytics no-op with an **`AnalyticsProvider`**; feed from events + `daily_creator_metrics` rollups. | Web | — |
| **Payouts** | Creator connects a payout account, accrues a balance, and withdraws. | New **`PayoutProvider`** port; `ledger_entries`, `payout_accounts`, `payouts`; platform commission; Telegram Stars 21-day payout awareness; Stripe Connect for fiat. | Web + provider | `payout_ready` (KYC) |

---

## 4. Database Evolution (plan only — additive & non-breaking)

**Constraints honored:** additive columns are **nullable** (backfill separately); new tables only; new enum values via `ADD VALUE` (forward-only, non-breaking); **no drops/renames**; every migration human-reviewed (project rule); RLS added as its own reviewed migration when the first non-bot client lands (ADR-012 future). Money stays integer (Stars); fiat modeled as integer **minor units** + `currency`.

### 4.1 New / extended tables

| Table | Purpose | Key columns | Notes |
|---|---|---|---|
| `creators` (extend) | Storefront + tenancy | `slug` (unique, citext), `avatar_url`, `links` jsonb, `theme` jsonb, `tier`, `verification_status`, `default_bot_id`, `commission_bps` | All nullable + backfill; `slug` unique index. |
| `creator_identities` | Web/API auth, separate from Telegram users | `creator_id`, `provider`, `external_id`, `email`, `role` | Decouples creator login from `users.userId`. |
| `creator_bots` | Dedicated-bot bindings (Option B/C) | `creator_id`, `transport`, `bot_id`, `username`, `token_encrypted`, `webhook_secret`, `mode`, `status` | Source for `BotRegistry`; secrets encrypted at rest. |
| `follows` | "Follow creator" (UX/notifications) — distinct from paid subs | `user_id`, `creator_id`, `followed_at` | Powers discovery + new-drop notifications. |
| `payout_accounts` | Where money is sent | `creator_id`, `provider` (stars/stripe_connect), `external_account_id`, `status` | KYC status lives here. |
| `ledger_entries` | Money movements (balance source of truth) | `creator_id`, `type` (sale/fee/refund/payout/adjustment), `amount_minor`, `currency`, `ref_type`, `ref_id`, `created_at` | Append-only, like audit; balance = sum. Integer money preserved. |
| `payouts` | Withdrawal runs | `creator_id`, `amount_minor`, `currency`, `status`, `provider`, `initiated_at`, `settled_at` | Stars 21-day window aware. |
| `affiliates` / `referrals` | Affiliate system | affiliate `code`/owner; referral `referrer`, `referred`, `creator_id`, `commission_bps` | Add nullable `referral_id` to `purchases` for attribution. |
| `team_members` | Teams/agencies RBAC | `creator_id`, `identity_id`, `role` (owner/admin/editor/analyst) | Agencies = one identity owning many creators. |
| `content_reports` / `moderation_actions` | Moderation | reporter, `target` (drop/creator), reason, status, resolver | Actions also audited in `audit_logs`. |
| `feature_flags` | Rollouts | `key`, `scope` (global/tier/creator), `value` | Extends the `system_settings`/`bot_settings` pattern. |
| `api_keys` | Programmatic access | `creator_id`, `hashed_key`, `scopes`, `status` | Rate-limited via CacheProvider. |
| `daily_creator_metrics` | Analytics rollups | `creator_id`, `date`, `revenue`, `unlocks`, `new_subs`, `active_subs`, `churn` | Materialized from events/audit by a worker (also repays the ADR-019 "materialize a delivery ledger" note). |
| `outbox` | Durable events (repay debt #6) | `event_type`, `payload`, `created_at`, `processed_at` | Written in-tx by the dispatcher seam; drained by workers. |

### 4.2 Indexes & relationships
- Unique: `creators.slug`, `creator_bots.bot_id`, `api_keys.hashed_key`.
- Hot reads: `follows (user_id)`, `follows (creator_id)`, `ledger_entries (creator_id, created_at)`, `daily_creator_metrics (creator_id, date)`. (`drops (creator_id, status, published_at)` already exists.)
- Search: `pg_trgm`/`tsvector` GIN on `creators.display_name`, `drops.title` for MVP-scale discovery; graduate to an external engine behind a `SearchProvider`.
- FKs: `creator_bots/identities/follows/payout_accounts/ledger/payouts → creators`; `ledger.ref → purchases|payouts`.

### 4.3 Migration philosophy
Every step above is additive. Enum extensions (`creator_status`, a new `admin`/`agent` `audit_actor_type`, `payment_provider` values) use `ALTER TYPE ... ADD VALUE` (non-breaking, forward-only — plan the vocabulary deliberately). The one **behavioral** migration is **RLS activation** (M7.3): policies keyed on `creator_id`, added and reviewed in isolation, verified against the existing repository queries (which already tenant-filter, so policies should be confirmatory, not corrective).

---

## 5. Admin Dashboard (platform operator surface)

Internal web app; a new **client adapter** over the same core services (+ admin-only services). `system_settings.updated_by` is already reserved for this provenance.

- **Creator management:** search/list; status transitions (activate/suspend/ban); tier & `commission_bps` overrides; audited impersonation ("view as creator").
- **Moderation:** `content_reports` queue; takedown = unpublish drop (status transition, not deletion); creator flags & appeals; every action audited (new `audit_actor_type = 'admin'`).
- **Payouts:** review/approve payout runs; view `ledger_entries` balances & holds; disputes/refunds (uses `PaymentProvider.refund`, already in the port — repays debt #9); Stars 21-day windows; Connect status.
- **Analytics:** platform GMV, take-rate, active creators/users, retention/cohorts, top creators.
- **Support:** user/creator lookup; refunds; comp grants (manual `grant_type` already modeled); resend delivery.
- **Feature flags:** toggle by global/tier/creator.
- **Onboarding tools:** approve KYC, verify dedicated bots, storefront templates.
- **Access model:** platform-admin identity + RBAC; all mutations audited **in-transaction** (existing pattern); RLS/permission-checked. Built as Next.js sharing core via a pnpm workspace package (ADR-014 anticipated the core-package split).

---

## 6. Creator Dashboard (creator self-serve)

Another **client adapter** over the same core — the architecture's headline promise. Scoped to the creator's `creator_id` (RLS-enforced), with team roles.

- **Uploads:** drag/drop → `ContentProvider.store` → drafts; asset ordering (`drop_assets.position`).
- **Scheduling:** `publish_at`; a scheduler/worker publishes at time (extends the jobs layer → queue in M7.2).
- **Analytics:** revenue, unlocks, subs, churn, funnels from `daily_creator_metrics` + live queries.
- **Subscriptions:** manage subscribers, tiers (`subscription_plans` tier-ready), comps.
- **Pricing:** plan prices/durations, per-drop unlock prices (integer Stars; multi-currency later).
- **Earnings:** `ledger_entries` balance + history + projected payouts + Stars payout timing.
- **Payouts:** connect account (Stripe Connect / Stars), request & track payouts.
- **Notifications:** broadcast to followers/subscribers via the `Notifier` port (rate-limited, queued via workers), with templates.
- **Profile customization:** slug, avatar, bio, links, theme, white-label bot branding.
- **Access:** creator identity + `team_members` roles; same core services as the bot.

---

## 7. User Experience (the ideal Telegram experience)

**Answering the posed questions — support all four, prioritized by intent:**

1. **Deep-link directly (primary, highest-conversion):** `t.me/PlatformBot?start=c_<slug>` from a creator's promo lands the user *inside that creator's storefront* immediately. This is the money path — external traffic converts best with zero friction. `/start` with a payload resolves the creator; without a payload → platform home/discovery.
2. **Browse creators first (marketplace):** `/discover` (or `/creators`) surfaces featured/followed/searchable creators — the organic-growth surface unique to the shared bot (Option A).
3. **Search:** `/search <query>` (and inline mode) across creators and drops (pg_trgm → `SearchProvider`).
4. **Follow:** `/follow` records a `follows` row → the user receives new-drop / renewal notifications (existing event → `Notifier`).

**Multi-creator context model:** a user can hold storefronts from many creators. Maintain a lightweight **"current creator context"** (from the last deep-link; cached, not necessarily a table) so `/browse`, `/unlock`, `/subscribe`, `/my_access` are creator-scoped; `/creators` lets them switch and shows followed creators. `/my_access` becomes **grouped by creator** (a natural extension of today's single-creator library).

**White-label vs marketplace UX:** on a creator's **dedicated bot** (Option B), there is *no* marketplace/discovery — it is that creator only (clean white-label). On the **shared bot**, the full marketplace UX applies, and it can **deep-link hand off** to a creator's dedicated bot when they upgrade.

**Preservation:** all existing commands and flows (`/start /help /browse /unlock /subscribe /my_access`, unlock/subscribe callbacks, protected delivery, expiry/renewal notifications) are preserved; multi-creator adds resolution + `/discover /search /follow /creators` and creator-scoping, not a rewrite.

---

## 8. Future Platform Expansion (no rewrites required)

The rule that makes this cheap: **every new surface is either (a) a new inbound client adapter that calls the same core services, or (b) a new outbound port implementation.** Neither touches `core/`. This is already enforced by the boundary lint.

| Surface | How it attaches | New seams needed |
|---|---|---|
| **Web app** | Client adapter → core via a BFF/API; auth via `creator_identities`. | API/BFF layer, RLS on. |
| **iOS / Android** | Native clients over the same API. | Same API; push `Notifier`. |
| **Public API** | REST/GraphQL adapter; `api_keys`; scopes; CacheProvider rate-limits. | API layer, key management. |
| **AI assistants** | An **MCP server** exposing core services as tools (creator ops, analytics Q&A); content generation via an AI SDK. | MCP/tool adapter (clean service boundaries already exist). |
| **Discord / WhatsApp** | New `ContentTransport` + `Notifier` + a client adapter; core unchanged. `transport_cache` already namespaces by `transport:id`. | Channel adapters. |
| **Email delivery** | A `Notifier` (and a link-delivery `ContentTransport`) implementation. | Email provider adapter. |
| **Push notifications** | A `Notifier` implementation (FCM/APNs). | Push adapter. |

**What must be built to unlock the whole set (all additive):** an API/BFF layer, an identity/auth provider, RLS, and durable events/queues so multiple clients and workers share state safely. None require touching core business logic. (Proposed **ADR-023 — creator identity is distinct from a Telegram `users` row.**)

---

## 9. Scaling Strategy

Sequenced by dependency; each maps to an existing port or debt item.

1. **Redis (repay debt #1) — the keystone.** `RedisCacheProvider` implements the existing `CacheProvider` port (drop-in). Unlocks **multi-replica**: shared rate-limit counters + distributed job locks. This single change unpins `numReplicas: 1`. Also enables Redis-backed **live settings** (repay debt #4) — the cache is an optimization; `AccessService` stays the entitlement oracle (ADR-011).
2. **Queues + background workers (repay debt #5/#6).** Introduce a `QueueProvider` port + `outbox` table. The after-commit dispatcher writes to the outbox in-tx; workers drain it (BullMQ/Redis or pg-based). Notification drain, delivery, and analytics rollups become **durable workers**; the scheduler moves to distributed locks / pg_cron / delayed queue jobs. Handlers are already idempotent, so at-least-once delivery is safe. (Proposed **ADR-022 — durable outbox behind the existing dispatcher interface.**)
3. **CDN + storage (ADR-006 swap).** Front Supabase Storage or move to R2/S3 behind a new `ContentProvider`, served via CDN with signed URLs → global, cheaper delivery. `transport_cache` still caches Telegram `file_id`s. A `ContentProvider.list` capability finally lets the cleanup job prune orphans (repay debt #13).
4. **Search.** `pg_trgm`/`tsvector` for MVP scale; graduate to Meilisearch/Typesense behind a `SearchProvider` port for the marketplace.
5. **Horizontal scaling.** With Redis-backed cache/locks, run N stateless replicas behind Railway; the webhook path is already stateless per request; jobs run under distributed locks or a dedicated worker + queue.
6. **Multi-region.** Stateless replicas per region; Supabase read replicas for storefront/analytics reads; content via CDN edge; writes to the primary; context/session in Redis; Telegram webhooks terminated near users.
7. **Observability.** Extend the M6 seams — `JobMetrics` and `/health` — into real metrics (OpenTelemetry/Prometheus) + a log drain, with **per-tenant** metrics.

**Order of operations:** Redis → outbox/workers → CDN/search → multi-region. Redis first because it gates horizontal scale, and horizontal scale gates almost everything else.

---

## 10. Implementation Roadmap

Milestones are **independently deployable** and dependency-ordered. Each preserves existing behavior. (Infra tracks — CDN/R2, multi-region — can run alongside once M7.1 lands.)

### M7.0 — Multi-creator on the shared bot (repay debt #11) · *smallest step to "true multi-creator"*
- **Objective:** the shared bot serves any creator via slug deep-link; browse/library creator-scoped by context.
- **DB:** `creators.slug` (nullable unique + backfill the demo creator); `follows`.
- **Backend:** `CreatorResolver` + `BotRegistry` at the Telegram edge; replace `SEED_IDS` wiring with a per-update resolved `creatorId`; `/discover`, `/follow`, `/creators`; `/my_access` grouped by creator.
- **Frontend:** none.
- **Testing:** resolver unit tests (payload → creatorId, fallbacks); multi-creator browse/entitlement integration; existing suite green.
- **Deployment:** additive migration; same bot/token.
- **Risks:** deep-link parsing & default-creator fallback; context ambiguity across creators. *Low overall — the handlers are already creator-parameterized.*

### M7.1 — Redis + horizontal scale (repay debt #1/#5)
- **Objective:** lift the single-replica constraint.
- **DB:** none.
- **Backend:** `RedisCacheProvider` (CacheProvider port); distributed job locks; config.
- **Testing:** cache integration; lock-contention/idempotency under concurrency.
- **Deployment:** provision Railway Redis; raise `numReplicas`.
- **Risks:** lock semantics, cache stampede. *Medium.*

### M7.2 — Durable events + workers (repay debt #6/#4)
- **Objective:** durable side effects; workers; live settings.
- **DB:** `outbox`; `daily_creator_metrics`.
- **Backend:** `QueueProvider`; outbox write in dispatcher; workers for notification/delivery/analytics rollups; scheduler → distributed.
- **Testing:** outbox drain, at-least-once + idempotency, rollup correctness.
- **Deployment:** worker process/service.
- **Risks:** delivery semantics, worker/replica coordination. *Medium.*

### M7.3 — Creator identity + web foundation + RLS (repay debt #2)
- **Objective:** web login distinct from Telegram; secure multi-client DB.
- **DB:** `creator_identities`; **RLS policies** keyed on `creator_id` (isolated, reviewed migration).
- **Backend:** `IdentityProvider` (Clerk/Supabase Auth); API/BFF over core; read-only dashboard data.
- **Frontend:** minimal creator dashboard (analytics + drop list, read-only).
- **Testing:** RLS policy tests (tenant isolation); auth mapping; API contract.
- **Deployment:** dashboard app; auth provider.
- **Risks:** **RLS correctness (highest-care item)**; identity↔Telegram mapping. *High.*

### M7.4 — Creator dashboard write path
- **Objective:** creators self-serve content/pricing/publishing.
- **DB:** `creators` profile columns; `publish_at`.
- **Backend:** dashboard uploads via `ContentProvider`; scheduling worker; plan/price management (existing services).
- **Frontend:** upload/scheduling/pricing/profile UI.
- **Testing:** upload → draft → publish e2e; scheduling via FakeClock.
- **Deployment:** dashboard release.
- **Risks:** upload robustness, scheduling correctness. *Medium.*

### M7.5 — Payments expansion + Payouts + Ledger
- **Objective:** real money in and out.
- **DB:** `ledger_entries`, `payout_accounts`, `payouts`; `purchases.referral_id` (nullable).
- **Backend:** real **Telegram Stars** `PaymentProvider` (swap `MockPaymentProvider`); **`PayoutProvider`** (+ Stripe Connect for fiat); commission; ledger postings in-tx; refund path (repays debt #9).
- **Frontend:** earnings/payouts UI; admin payout approval.
- **Testing:** money correctness, reconciliation, Stars 21-day payout, refund/dispute, KYC gating.
- **Deployment:** provider credentials; staged rollout.
- **Risks:** **financial correctness (highest)**, KYC/compliance, payout timing. *High.*

### M7.6 — Admin portal + moderation + feature flags
- **Objective:** operate the platform safely.
- **DB:** `content_reports`, `moderation_actions`, `feature_flags`, `team_members`; `audit_actor_type = 'admin'`.
- **Backend:** admin RBAC; moderation actions (audited); flag evaluation.
- **Frontend:** admin portal.
- **Testing:** RBAC, audited actions, flag scoping.
- **Deployment:** admin app (restricted).
- **Risks:** privilege boundaries, moderation workflows. *Medium.*

### M7.7 — Dedicated bots / white-label (Option B of the hybrid)
- **Objective:** creators run their own branded bots.
- **DB:** `creator_bots` (encrypted tokens).
- **Backend:** `BotRegistry` runtime for N bots; per-bot webhook routing + secrets/rotation; per-bot `ContentTransport`/`Notifier`; theme/branding; shared→dedicated handoff.
- **Frontend:** bot-connect flow; branding.
- **Testing:** multi-bot routing; token security; per-bot `transport_cache` (repays debt #8 concerns).
- **Deployment:** webhook fan-in for N paths.
- **Risks:** token custody/rotation, N-webhook ops. *High.*

### M7.8 — Discovery / search / marketplace UX
- **Objective:** organic growth surface.
- **DB:** search indexes (pg_trgm → external).
- **Backend:** `SearchProvider`; ranking; follow-driven notifications.
- **Frontend:** discovery in bot + web.
- **Testing:** search relevance/perf; tenant scoping.
- **Deployment:** search engine (if external).
- **Risks:** relevance, index freshness. *Medium.*

### M7.9 — Expansion adapters (API, web/mobile, AI/MCP, channels)
- **Objective:** open the platform.
- **DB:** `api_keys`; `affiliates`/`referrals`.
- **Backend:** public API + keys; additional `Notifier`/`ContentTransport` (email/push/Discord); MCP tool adapter; affiliate attribution.
- **Frontend:** API docs; mobile clients (separate track).
- **Testing:** API contract, rate-limit, channel adapters, affiliate attribution.
- **Deployment:** per-adapter.
- **Risks:** API abuse, channel-specific quirks. *Medium.*

---

## Guardrails — what must not change (the invariants that keep this coherent)

1. **Core purity.** `core/` imports only `shared/`. New surfaces are adapters; new infrastructure is port implementations. The boundary lint stays CI-failing.
2. **Ports own all volatility.** Payments, content, transport, cache, notifier, clock — and the new payout/identity/queue/search/analytics — are ports. The business layer never learns which implementation ran.
3. **Additive migrations only** (no drops/renames if avoidable); human-reviewed; RLS as its own reviewed step.
4. **Entitlement stays a single live oracle** (ADR-011) — never materialized grants, even under caching.
5. **Integer money; audit-in-transaction; events after-commit; handlers idempotent & isolated.**
6. **`app.ts` remains the only wiring root** — including the new `BotRegistry`, worker, and dashboard/API composition.

## Proposed new ADRs (to be written when the work begins — not created here)
- **ADR-021** Hybrid bot model (`BotRegistry`/`CreatorResolver` edge; shared-default, dedicated-upgrade).
- **ADR-022** Durable outbox + `QueueProvider` behind the existing after-commit dispatcher.
- **ADR-023** Creator web identity distinct from Telegram `users`.
- **ADR-024** Money ledger + `PayoutProvider`; commission model; integer minor-unit multi-currency.
- **ADR-025** RLS activation keyed on `creator_id` at the first non-bot client.

---

*End of plan. No code, migrations, or existing docs were modified. Awaiting approval before any M7 work begins.*
