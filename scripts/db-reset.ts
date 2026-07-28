/**
 * Drops the public schema and reapplies every migration from scratch.
 *
 *   npm run db:reset -- --yes
 *
 * This is how success criterion 2 gets re-proved on demand: migrations must
 * apply cleanly to a COMPLETELY EMPTY database, in order, with no manual steps.
 *
 * DESTRUCTIVE. Requires --yes, and refuses to run when LOUPE_ENV=production.
 */
import { pgClient } from './lib/pg'

async function main(): Promise<void> {
  if (!process.argv.includes('--yes')) {
    console.error(
      'Refusing to run without --yes.\n' +
        'This DROPS the public schema and everything in it.\n\n' +
        '  npm run db:reset -- --yes',
    )
    process.exit(1)
  }
  if (process.env.LOUPE_ENV === 'production') {
    console.error('LOUPE_ENV=production — refusing. Reset a production database by hand or not at all.')
    process.exit(1)
  }

  const client = pgClient()
  await client.connect()
  try {
    console.log('Dropping public schema …')
    await client.query(`
      drop schema if exists public cascade;
      create schema public;
      grant usage on schema public to anon, authenticated, service_role;
      grant all   on schema public to postgres;
      delete from supabase_migrations.schema_migrations;
    `)
    console.log('Public schema is empty. Reapplying migrations …\n')
  } finally {
    await client.end()
  }

  await import('./db-push')
}

main().catch((e: unknown) => {
  console.error(`\ndb:reset failed\n${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
