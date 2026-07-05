# M7 — Implementation Plan (adoption-first)

> **Approved reprioritization:** creator adoption before infrastructure. Shared platform bot stays the **default** experience; dedicated creator bots are a **premium upgrade on the same backend**, never a separate platform.
> **Governing rule:** extend what exists (see `docs/M7_CURRENT_STATE_AUDIT.md`); do not rebuild or duplicate. Preserve all MVP behavior and every invariant in `docs/M7_PLATFORM_EVOLUTION_PLAN.md` §Guardrails.
> **Status:** plan only — no code until M7.0 is approved.

## Milestone order (as approved)

| # | Milestone | Theme | Size |
|---|---|---|---|
| M7.0 | Multi-creator routing (shared bot) | adoption | S |
| M7.1 | Creator dashboard | adoption | XL |
| M7.2 | Creator onboarding (self-service) | adoption | M |
| M7.3 | Marketplace / discovery | adoption | M |
| M7.4 | Redis + horizontal scaling | infra | S–M |
| M7.5 | Real Telegram Stars + payout architecture | money | L |
| M7.6 | Admin & operations | ops | M–L |
| M7.7 | White-label dedicated creator bots | premium | L |
| M7.8 | Public API, mobile, AI, expansion adapters | platform | L |

Each milestone is **independently deployable** and preserves existing behavior.

---

## Cross-cutting principles (apply to every milestone)

1. **Core stays pure.** New surfaces are client adapters; new infra is port implementations. Boundary lint stays CI-failing.
2. **Reuse core services; never bypass them.** The dashboard/API call `DropService`, `AccessService`, etc. with the authenticated `creatorId` — they must not touch repos/DB directly (this is the tenant-safety guarantee before RLS).
3. **Additive migrations only**, human-reviewed, one concern each. RLS is its own reviewed step.
4. **Shared bot is default; dedicated bots reuse the same core + handlers**, selected at the edge.
5. **Everything testable** with the existing fakes + integration harness. New behavior ships with tests.
6. **`app.ts` remains the only wiring root.**

---

## M7.0 — Multi-creator routing (shared platform bot)

**Objective.** The single shared bot serves any creator. A user reaches a creator via a slug deep-link (`t.me/PlatformBot?start=c_<slug>`); browse/unlock/subscribe/library are scoped to the resolved creator. Remove the `SEED_IDS` pin.

**Reuse (from audit).** `UserService` (platform-level users, unchanged), `DropService.listPublished/getPublishedDrop`, `AccessService`, `SubscriptionService`, `PurchaseService`, `CreatorService.getById/requireActive`, all views/keyboards/middleware, callback codec.

**Build (extend).**
- `CreatorResolver` at the telegram edge: `(startPayload | session | botId) → creatorId`. On the shared bot, resolve from `/start` payload (slug) and persist a **current-creator session** in `CacheProvider` keyed on `telegram_id`.
- `creatorContextMiddleware` — populate `ctx.currentCreatorId`/`ctx.creator` after auth.
- `handlers.ts` — parse `/start` payload; `deps.creatorId` → `ctx.currentCreatorId`; add `/creators` (switch/list) and group `/my_access` by creator; keep all existing commands.
- `CreatorService.findBySlug`, `listActive`; `CreatorRepository.findBySlug`/`listActive`; new `FollowRepository`.
- `callback-data.ts` — creator-scoped actions where needed (e.g. paged browse carries creator, or reads session).

**Database.** `creators.slug` (nullable → unique index after backfill); backfill the seed creator's slug; new `follows(user_id, creator_id, followed_at)`.

**Backend.** Resolver + session cache; slug lookups; follow create/list.

**Frontend.** None (bot only).

**Testing.** Resolver unit tests (payload→creator, missing/invalid slug, no-payload fallback); multi-creator browse/entitlement integration (two creators, isolation); existing suite stays green; fakes mirror `findBySlug`/follows.

**Deployment.** Additive migration + backfill; same bot/token/webhook. No infra change.

**Risks.** Callback statelessness vs current-creator (mitigate with cache session + entity-implied creator); no-payload landing → discovery home, not a hardcoded creator; slug uniqueness/backfill ordering. *(All Low–Med; the handlers are already creator-parameterized.)*

---

## M7.1 — Creator dashboard

**Objective.** Creators log in to a web dashboard to manage profile, upload content, create/publish drops, set pricing, and view subscribers/basic analytics. **The content backend already exists** (`DropService`); this milestone is the **web + auth + API surface** over it.

**Reuse (from audit).** `DropService` (create/addAsset/publish/list — creator-scoped, ownership-checked), `SubscriptionService`/plans, `AccessService`, `AuditService`, `ContentProvider` (uploads), and critically the **M6 `HttpServer`** as the mount point for API routes.

**Build (net-new, but bounded).**
- **API adapter** `src/adapters/api/` — REST/JSON routes mounted on the existing `HttpServer`; each route resolves the authenticated creator and calls core services with that `creatorId`. **Never** touches repos/DB directly.
- `IdentityProvider` seam + `CreatorIdentityService` — web login distinct from Telegram `users`. Use a **managed auth provider** (Supabase Auth or Clerk), not hand-rolled.
- `HttpServer.route` — add API path handling next to `/health` + webhook.
- Extend `config/env.ts` with auth/API keys.
- **Frontend** — a Next.js dashboard (separate `dashboard/` app or workspace) calling the API. Reuse the `frontend-design`/`shadcn` tooling available in-environment.

**Architecture decision to make first (flagged in audit).** Single deployable (API adapter in the current process, reusing core directly — simplest, fits the single-replica reality) **vs** a pnpm-workspace `core` package (ADR-014 anticipated the split). **Recommend:** single-process API adapter now; split to a package only when the dashboard needs its own deploy/region.

**Database.** `creator_identities` (auth external_id ↔ creator); `creators` profile columns (`avatar_url`, `links`, `theme`) nullable.

**Backend.** API adapter + identity service + auth middleware (verify token → creator).

**Frontend.** Login, profile, content upload (→ `ContentProvider.store` → `DropService.addAsset`), drop list/create/publish, pricing (plans), subscribers list, read-only analytics.

**Testing.** API contract tests; auth/identity mapping; tenant-ownership tests (creator A cannot touch creator B's drops — already enforced by `DropService`, assert it through the API); upload→draft→publish e2e.

**Deployment.** Dashboard app + auth provider; API mounted on the existing server. Still single replica.

**Risks (highest of the phase).** **Tenant safety without RLS** — API must go only through core services (guardrail #2); schedule **RLS activation right after the read path lands** as defense-in-depth. Web/auth is fully net-new — mitigate with managed auth + `HttpServer` reuse. Core-sharing decision (single process first).

---

## M7.2 — Creator onboarding (self-service)

**Objective.** A creator signs up and is productive without manual setup: account → verify → slug/profile → (shared-bot storefront live) → first drop → pricing → publish.

**Reuse.** M7.1 identity/API/dashboard; `CreatorService`; `CREATOR_STATUSES` already has `pending`/`active`/`suspended`; shared bot needs no per-creator setup (default).

**Build (extend).**
- `CreatorService.register`/`onboard` — create identity + creator (`pending`), reserve slug, transition to `active` on completion; audited.
- Onboarding API routes + guided dashboard flow; slug availability check; "your storefront link" (`t.me/PlatformBot?start=c_<slug>`) surfaced immediately.
- Bot-mode choice UI: **shared (default, instant)**; dedicated-bot option shown as a premium upgrade (implemented in M7.7).

**Database.** None beyond M7.1 (reuse `creators`/`creator_identities`); optionally add `creator_status` values `banned`/`payout_ready` (`ADD VALUE`, forward-only) if needed now.

**Backend.** Onboarding state machine + slug reservation (unique index from M7.0).

**Frontend.** Multi-step onboarding wizard.

**Testing.** State-machine unit tests (pending→active, idempotent re-entry); slug collision; audit assertions.

**Deployment.** Dashboard release; no schema/infra beyond M7.1.

**Risks.** Slug squatting/collisions (reserve on signup); abandoned-onboarding cleanup (a scheduled job later); KYC deferred to M7.5.

---

## M7.3 — Marketplace / discovery

**Objective.** Users discover creators inside the shared bot: browse creators, search, follow, and enter via deep-links. This is the network-effect surface unique to the shared bot.

**Reuse.** M7.0 slug/follows/resolver; existing browse/detail/views/keyboards; `CreatorService.listActive`; `AccessService` for per-creator entitlement.

**Build (extend).**
- Bot: `/discover` (featured/followed/paged creators), `/search <query>`, `/follow`/`/creators`; creator storefront view (profile + drop grid); deep-link entry already handled by M7.0.
- `CreatorService.search`/`listActive` (paged/ranked); follow-driven new-drop notifications via the existing `Notifier`/events.
- Views/keyboards for creator lists + storefront.

**Database.** `follows` (if deferred from M7.0); search indexes — `pg_trgm`/`tsvector` GIN on `creators.display_name`, `drops.title` (MVP-scale; `SearchProvider` port later for external engine).

**Backend.** Search/list queries; follow notifications wired to drop-publish events.

**Frontend.** None (bot); dashboard may show follower counts (reuse follows).

**Testing.** Search relevance/perf + tenant scoping; follow → notification flow; discovery pagination.

**Deployment.** Additive indexes; same bot.

**Risks.** Search relevance/index freshness (acceptable at pg_trgm scale); notification volume (rate-limited via `Notifier`/jobs — still single replica, watch throughput).

---

## M7.4 — Redis + horizontal scaling

**Objective.** Lift the single-replica ceiling now that adoption features exist. Shared rate limits + distributed job locks across replicas; Redis-backed live settings (debt #4).

**Reuse.** `CacheProvider` port (drop-in), scheduler locks, rate-limit middleware.

**Build.** `RedisCacheProvider` implementing `CacheProvider`; config; distributed job locks.

**Database.** None.

**Backend/Frontend.** Adapter + config; no frontend.

**Testing.** Cache integration; lock contention/idempotency under concurrency.

**Deployment.** Provision Railway Redis; raise `numReplicas` in `railway.json`.

**Risks.** Lock semantics, cache stampede. *(Medium.)*

---

## M7.5 — Real Telegram Stars + payout architecture

**Objective.** Real money in (Stars) and out (payouts + ledger). Keep the platform payment-provider agnostic.

**Reuse.** `PaymentProvider` port (swap `MockPaymentProvider`), `payments`/`purchases`, integer-money + in-tx audit, `PaymentProvider.refund` (repays debt #9).

**Build.** `TelegramStarsPaymentProvider` (pre_checkout + successful_payment + refund, 21-day payout awareness); new `PayoutProvider` (+ Stripe Connect for fiat later); double-entry-ish `ledger_entries`; commission model.

**Database.** `ledger_entries`, `payout_accounts`, `payouts`; `purchases.referral_id` (nullable).

**Backend.** Provider + ledger postings in-tx; payout flows; dashboard earnings/payouts; admin approval hooks.

**Frontend.** Earnings/payouts screens.

**Testing.** Money correctness + reconciliation; Stars payout timing; refund/dispute; KYC gating; ledger balance = sum invariant.

**Deployment.** Provider credentials; staged rollout.

**Risks.** **Financial correctness (highest)**, KYC/compliance, payout timing.

---

## M7.6 — Admin & operations

**Objective.** Operate the platform safely: creator management, moderation, payouts oversight, feature flags, support.

**Reuse.** `AuditService` (add `admin` actor), core services, `system_settings.updated_by` (reserved).

**Build.** Admin API + RBAC; moderation (takedown = unpublish, audited); feature-flag evaluation; support tools (refunds/comps via existing services).

**Database.** `feature_flags`, `content_reports`, `moderation_actions`, `team_members`; `audit_actor_type +admin`.

**Testing.** RBAC boundaries; audited actions; flag scoping.

**Deployment.** Restricted admin app.

**Risks.** Privilege boundaries; moderation workflows.

---

## M7.7 — White-label dedicated creator bots (premium upgrade)

**Objective.** Premium creators run their own branded Telegram bot — **on the same backend and handlers**, selected at the edge. Not a separate platform.

**Reuse.** `bot.ts` (`createTelegramWebhookHandler`/`registerTelegramWebhook`), `bot_settings` (tenant-scopable), `transport_cache` (already per-bot), all handlers/services; shared→dedicated handoff via deep-link.

**Build.** `BotRegistry` runtime managing N bots + per-bot webhook routing; `creator_bots` (encrypted token, webhook secret, mode, status); per-bot `ContentTransport`/`Notifier`; white-label branding/theme; connect flow in dashboard (validate via `getMe`).

**Database.** `creator_bots`.

**Testing.** Multi-bot routing; token security; per-bot `transport_cache` (repays debt #8 concerns).

**Deployment.** Webhook fan-in for N paths; secret management.

**Risks.** **Token custody/rotation**, N-webhook ops. *(High.)*

---

## M7.8 — Public API, mobile, AI, expansion adapters

**Objective.** Open the platform: public API, mobile clients, AI assistants, and new delivery channels — all as adapters over the unchanged core.

**Reuse.** Every core service; ports for new channels; M7.1 API foundation.

**Build.** Public REST/GraphQL API + `api_keys` (scoped, rate-limited via `CacheProvider`); additional `Notifier`/`ContentTransport` (email/push/Discord/WhatsApp); MCP tool adapter exposing core services; affiliate attribution.

**Database.** `api_keys`, `affiliates`, `referrals`.

**Testing.** API contract/rate-limit; channel adapters; affiliate attribution; RLS enforced for external clients.

**Deployment.** Per-adapter; ensure RLS is active before the public API ships.

**Risks.** API abuse; channel-specific quirks; RLS correctness for untrusted clients.

---

## Definition of done — adoption phase (M7.0–M7.3)

A creator can self-serve onboard, get a live shared-bot storefront via slug deep-link, upload and publish drops, set pricing, and see subscribers/analytics; a user can discover creators, follow them, deep-link into a storefront, and unlock/subscribe/receive content across multiple creators — all on the existing core, with per-creator tenant isolation enforced by the service layer, zero changes to entitlement/money invariants, and the full existing test suite green plus new multi-creator tests.

## Proposed ADRs (write when the work begins — not created here)
- **ADR-021** Hybrid bot model (`BotRegistry`/`CreatorResolver` edge; shared-default, dedicated-upgrade).
- **ADR-023** Creator web identity distinct from Telegram `users`.
- **ADR-025** RLS activation keyed on `creator_id` — scheduled right after M7.1's read path (moved earlier than the original evolution plan, per the dashboard tenant-safety risk).
- (ADR-022 outbox, ADR-024 payout/ledger — at M7.4/M7.5.)

---

*Plan complete. No code, migrations, or existing systems were modified. Awaiting approval before beginning M7.0.*
