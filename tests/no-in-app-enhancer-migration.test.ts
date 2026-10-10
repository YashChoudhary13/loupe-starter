import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * D144: nothing may park a photograph in `discovered` waiting for the retired
 * enhancement worker. A static read of the migration text, because the rule
 * is about what the deployed functions SAY, and the live database is not a
 * unit-test dependency.
 */
const SQL = readFileSync(
  resolve(__dirname, '../supabase/migrations/20261010110000_no_in_app_enhancer.sql'),
  'utf8',
)

function body(fn: string): string {
  const start = SQL.indexOf(`create or replace function public.${fn}(`)
  expect(start, `${fn} is redefined by the migration`).toBeGreaterThanOrEqual(0)
  const end = SQL.indexOf('\n$$;', start)
  return SQL.slice(start, end)
}

describe('no in-app enhancer migration', () => {
  it.each(['decide_identification', 'begin_new_sku_from_restock', 'resume_intake_file'])(
    '%s no longer assigns the discovered status and goes through select_original_as_enhanced',
    (fn) => {
      const text = body(fn)
      expect(text).not.toMatch(/status\s*=\s*'discovered'/)
      expect(text).toContain('select_original_as_enhanced(')
    },
  )

  it('defines the shared transition once, with the operator-facing note', () => {
    const text = body('select_original_as_enhanced')
    expect(text).toContain("'Not enhanced: send it through /enhance or upload a finished image.'")
    expect(text).toContain("status             = 'enhanced'")
    expect(text).toContain("'intake.original_selected'")
  })

  it('converts every row still waiting for the worker, and deletes no photograph data', () => {
    expect(SQL).toMatch(/status in \('discovered', 'enhancing'\)/)
    // decide_identification keeps its existing delete of an emptied, never-sent draft;
    // no photograph, version, prompt or redo row goes.
    expect(SQL).not.toMatch(/delete from public\.(intake_files|image_versions|prompts|app_config|image_redo_jobs)\b/i)
    expect(SQL).not.toMatch(/\bdrop (table|type|column)\b/i)
  })
})
