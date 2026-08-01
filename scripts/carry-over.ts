import 'dotenv/config'

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { pgClient } from './lib/pg'

/**
 * Carries the state that migrations CANNOT rebuild from one Supabase project to
 * another.
 *
 * Almost everything in this database is reproducible: run the migrations against
 * an empty project and the schema, the RLS denial, the categories, the materials
 * and every prompt version come back identical. Three things do not, because
 * they are the record of decisions made through the console after deployment:
 *
 *   1. sku_counters       — THE DANGEROUS ONE. Migrations seed these from the
 *                           live store's maxima. Every number issued since is
 *                           invisible to them, so a fresh project re-issues SKUs
 *                           that already exist on real products. Shopify enforces
 *                           no uniqueness on SKU and accepts the collision in
 *                           silence (hard rule 1). This is exactly how RS221 came
 *                           to be on two different rings.
 *   2. prompt models      — chosen in /prompts, stored on the live prompt row.
 *                           A replay resets both stages to the seeded defaults.
 *   3. app_users          — membership IS the authorisation rule. An empty table
 *                           means nobody can sign in, including you.
 *
 * Counters are raised through public.raise_sku_counter(), which is monotone —
 * greatest(last_number, target). It physically cannot lower a counter, so this
 * is safe to re-run and safe to run in either direction. Never replace it with
 * an UPDATE.
 *
 * Usage:
 *   npm run carry:export      # against the OLD project's credentials
 *   ...point .env at the NEW project, run db:push...
 *   npm run carry:apply       # against the NEW project's credentials
 */

const SNAPSHOT = resolve(process.cwd(), 'carry-over.json')

interface Snapshot {
  readonly takenAt: string
  readonly sourceProjectRef: string
  readonly counters: readonly { sku_prefix: string; last_number: number }[]
  readonly promptModels: readonly { kind: 'describe' | 'image'; model: string }[]
  readonly presetSlug: { describe: string | null; image: string | null }
  readonly users: readonly { email: string; name: string | null; role: string; active: boolean }[]
}

async function exportSnapshot(): Promise<void> {
  const client = pgClient()
  await client.connect()
  try {
    const counters = await client.query<{ sku_prefix: string; last_number: number }>(
      'select sku_prefix, last_number from public.sku_counters order by sku_prefix',
    )
    const prompts = await client.query<{
      kind: 'describe' | 'image'
      model: string
      preset_slug: string | null
    }>(
      `select kind, model, preset_slug
         from public.prompts
        where is_default and archived_at is null
        order by kind`,
    )
    const users = await client.query<{
      email: string
      name: string | null
      role: string
      active: boolean
    }>('select email, name, role, active from public.app_users order by email')

    const snapshot: Snapshot = {
      takenAt: new Date().toISOString(),
      sourceProjectRef: process.env.SUPABASE_PROJECT_REF ?? 'unknown',
      counters: counters.rows,
      promptModels: prompts.rows.map((row) => ({ kind: row.kind, model: row.model })),
      presetSlug: {
        describe: prompts.rows.find((r) => r.kind === 'describe')?.preset_slug ?? null,
        image: prompts.rows.find((r) => r.kind === 'image')?.preset_slug ?? null,
      },
      users: users.rows,
    }

    writeFileSync(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`)
    console.log(`Wrote ${SNAPSHOT}`)
    console.log(`  source project   ${snapshot.sourceProjectRef}`)
    console.log(`  sku counters     ${snapshot.counters.length}`)
    console.log(`  prompt models    ${snapshot.promptModels.map((p) => `${p.kind}=${p.model}`).join('  ')}`)
    console.log(`  console users    ${snapshot.users.length}`)
  } finally {
    await client.end()
  }
}

async function applySnapshot(): Promise<void> {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Snapshot
  const target = process.env.SUPABASE_PROJECT_REF ?? 'unknown'
  if (target === snapshot.sourceProjectRef) {
    throw new Error(
      `.env still points at ${target}, the project this snapshot came FROM. ` +
        'Point it at the new project before applying.',
    )
  }

  const client = pgClient()
  await client.connect()
  try {
    console.log(`Applying ${snapshot.sourceProjectRef} → ${target}`)

    // Monotone. A counter already ahead of the snapshot is left alone, so this
    // cannot walk a sequence backwards even if run in the wrong direction.
    for (const counter of snapshot.counters) {
      const before = await client.query<{ last_number: number }>(
        'select last_number from public.sku_counters where sku_prefix = $1',
        [counter.sku_prefix],
      )
      if (before.rowCount === 0) {
        console.log(`  ${counter.sku_prefix}  SKIPPED — no such prefix on the target`)
        continue
      }
      await client.query('select public.raise_sku_counter($1, $2)', [
        counter.sku_prefix,
        counter.last_number,
      ])
      const after = await client.query<{ last_number: number }>(
        'select last_number from public.sku_counters where sku_prefix = $1',
        [counter.sku_prefix],
      )
      const from = before.rows[0]!.last_number
      const to = after.rows[0]!.last_number
      console.log(
        `  ${counter.sku_prefix.padEnd(4)} ${String(from).padStart(4)} → ${String(to).padStart(4)}` +
          (to === from ? '  (already ahead)' : ''),
      )
    }

    for (const prompt of snapshot.promptModels) {
      await client.query('select public.select_prompt_model($1, $2, $3)', [
        prompt.kind,
        prompt.model,
        'script:carry-over',
      ])
      console.log(`  prompt ${prompt.kind} model → ${prompt.model}`)
    }

    for (const [kind, slug] of Object.entries(snapshot.presetSlug)) {
      if (slug) console.log(`  note: ${kind} was on style preset "${slug}" — set it in /prompts`)
    }

    for (const user of snapshot.users) {
      await client.query(
        `insert into public.app_users (email, name, role, active)
         values ($1, $2, $3, $4)
         on conflict (email) do update
            set name = excluded.name, role = excluded.role, active = excluded.active`,
        [user.email, user.name, user.role, user.active],
      )
      console.log(`  user ${user.email} (${user.role})`)
    }

    console.log('Done.')
  } finally {
    await client.end()
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  if (mode === 'export') return exportSnapshot()
  if (mode === 'apply') return applySnapshot()
  throw new Error('Usage: tsx scripts/carry-over.ts <export|apply>')
}

main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : String(cause))
  process.exit(1)
})
