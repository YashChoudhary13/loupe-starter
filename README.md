# Loupe — Qimati listing console

Internal tool for [qimati.in](https://qimati.in), a wholesale jewellery Shopify store in
Jaipur. It replaces a manual process where one person enhanced photos across five ChatGPT tabs
and hand-typed every Shopify listing.

**Next.js 16 (App Router) · TypeScript strict · Tailwind v4 · Supabase Postgres · Cloudflare R2 · Vercel**

> **Phase 1 of 5 is complete.** Database schema, seed data and the atomic SKU counter exist.
> There is no operator interface yet — the only page is `/health`. Shopify, Google Drive, R2,
> image enhancement and sign-in are all later phases.

---

## Running it

```bash
npm install
cp .env.local.example .env      # then fill it in — see Environment below
npm run dev                     # http://localhost:3000/health
```

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` | Production build |
| `npm test` | Full suite against the real Supabase project (44 tests) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run db:push` | Apply pending migrations in `supabase/migrations/` |
| `npm run db:reset -- --yes` | **Destructive.** Drop `public` and reapply every migration |
| `npm run seed:admin` | Seed `SEED_ADMIN_EMAIL` into `app_users` as admin (idempotent) |
| `npm run verify:isolation` | Prove the service-role key cannot reach a client component |
| `npm run verify:sku-control` | Run the SKU counter against its known-broken control |

The tests talk to the real database on purpose. A mocked counter proves nothing about
Postgres row locks, which is the entire mechanism under test.

## Environment

`.env` (gitignored) holds live production credentials for a real Shopify store.
`.env.local.example` is the committed template — **never put real values in it**.

`SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_DB_PASSWORD` are different credentials: the first is
a JWT for the PostgREST API, the second authenticates a Postgres wire connection. `db:push`
needs the second.

## The one thing to know

SKU numbers come from `public.next_sku()`, a single `UPDATE … RETURNING` whose row lock
serialises concurrent allocators. The live store already carries **two different products on
SKU `RS221`** because this was once done as a read followed by a write.

Measured, under 100 genuinely concurrent calls:

| Implementation | Distinct SKUs for 100 products |
|---|---|
| `next_sku()` — one `UPDATE … RETURNING` | **100** |
| SELECT then UPDATE | **13** |

Never rewrite it as two statements. `docs/DECISIONS.md` D2 and D16.

---

## Repository

```
CLAUDE.md              auto-loaded every session — domain facts, hard rules, session protocol
.env.local.example     credential template, no real values
src/
  app/                 App Router. /health is the only page in Phase 1
  lib/supabase/        server.ts (service_role, server-only) · browser.ts (publishable key)
supabase/migrations/   14 migrations — schema, RLS deny-all, seed. Never hand-edit the schema
scripts/               migration runner, seeding, and the two verification proofs
tests/                 concurrency · schema invariants · RLS
docs/
  PROGRESS.md          the project's memory. Read first, append last, every session
  DECISIONS.md         settled architectural choices + why
  DESIGN.md            design tokens and component rules
  phases/              one build prompt per phase
design/                console-mockup.html · tracking-mockup.html — open in a browser
```

## How to run a build session

1. Open Claude Code in the repo root. `CLAUDE.md` loads automatically and tells it to read
   `docs/PROGRESS.md` first.
2. Paste the contents of the next `docs/phases/PHASE-N-*.md` fence.
3. Hold it to the success criteria at the bottom of that prompt before accepting the phase as
   done.
4. Confirm it appended to `PROGRESS.md` before you close the session. If it didn't, ask it to
   — that file is why next week's session still knows what's going on.

**One phase per session.** Don't paste Phase 3 into the session that just finished Phase 2 —
fresh context, one goal, verifiable outcome.
