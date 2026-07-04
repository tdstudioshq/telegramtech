# Development Setup (Revision 2)

## Prerequisites
Node 22 LTS (.nvmrc) · pnpm ≥ 9 via corepack · Supabase project (Postgres + a **private** Storage bucket named `drops`) · dev bot token from @BotFather (never the prod token) · GitHub repo (CI runs from M1).

## First-time setup (once implementation exists)
```bash
pnpm install
cp .env.example .env       # fill values below
pnpm db:migrate            # reviewed migrations only
pnpm db:seed               # creator, Premium plan, free/premium/unlock sample drops, settings
pnpm dev
```

## Environment variables (`.env.example`)
All validated in `src/config/env.ts` (Zod). Invalid/missing → exact offending keys printed, exit 1, nothing connects.

```bash
# Runtime
NODE_ENV=development
LOG_LEVEL=debug

# Telegram (first client adapter)
BOT_TOKEN=
BOT_MODE=polling                   # polling | webhook
WEBHOOK_URL=                       # webhook mode only
WEBHOOK_SECRET_TOKEN=              # webhook mode only
PORT=3000                          # webhook listener (Railway injects this)

# Database (Supabase → Settings → Database)
DATABASE_URL=                      # pooler, transaction mode, port 6543 (prepare:false)
DATABASE_DIRECT_URL=               # port 5432 — migrations only

# Content storage (Supabase Storage — ADR-006)
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=         # used ONLY by SupabaseStorageProvider; redacted in logs
STORAGE_BUCKET=drops
SIGNED_URL_TTL_SECONDS=120

# Payments
PAYMENT_PROVIDER=mock              # mock | telegram_stars (reserved)
MOCK_PAYMENT_DELAY_MS=500
MOCK_PAYMENT_FAILURE_RATE=0        # 0..1 — set >0 to exercise failure UX (Q4)

# Cache
CACHE_PROVIDER=memory              # memory | noop | redis (reserved)
REDIS_URL=                         # reserved

# Jobs (minutes)
JOB_SUBSCRIPTION_SWEEP_INTERVAL=5
JOB_NOTIFICATION_INTERVAL=1
JOB_CLEANUP_INTERVAL=30
PENDING_PAYMENT_TTL_MINUTES=15     # cleanup: pending older than this → failed

# Rate limiting
RATE_LIMIT_POINTS=20
RATE_LIMIT_WINDOW_SECONDS=60
```

Rules: `.env` gitignored; `.env.example` is the config documentation; prod values only in Railway secrets; `process.env` read nowhere except `config/env.ts`.

## Scripts (planned)
`dev` (tsx watch + pino-pretty) · `build`/`start` · `db:generate` / `db:migrate` / `db:seed` · `test` / `test:watch` / `test:integration` · `lint` / `format` / `typecheck`.

## CI (Q5 — from M1)
`.github/workflows/ci.yml` on push/PR: install (pnpm cache) → `typecheck` → `lint` (includes architecture boundary rules — violations fail the build) → `test` (unit). Integration tests local/on-demand until a test-DB job is added (debt #10).

## Testing strategy
- **Unit (majority):** core services/engines/dispatcher with fakes (`tests/fakes/`: in-memory repos, FakeClock, FakePaymentProvider with scriptable outcomes, in-memory ContentProvider, NoopCache). Zero mocking libraries needed because core has zero adapter imports.
- **Integration:** repositories + constraints against real Postgres (Docker or Supabase branch): idempotency uniqueness, one-active-sub, one-live-grant, entitlement predicate, pooler `prepare:false`.
- **Event tests:** after-commit dispatch ordering; a throwing handler never fails the request; handler idempotency.
- **Expiration:** always FakeClock, never sleeps.
- **Not in MVP:** live-bot e2e (manual QA checklist in ROADMAP).

## Supabase one-time setup (added Session 4 — M2)

**Credentials → `.env`** (project → Settings):
- `DATABASE_URL` — Settings → Database → Connection string → *Transaction pooler*, port **6543** (runtime; `prepare:false` is set in code).
- `DATABASE_DIRECT_URL` — same page, *Direct connection*, port **5432** (migrations only). Both require the database password.
- `SUPABASE_SERVICE_ROLE_KEY` — Settings → API → the **secret** key (`sb_secret_…`/service_role). The publishable/anon key is client-side and is never used by this app.

**Private `drops` bucket** (bucket creation is manual — do once per project):
- Dashboard: Storage → *New bucket* → name `drops` → **Public bucket OFF** → create. — or —
- SQL editor: `insert into storage.buckets (id, name, public) values ('drops', 'drops', false) on conflict (id) do nothing;`
- Verify: Storage page lists `drops` with a lock (private) badge.

**Apply migrations + seed** (after human review of the SQL in `src/adapters/persistence/db/migrations/`):
```bash
pnpm db:migrate   # uses DATABASE_DIRECT_URL
pnpm db:seed      # idempotent; uses DATABASE_URL
```

**Integration tests locally** (real Postgres via Docker; never point them at a shared DB — global setup DROPS the schema):
```bash
docker run -d --name creator-platform-test-pg -e POSTGRES_PASSWORD=postgres -p 54329:5432 postgres:17
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:54329/postgres pnpm test:integration
```
