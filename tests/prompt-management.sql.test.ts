import type { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { pgClient } from '../scripts/lib/pg'

let db: Client

beforeAll(async () => {
  db = pgClient()
  await db.connect()
})

beforeEach(async () => {
  await db.query('begin')
})

afterEach(async () => {
  await db.query('rollback')
})

afterAll(async () => {
  await db.end()
})

async function currentPrompt(kind: 'describe' | 'image') {
  const result = await db.query<{
    id: string
    name: string
    body: string
    model: string
  }>(
    `select id, name, body, model
       from public.prompts
      where kind = $1 and is_default and archived_at is null`,
    [kind],
  )
  expect(result.rowCount).toBe(1)
  return result.rows[0]!
}

describe('deployed append-only prompt management', () => {
  it('creates a version without changing the current prompt, then promotes it atomically', async () => {
    const current = await currentPrompt('describe')
    const created = await db.query<{ create_prompt_version: string }>(
      `select public.create_prompt_version($1, $2, $3, $4, $5)`,
      [
        'describe',
        'Phase 5 transaction fixture',
        `${current.body}\n\n`,
        current.model,
        'test:phase5-prompts',
      ],
    )
    const createdId = created.rows[0]!.create_prompt_version

    expect((await currentPrompt('describe')).id).toBe(current.id)
    const ready = await db.query<{
      is_default: boolean
      archived_at: Date | null
      created_by: string
    }>(
      `select is_default, archived_at, created_by
         from public.prompts
        where id = $1`,
      [createdId],
    )
    expect(ready.rows[0]).toMatchObject({
      is_default: false,
      archived_at: null,
      created_by: 'test:phase5-prompts',
    })

    const promoted = await db.query<{ promote_prompt_version: string }>(
      `select public.promote_prompt_version($1, $2)`,
      [createdId, 'test:phase5-prompts'],
    )
    expect(promoted.rows[0]!.promote_prompt_version).toBe(createdId)
    expect((await currentPrompt('describe')).id).toBe(createdId)

    const count = await db.query<{ count: string }>(
      `select count(*)
         from public.prompts
        where kind = 'describe' and is_default and archived_at is null`,
    )
    expect(Number(count.rows[0]!.count)).toBe(1)

    const events = await db.query<{ event: string; actor: string }>(
      `select event, actor
         from public.events
        where entity_id = $1
        order by id`,
      [createdId],
    )
    expect(events.rows).toEqual([
      { event: 'prompt.version_created', actor: 'test:phase5-prompts' },
      { event: 'prompt.promoted', actor: 'test:phase5-prompts' },
    ])
  })

  it('reads a missing composition token as a self-staging prompt, not an error', async () => {
    const current = await currentPrompt('image')
    const selfStaging = current.body.replace('{{COMPOSITION_DETAIL}}', '')

    const created = await db.query<{ create_prompt_version: string }>(
      `select public.create_prompt_version($1, $2, $3, $4, $5)`,
      ['image', 'Self-staging fixture', selfStaging, current.model, 'test:phase5-prompts'],
    )
    const saved = await db.query<{ uses_composition: boolean }>(
      `select uses_composition from public.prompts where id = $1`,
      [created.rows[0]!.create_prompt_version],
    )
    // Derived from the body, never asked for separately, so the flag and the
    // token count cannot disagree.
    expect(saved.rows[0]!.uses_composition).toBe(false)
  })

  it('refuses an image version with a duplicate required token', async () => {
    const current = await currentPrompt('image')
    const invalid = `${current.body}\n{{COMPOSITION_DETAIL}}`

    await expect(
      db.query(
        `select public.create_prompt_version($1, $2, $3, $4, $5)`,
        ['image', 'Invalid fixture', invalid, current.model, 'test:phase5-prompts'],
      ),
    ).rejects.toMatchObject({
      code: '22023',
      // A repeat is its own message: deriving would call this self-staging and
      // tell the operator to remove a token they meant to keep.
      message: expect.stringContaining('repeats'),
    })
  })

  it('refuses a self-staging prompt that still carries the token', async () => {
    const handChain = await db.query<{ id: string; body: string; model: string }>(
      `select id, body, model
         from public.prompts
        where kind = 'image' and preset_slug = 'hand-chain'
        order by created_at
        limit 1`,
    )
    expect(handChain.rowCount).toBe(1)

    // Force the disagreement the derivation normally prevents, then prove
    // promotion still catches it.
    await db.query(
      `update public.prompts set body = body || E'\n{{COMPOSITION_DETAIL}}' where id = $1`,
      [handChain.rows[0]!.id],
    )
    await expect(
      db.query(`select public.promote_prompt_version($1, $2)`, [
        handChain.rows[0]!.id,
        'test:phase5-prompts',
      ]),
    ).rejects.toMatchObject({ code: '22023' })
  })
})

describe('deployed style presets', () => {
  async function liveSlugs() {
    const result = await db.query<{ kind: string; preset_slug: string | null }>(
      `select kind, preset_slug
         from public.prompts
        where is_default and archived_at is null
        order by kind`,
    )
    return Object.fromEntries(result.rows.map((row) => [row.kind, row.preset_slug]))
  }

  it('promotes a self-staging preset that the old validation refused outright', async () => {
    const applied = await db.query<{ kind: string; changed: boolean }>(
      `select * from public.promote_prompt_preset('hand-chain', 'test:presets')`,
    )
    expect(applied.rows.map((row) => row.kind).sort()).toEqual(['describe', 'image'])
    expect(applied.rows.every((row) => row.changed)).toBe(true)

    // Both stages moved, and the promoted copy carried the staging flag with it —
    // a copy left at the default `true` with no token in its body would have made
    // every later enhancement throw.
    expect(await liveSlugs()).toEqual({ describe: 'hand-chain', image: 'hand-chain' })
    const live = await db.query<{ uses_composition: boolean; tokens: number }>(
      `select uses_composition,
              (length(body) - length(replace(body, '{{COMPOSITION_DETAIL}}', '')))
                / length('{{COMPOSITION_DETAIL}}') as tokens
         from public.prompts
        where kind = 'image' and is_default and archived_at is null`,
    )
    expect(live.rows[0]).toEqual({ uses_composition: false, tokens: 0 })
  })

  it('applies both halves of a composed preset', async () => {
    await db.query(`select * from public.promote_prompt_preset('marble', 'test:presets')`)
    expect(await liveSlugs()).toEqual({ describe: 'marble', image: 'marble' })

    const live = await db.query<{ uses_composition: boolean; tokens: number }>(
      `select uses_composition,
              (length(body) - length(replace(body, '{{COMPOSITION_DETAIL}}', '')))
                / length('{{COMPOSITION_DETAIL}}') as tokens
         from public.prompts
        where kind = 'image' and is_default and archived_at is null`,
    )
    expect(live.rows[0]).toEqual({ uses_composition: true, tokens: 1 })
  })

  it('leaves a preset that is already live alone instead of copying it again', async () => {
    await db.query(`select * from public.promote_prompt_preset('bag', 'test:presets')`)
    const before = await db.query<{ count: string }>(
      `select count(*) from public.prompts where preset_slug = 'bag'`,
    )

    const again = await db.query<{ changed: boolean }>(
      `select * from public.promote_prompt_preset('bag', 'test:presets')`,
    )
    expect(again.rows.every((row) => row.changed)).toBe(false)

    const after = await db.query<{ count: string }>(
      `select count(*) from public.prompts where preset_slug = 'bag'`,
    )
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count)
  })

  it('keeps preset identity and self-staging behavior when either model changes', async () => {
    await db.query(`select * from public.promote_prompt_preset('bag', 'test:presets')`)
    await db.query(
      `select public.select_prompt_model('image', 'google/gemini-3.1-flash-image', 'test:presets')`,
    )
    await db.query(
      `select public.select_prompt_model('describe', 'google/gemini-3.1-pro-preview', 'test:presets')`,
    )

    expect(await liveSlugs()).toEqual({ describe: 'bag', image: 'bag' })
    const image = await db.query<{
      uses_composition: boolean
      preset_slug: string
      tokens: number
    }>(
      `select uses_composition,
              preset_slug,
              (length(body) - length(replace(body, '{{COMPOSITION_DETAIL}}', '')))
                / length('{{COMPOSITION_DETAIL}}') as tokens
         from public.prompts
        where kind = 'image' and is_default and archived_at is null`,
    )
    expect(image.rows[0]).toEqual({
      uses_composition: false,
      preset_slug: 'bag',
      tokens: 0,
    })
  })

  it('refuses a preset that has only one half', async () => {
    await db.query(
      `update public.prompts set preset_slug = null
        where kind = 'describe' and preset_slug = 'yellow'`,
    )
    await expect(
      db.query(`select * from public.promote_prompt_preset('yellow', 'test:presets')`),
    ).rejects.toMatchObject({ code: '22023' })
  })

  it('ships every preset with both halves', async () => {
    const halves = await db.query<{ preset_slug: string; kinds: number }>(
      `select preset_slug, count(distinct kind)::int as kinds
         from public.prompts
        where preset_slug is not null
        group by preset_slug
        order by preset_slug`,
    )
    expect(halves.rows.map((row) => row.preset_slug)).toEqual([
      'bag',
      'hand-chain',
      'marble',
      'satin',
      'yellow',
    ])
    expect(halves.rows.every((row) => row.kinds === 2)).toBe(true)
  })

  it('uses the reference-faithful models and newest reviewed contract for every preset', async () => {
    const latest = await db.query<{
      preset_slug: string
      kind: 'describe' | 'image'
      model: string
      body: string
    }>(
      `select distinct on (preset_slug, kind)
              preset_slug, kind, model, body
         from public.prompts
        where preset_slug is not null
        order by preset_slug, kind, created_at desc, id desc`,
    )

    expect(latest.rows).toHaveLength(10)
    for (const row of latest.rows) {
      if (row.kind === 'describe') {
        expect(row.model).toBe('openai/gpt-5.6-sol')
        expect(row.body).toContain('Exact counts are mandatory')
        expect(row.body).not.toContain('Do NOT state exact counts')
        expect(row.body).toContain('80 to 200 words')
      } else {
        expect(row.model).toBe('openai/gpt-image-2')
        expect(row.body).toContain('REFERENCE AUTHORITY')
        expect(row.body).toContain('sole visual authority')
        expect(row.body).not.toContain('warm luxury studio lighting')
      }
    }
  })

  it('makes the live satin pair the highest-reliability model pair', async () => {
    const live = await db.query<{
      kind: 'describe' | 'image'
      model: string
      preset_slug: string
      body: string
    }>(
      `select kind, model, preset_slug, body
         from public.prompts
        where is_default and archived_at is null
        order by kind`,
    )

    expect(live.rows.map(({ kind, model, preset_slug }) => ({ kind, model, preset_slug }))).toEqual([
      { kind: 'describe', model: 'openai/gpt-5.6-sol', preset_slug: 'satin' },
      { kind: 'image', model: 'openai/gpt-image-2', preset_slug: 'satin' },
    ])
    expect(live.rows.find((row) => row.kind === 'describe')!.body).toContain(
      'component ledger',
    )
    expect(live.rows.find((row) => row.kind === 'image')!.body).toContain(
      'jump-ring-mounted charm',
    )
  })

  it('offers the accepted catalogue prompt as a preset, so there is a way back', async () => {
    // The live pair is TAGGED, not copied — a copy would have to be kept
    // byte-identical to the accepted body forever, and would stop being it the
    // first time the two drifted.
    const live = await db.query<{ kind: string; preset_slug: string | null }>(
      `select kind, preset_slug
         from public.prompts
        where is_default and archived_at is null
        order by kind`,
    )
    expect(live.rows).toEqual([
      { kind: 'describe', preset_slug: 'satin' },
      { kind: 'image', preset_slug: 'satin' },
    ])

    // Away and back, and the catalogue prompt is live again.
    await db.query(`select * from public.promote_prompt_preset('marble', 'test:presets')`)
    await db.query(`select * from public.promote_prompt_preset('satin', 'test:presets')`)

    const back = await db.query<{ body: string }>(
      `select body from public.prompts
        where kind = 'image' and is_default and archived_at is null`,
    )
    expect(back.rows[0]!.body).toContain('ivory-champagne satin')
  })
})
