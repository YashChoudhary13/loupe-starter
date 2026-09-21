# Dispatch Tracking — Implementation Plan, part 1 of 5 (types, carrier detection, schema)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/dispatch` page in Loupe where operators stage tracking numbers against In-progress Shopify orders, group orders that share a parcel, and push fulfilments with carrier and tracking number.

**Architecture:** Pure logic (`carrier.ts`, `plan.ts`, `push.ts`) is separated from Shopify I/O (`dispatch-orders.ts`) and Supabase I/O (`store.ts`), so every safety rule is unit-tested with fakes. Staged parcels live in two Supabase tables that double as push history. The plan is split into five files so each stays under 500 lines; do them in order.

**Tech Stack:** Next.js App Router, TypeScript, Supabase Postgres (service role, RLS deny-all), Shopify Admin GraphQL via `ShopifyClient`, vitest (`environment: 'node'`).

**Spec:** `docs/superpowers/specs/2026-09-21-dispatch-tracking-design.md`

## Plan files

1. `2026-09-21-dispatch-tracking-1-types-schema.md` — Tasks 1–2: types, carrier detection, schema
2. `2026-09-21-dispatch-tracking-2-shopify-plan.md` — Tasks 3–4: Shopify reads and mutation, push decision
3. `2026-09-21-dispatch-tracking-3-push.md` — Task 5: push orchestration
4. `2026-09-21-dispatch-tracking-4-store-actions.md` — Tasks 6–7: Supabase store, server actions
5. `2026-09-21-dispatch-tracking-5-screen-rollout.md` — Tasks 8–10: row model, screen, docs, rollout

## Global Constraints

- Work only in `/Users/yash/Desktop/Qimati-worktrees/loupe-dispatch` on branch `claude/dispatch`. Commit locally; **never push** — a push to `main` deploys production.
- Read `docs/PROGRESS.md` (top entries) before starting; append an entry when done (Task 10).
- No automated test and no script may fulfil, edit or message a real order. Shopify is faked at the `ShopifyClient` boundary.
- Carrier strings are exactly `DTDC`, `India Post`, `Tirupati Courier`.
- Tracking numbers are stored normalised: no spaces, upper case, 6–30 characters of `[0-9A-Z]`.
- `notifyCustomer: true` on every fulfilment. No tracking URL is sent.
- Only fulfilment orders with status `IN_PROGRESS` are fulfilled. `OPEN`, `ON_HOLD`, `SCHEDULED` are never touched.
- Mutations use a `ShopifyClient` built with `retryDelaysMs: [0]` (one attempt). After any mutation, success or error, the order is re-read before a result is recorded.
- Every table: RLS enabled, zero policies, `service_role` only. No customer name, phone or address is stored.
- Every source file stays under 500 lines. Match the terse single-line style of `src/lib/qc/*.ts`.
- Run focused tests with `npx vitest run tests/<file>`; never run the whole suite (some files write to the real Supabase project).

---

### Task 1: Types and carrier detection

**Files:**
- Create: `src/lib/dispatch/types.ts`
- Create: `src/lib/dispatch/carrier.ts`
- Test: `tests/dispatch-carrier.test.ts`

**Interfaces:**
- Produces: `CARRIERS`, `Carrier`, `ParcelOrderStatus`, `DispatchOrderSummary`, `DispatchFulfillmentOrder`, `DispatchOrderSnapshot`, `PushPlan`, `ParcelOrderRow`, `ParcelRow` (types.ts); `normalizeTracking(input: string): string`, `trackingProblem(value: string): string | null`, `detectCarrier(value: string): Carrier | null`, `parseCarrier(value: unknown): Carrier`, `resolveCarrier(current, tracking, manual)` (carrier.ts).

- [ ] **Step 1: Write the types**

```ts
// src/lib/dispatch/types.ts
export const CARRIERS = ['DTDC', 'India Post', 'Tirupati Courier'] as const
export type Carrier = (typeof CARRIERS)[number]
export type ParcelOrderStatus = 'staged' | 'pushing' | 'fulfilled' | 'failed'

/** One listed Shopify order. `addressKey` is a hash that only answers "same destination?"; it is never shown. */
export interface DispatchOrderSummary { id: string; name: string; createdAt: string; customer: string; addressKey: string }

export interface DispatchFulfillmentOrder {
  id: string; status: string; canFulfil: boolean; remaining: number; locationId: string | null
  /** False when Shopify returned more than one page of lines, so `remaining` cannot be trusted. */
  complete: boolean
}
export interface DispatchOrderSnapshot {
  id: string; name: string; closed: boolean; cancelledAt: string | null
  fulfillmentOrders: DispatchFulfillmentOrder[]
  fulfillmentOrdersComplete: boolean
  fulfillments: { id: string; status: string; tracking: { company: string | null; number: string | null }[] }[]
}
export type PushPlan =
  | { kind: 'fulfil'; fulfillmentOrderIds: string[] }
  | { kind: 'done'; fulfillmentId: string }
  | { kind: 'refuse'; reason: string }

export interface ParcelOrderRow { id: string; parcel_id: string; order_id: string; order_name: string; position: number; status: ParcelOrderStatus; fulfillment_id: string | null; error: string | null; push_started_at: string | null; finished_at: string | null }
export interface ParcelRow { id: string; tracking_number: string | null; carrier: Carrier | null; carrier_source: 'auto' | 'manual'; staged_by: string; staged_at: string; pushed_by: string | null; pushed_at: string | null; orders: ParcelOrderRow[] }
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/dispatch-carrier.test.ts
import { describe, expect, it } from 'vitest'
import { detectCarrier, normalizeTracking, parseCarrier, resolveCarrier, trackingProblem } from '@/lib/dispatch/carrier'

describe('tracking numbers', () => {
  it('normalises spaces and case', () => { expect(normalizeTracking('  x12 345 678a ')).toBe('X12345678A') })
  it('accepts 6 to 30 letters and digits only', () => {
    expect(trackingProblem('X1234')).toMatch(/6 to 30/)
    expect(trackingProblem('X'.repeat(31))).toMatch(/6 to 30/)
    expect(trackingProblem('X1234-567')).toMatch(/letters and digits/)
    expect(trackingProblem('X1234567')).toBeNull()
  })
})
describe('carrier detection', () => {
  it.each([['X1234567890', 'DTDC'], ['D9876543210', 'DTDC'], ['ER123456789IN', 'India Post'], ['884512209', 'Tirupati Courier']])('%s is %s', (value, carrier) => { expect(detectCarrier(value)).toBe(carrier) })
  it('leaves anything else to the operator', () => { expect(detectCarrier('AB12345678')).toBeNull(); expect(detectCarrier('E12345678')).toBeNull() })
  it('rejects a carrier that is not one of the three', () => { expect(() => parseCarrier('BlueDart')).toThrow(/carrier/i); expect(parseCarrier('India Post')).toBe('India Post') })
})
describe('carrier resolution while staging', () => {
  it('an explicit choice wins and is remembered as manual', () => { expect(resolveCarrier({ carrier: 'DTDC', source: 'auto' }, '884512209', 'India Post')).toEqual({ carrier: 'India Post', source: 'manual' }) })
  it('a manual choice survives an edit to the number', () => { expect(resolveCarrier({ carrier: 'India Post', source: 'manual' }, 'X1234567', undefined)).toEqual({ carrier: 'India Post', source: 'manual' }) })
  it('an empty choice returns the row to detection', () => { expect(resolveCarrier({ carrier: 'India Post', source: 'manual' }, 'X1234567', '')).toEqual({ carrier: 'DTDC', source: 'auto' }) })
  it('detects when nothing was chosen, and clears with the number', () => {
    expect(resolveCarrier(null, 'ER123456789IN', undefined)).toEqual({ carrier: 'India Post', source: 'auto' })
    expect(resolveCarrier({ carrier: 'DTDC', source: 'auto' }, '', undefined)).toEqual({ carrier: null, source: 'auto' })
  })
})
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run tests/dispatch-carrier.test.ts`
Expected: FAIL — cannot resolve `@/lib/dispatch/carrier`.

- [ ] **Step 4: Implement**

```ts
// src/lib/dispatch/carrier.ts
import { CARRIERS, type Carrier } from './types'

export function normalizeTracking(input: string): string { return input.replace(/\s+/g, '').toUpperCase() }

/** A sentence for the operator, or null when the (already normalised) number is acceptable. */
export function trackingProblem(value: string): string | null {
  if (value.length < 6 || value.length > 30) return 'A tracking number is 6 to 30 characters.'
  if (!/^[0-9A-Z]+$/.test(value)) return 'Use letters and digits only in a tracking number.'
  return null
}

/** Owner's rules, 2026-09-21: ER → India Post; X or D → DTDC (D only "sometimes", so the select stays editable); digits → Tirupati. */
export function detectCarrier(value: string): Carrier | null {
  if (/^ER[0-9A-Z]+$/.test(value)) return 'India Post'
  if (/^[XD][0-9A-Z]+$/.test(value)) return 'DTDC'
  if (/^[0-9]+$/.test(value)) return 'Tirupati Courier'
  return null
}

export function parseCarrier(value: unknown): Carrier {
  if (typeof value === 'string' && (CARRIERS as readonly string[]).includes(value)) return value as Carrier
  throw new Error(`Choose a carrier: ${CARRIERS.join(', ')}.`)
}

/** `manual`: undefined = operator did not touch the select, '' = back to automatic, otherwise their choice. */
export function resolveCarrier(current: { carrier: Carrier | null; source: 'auto' | 'manual' } | null, tracking: string, manual: string | undefined): { carrier: Carrier | null; source: 'auto' | 'manual' } {
  if (manual) return { carrier: parseCarrier(manual), source: 'manual' }
  if (manual === undefined && current?.source === 'manual') return { carrier: current.carrier, source: 'manual' }
  return { carrier: tracking ? detectCarrier(tracking) : null, source: 'auto' }
}
```

- [ ] **Step 5: Run the test, then typecheck**

Run: `npx vitest run tests/dispatch-carrier.test.ts && npm run typecheck`
Expected: all tests PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/dispatch/types.ts src/lib/dispatch/carrier.ts tests/dispatch-carrier.test.ts
git commit -m "feat(dispatch): tracking-number normalisation and carrier detection (X/D DTDC, ER India Post, digits Tirupati)"
```


---

### Task 2: Migration and local Postgres proof

**Files:**
- Create: `supabase/migrations/20260921100000_dispatch.sql`
- Create: `scripts/verify-dispatch-local-db.ts`

**Interfaces:**
- Produces: tables `public.dispatch_parcels`, `public.dispatch_parcel_orders`; unique index `dispatch_open_order_idx`.

- [ ] **Step 1: Write the migration**

```sql
-- Dispatch: tracking numbers staged against In-progress Shopify orders, then pushed as fulfilments.
-- A parcel carries one tracking number; one or more orders travel in it. The same rows are the push history.
create table public.dispatch_parcels (
  id uuid primary key default gen_random_uuid(),
  shop_domain text not null,
  tracking_number text check (tracking_number ~ '^[0-9A-Z]{6,30}$'),
  carrier text check (carrier in ('DTDC','India Post','Tirupati Courier')),
  carrier_source text not null default 'auto' check (carrier_source in ('auto','manual')),
  staged_by text not null,
  staged_at timestamptz not null default now(),
  pushed_by text,
  pushed_at timestamptz,
  check ((pushed_at is null) = (pushed_by is null))
);
create table public.dispatch_parcel_orders (
  id uuid primary key default gen_random_uuid(),
  parcel_id uuid not null references public.dispatch_parcels(id) on delete cascade,
  shop_domain text not null,
  order_id text not null check (order_id ~ '^gid://shopify/Order/[0-9]+$'),
  order_name text not null,
  position integer not null default 0 check (position >= 0),
  status text not null default 'staged' check (status in ('staged','pushing','fulfilled','failed')),
  fulfillment_id text,
  error text,
  request_id uuid,
  push_started_at timestamptz,
  finished_at timestamptz,
  check ((status = 'fulfilled') = (fulfillment_id is not null)),
  unique (parcel_id, position)
);
-- An order sits in at most one open parcel; a fulfilled row is history and no longer blocks.
create unique index dispatch_open_order_idx on public.dispatch_parcel_orders(shop_domain, order_id) where status <> 'fulfilled';
create index dispatch_parcel_orders_parcel_idx on public.dispatch_parcel_orders(parcel_id);
create index dispatch_parcels_pushed_idx on public.dispatch_parcels(shop_domain, pushed_at desc) where pushed_at is not null;
alter table public.dispatch_parcels enable row level security;
alter table public.dispatch_parcel_orders enable row level security;
revoke all on public.dispatch_parcels, public.dispatch_parcel_orders from public, anon, authenticated;
grant select, insert, update, delete on public.dispatch_parcels, public.dispatch_parcel_orders to service_role;
comment on table public.dispatch_parcels is 'One tracking number and carrier, staged in /dispatch and pushed to Shopify as fulfilments. No customer information is stored.';
comment on table public.dispatch_parcel_orders is 'Orders travelling in a parcel, with the per-order push result. position 0 is the row the parcel was started from.';
```

- [ ] **Step 2: Write the proof script** (modelled on `scripts/verify-qc-shortages-local-db.ts`: temporary local PostgreSQL, no `.env`, no network)

```ts
// scripts/verify-dispatch-local-db.ts
/** Isolated proof of the dispatch schema. Temporary local PostgreSQL only; no .env, no network. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'

async function main() {
  const bin = process.env.LOUPE_TEST_PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin'
  const root = mkdtempSync(join(tmpdir(), 'loupe-dispatch-'))
  execFileSync(join(bin, 'initdb'), ['-D', join(root, 'data'), '-U', 'loupe_test', '-A', 'trust', '--no-locale'], { stdio: 'pipe' })
  const child = spawn(join(bin, 'postgres'), ['-D', join(root, 'data'), '-h', '', '-k', root, '-p', '55440'], { stdio: 'ignore' })
  const pool = new Pool({ host: root, port: 55440, user: 'loupe_test', database: 'postgres' })
  const checks: string[] = []
  const refuses = async (name: string, sql: string, params: unknown[] = []) => { await assert.rejects(pool.query(sql, params), undefined, name); checks.push(name) }
  try {
    for (let attempt = 0; ; attempt++) { try { await pool.query('select 1'); break } catch (error) { if (attempt > 49) throw error; await new Promise(r => setTimeout(r, 100)) } }
    await pool.query('create role anon; create role authenticated; create role service_role bypassrls;')
    await pool.query(readFileSync('supabase/migrations/20260921100000_dispatch.sql', 'utf8'))
    const shop = 'dispatch-test.myshopify.com', order = 'gid://shopify/Order/1'
    const parcel = async (tracking: string | null = 'X1234567') => (await pool.query("insert into public.dispatch_parcels(shop_domain,tracking_number,carrier,staged_by) values($1,$2,'DTDC','op@example.test') returning id", [shop, tracking])).rows[0].id as string
    const a = await parcel(), b = await parcel('X7654321')
    await pool.query('insert into public.dispatch_parcel_orders(parcel_id,shop_domain,order_id,order_name) values($1,$2,$3,$4)', [a, shop, order, 'Qimati1'])
    await refuses('an order cannot sit in two open parcels', 'insert into public.dispatch_parcel_orders(parcel_id,shop_domain,order_id,order_name) values($1,$2,$3,$4)', [b, shop, order, 'Qimati1'])
    await refuses('fulfilled needs a fulfilment id', "update public.dispatch_parcel_orders set status='fulfilled' where parcel_id=$1", [a])
    await pool.query("update public.dispatch_parcel_orders set status='fulfilled', fulfillment_id='gid://shopify/Fulfillment/9', finished_at=now() where parcel_id=$1", [a])
    await pool.query('insert into public.dispatch_parcel_orders(parcel_id,shop_domain,order_id,order_name) values($1,$2,$3,$4)', [b, shop, order, 'Qimati1'])
    checks.push('a fulfilled row no longer blocks a new parcel for the same order')
    await refuses('tracking numbers are stored normalised', "insert into public.dispatch_parcels(shop_domain,tracking_number,staged_by) values($1,'x12 34','op')", [shop])
    await refuses('carrier is one of the three', "insert into public.dispatch_parcels(shop_domain,carrier,staged_by) values($1,'BlueDart','op')", [shop])
    await refuses('two orders cannot share a position', 'insert into public.dispatch_parcel_orders(parcel_id,shop_domain,order_id,order_name,position) values($1,$2,$3,$4,0)', [b, shop, 'gid://shopify/Order/2', 'Qimati2'])
    await pool.query('delete from public.dispatch_parcels where id=$1', [b])
    assert.equal((await pool.query('select count(*)::int as n from public.dispatch_parcel_orders where parcel_id=$1', [b])).rows[0].n, 0); checks.push('deleting a parcel removes its orders')
    const anon = await pool.connect()
    try { await anon.query('set role anon'); await assert.rejects(anon.query('select 1 from public.dispatch_parcels')); checks.push('anon cannot read') } finally { await anon.query('reset role'); anon.release() }
    console.log(`dispatch schema proof: ${checks.length} checks passed\n- ${checks.join('\n- ')}`)
  } finally { await pool.end(); child.kill('SIGINT') }
}
main().catch(error => { console.error(error); process.exit(1) })
```

- [ ] **Step 3: Run the proof**

Run: `npx tsx scripts/verify-dispatch-local-db.ts`
Expected: `dispatch schema proof: 8 checks passed` followed by the eight names. If PostgreSQL 17 is elsewhere, set `LOUPE_TEST_PG_BIN`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260921100000_dispatch.sql scripts/verify-dispatch-local-db.ts
git commit -m "feat(dispatch): parcels and parcel-order tables; an order sits in at most one open parcel"
```

Do **not** apply the migration to production here; that is Task 10 (`2026-09-21-dispatch-tracking-5-screen-rollout.md`).


---

Continue with `2026-09-21-dispatch-tracking-2-shopify-plan.md`.
