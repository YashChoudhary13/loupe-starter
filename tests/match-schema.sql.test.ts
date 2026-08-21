import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { pgClient } from '../scripts/lib/pg'

const MATCH_TABLES = [
  'match_events',
  'match_references',
  'match_embeddings',
  'match_jobs',
  'match_workers',
  'restock_decisions',
]

describe('matcher schema (D110/D111)', () => {
  let db: Client

  beforeAll(async () => {
    db = pgClient()
    await db.connect()
  })

  afterAll(async () => {
    await db?.end()
  })

  it('has every matcher table with RLS enabled and no policies', async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean; policies: number }>(
      `select c.relname, c.relrowsecurity,
              (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname = any($1::text[])
        order by c.relname`,
      [MATCH_TABLES],
    )
    expect(rows.map((r) => r.relname)).toEqual([...MATCH_TABLES].sort())
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} RLS`).toBe(true)
      expect(row.policies, `${row.relname} policies`).toBe(0)
    }
  })

  it('stores 1152-dimensional pgvector embeddings', async () => {
    const ext = await db.query(`select extname from pg_extension where extname = 'vector'`)
    expect(ext.rowCount).toBe(1)
    const col = await db.query<{ format_type: string }>(
      `select format_type(a.atttypid, a.atttypmod)
         from pg_attribute a join pg_class c on c.oid = a.attrelid
        where c.relname = 'match_embeddings' and a.attname = 'embedding'`,
    )
    expect(col.rows[0]?.format_type).toBe('extensions.vector(1152)')
  })
})
