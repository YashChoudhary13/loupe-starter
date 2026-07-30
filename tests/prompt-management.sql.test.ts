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

  it('refuses an image version with a missing required token', async () => {
    const current = await currentPrompt('image')
    const invalid = current.body.replace('{{COMPOSITION_DETAIL}}', '')

    await expect(
      db.query(
        `select public.create_prompt_version($1, $2, $3, $4, $5)`,
        ['image', 'Invalid fixture', invalid, current.model, 'test:phase5-prompts'],
      ),
    ).rejects.toMatchObject({ code: '22023' })
  })

  it('refuses an image version with a duplicate required token', async () => {
    const current = await currentPrompt('image')
    const invalid = `${current.body}\n{{COMPOSITION_DETAIL}}`

    await expect(
      db.query(
        `select public.create_prompt_version($1, $2, $3, $4, $5)`,
        ['image', 'Invalid fixture', invalid, current.model, 'test:phase5-prompts'],
      ),
    ).rejects.toMatchObject({ code: '22023' })
  })
})
