import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const MIGRATIONS_DIR = resolve(process.cwd(), 'supabase/migrations')

export interface Migration {
  /** Leading numeric component of the filename — the version the CLI records. */
  readonly version: string
  readonly name: string
  readonly filename: string
  readonly sql: string
}

const FILENAME = /^(\d+)_(.+)\.sql$/

/**
 * Migrations in filename order, which is the order they must be applied in.
 * Same convention the Supabase CLI uses, so `supabase db push` and this runner
 * agree on what has already been applied.
 */
export function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const m = FILENAME.exec(filename)
      if (!m) {
        throw new Error(
          `Migration "${filename}" is not named <version>_<name>.sql — the CLI would ignore it.`,
        )
      }
      return {
        version: m[1],
        name: m[2],
        filename,
        sql: readFileSync(join(MIGRATIONS_DIR, filename), 'utf8'),
      }
    })
}
