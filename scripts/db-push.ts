/**
 * Applies every migration in supabase/migrations/ that has not been applied yet,
 * in filename order, each inside its own transaction.
 *
 *   npm run db:push
 *
 * Records applied versions in supabase_migrations.schema_migrations — the same
 * table the Supabase CLI uses, so `supabase db push` and this runner agree.
 *
 * This exists because the project has no Supabase CLI or psql on the path and
 * Docker-based local development is more machinery than a schema this size
 * needs. See docs/DECISIONS.md D12.
 */
import { loadMigrations } from './lib/migrations'
import { pgClient } from './lib/pg'

async function main(): Promise<void> {
  const migrations = loadMigrations()
  const client = pgClient()
  await client.connect()

  try {
    await client.query(`
      create schema if not exists supabase_migrations;
      create table if not exists supabase_migrations.schema_migrations (
        version    text primary key,
        statements text[],
        name       text
      );
    `)

    const { rows } = await client.query<{ version: string }>(
      'select version from supabase_migrations.schema_migrations',
    )
    const applied = new Set(rows.map((r) => r.version))

    let ran = 0
    for (const m of migrations) {
      if (applied.has(m.version)) {
        console.log(`  skip   ${m.filename} (already applied)`)
        continue
      }
      process.stdout.write(`  apply  ${m.filename} … `)
      try {
        await client.query('begin')
        await client.query(m.sql)
        await client.query(
          'insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)',
          [m.version, m.name, [m.sql]],
        )
        await client.query('commit')
        ran += 1
        console.log('ok')
      } catch (e) {
        await client.query('rollback').catch(() => {})
        console.log('FAILED')
        throw new Error(
          `${m.filename} failed and was rolled back. Nothing after it was applied.\n\n${
            e instanceof Error ? e.message : String(e)
          }`,
        )
      }
    }

    console.log(
      ran === 0
        ? `\nUp to date — ${migrations.length} migration(s), nothing to apply.`
        : `\nApplied ${ran} of ${migrations.length} migration(s).`,
    )
  } finally {
    await client.end()
  }
}

main().catch((e: unknown) => {
  console.error(`\ndb:push failed\n${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
