---
name: verify
description: Verify core-layer changes by driving the real composition (services + Drizzle + mock payments + Supabase Storage) end-to-end against local Postgres. Use until the Telegram adapter (M4) provides a bot surface.
---

# Verifying this repo (pre-M4: no bot surface yet)

Until M4 lands, the only runtime surface is the **composition boundary** — wire
the core exactly the way `src/app.ts` will and drive the user journey.

## Handle

1. Local Postgres (disposable — integration tests DROP its schema):
   ```bash
   docker start creator-platform-test-pg 2>/dev/null || \
     docker run -d --name creator-platform-test-pg -e POSTGRES_PASSWORD=postgres -p 54329:5432 postgres:17
   ```
   Schema arrives via the integration global-setup (`TEST_DATABASE_URL=... pnpm test:integration`)
   or by running the drizzle migrator against it.
2. Write a tsx script that composes: `createDatabase` → `DrizzleUnitOfWork(db, dispatcher)`,
   real `MockPaymentProvider`, real `SupabaseStorageProvider` (dev creds from `.env`),
   `AccessService`/`AuditService`/`UserService`/`DropService`/`PurchaseService`/`SubscriptionService`,
   `DeliveryEngine`/`NotificationEngine`, and register the `core/events/handlers` on the dispatcher.
   Stub only the M4 ports (`ContentTransport`, `Notifier`) with console recorders.
3. Run it with env loaded: `set -a && source .env && set +a && VERIFY_DB_URL=postgresql://postgres:postgres@localhost:54329/postgres pnpm exec tsx <script>`.

## Flows worth driving

Register → browse → free delivery → premium locked → pay-per-unlock purchase
(mock latency) → replay same idempotency key (no second charge) → already-owned
guard → forced failure (`failureRate: 1`) → PaymentFailed notification →
subscribe → premium unlocks → advance an injected clock 31 days → `expireLapsed`
→ premium locks again → sweep re-run is a no-op → real Supabase Storage
store/signed-URL-fetch-over-HTTPS/delete → audit ledger contains the full action
vocabulary.

## Gotchas

- **Make the script re-runnable:** suffix telegram ids and idempotency keys with
  `Date.now()` — the DB persists between runs, and replayed keys take the
  idempotency path instead of charging (correct behavior that breaks naive asserts).
- The sweep may expire integration-test leftovers too — assert `>= 1` plus "my
  subscription specifically locked", not an exact count.
- Time travel: inject an adjustable `Clock` into the composition; never sleep.
- The seed export is `SEED_IDS` (deterministic `5eed…` uuids) from
  `src/adapters/persistence/db/seed.ts`.
