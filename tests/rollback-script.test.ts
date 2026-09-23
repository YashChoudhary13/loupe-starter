import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** A fake ~/loupe: three built releases, one unbuilt (a failed build), `current` on the newest. */
function server(): string {
  const root = mkdtempSync(join(tmpdir(), 'loupe-rollback-'))
  for (const name of ['20260921-084302-98db017', '20260921-120000-b7f5220', '20260923-100000-888e2bd']) {
    mkdirSync(join(root, 'releases', name, '.next'), { recursive: true })
    writeFileSync(join(root, 'releases', name, '.next', 'BUILD_ID'), 'x')
  }
  mkdirSync(join(root, 'releases', '20260923-090000-deadbee'), { recursive: true })
  symlinkSync(join(root, 'releases', '20260923-100000-888e2bd'), join(root, 'current'))
  return root
}
function run(root: string, ...args: string[]): { ok: boolean; out: string } {
  try { return { ok: true, out: execFileSync('bash', ['scripts/rollback.sh', ...args], { env: { ...process.env, LOUPE_ROOT: root }, encoding: 'utf8', stdio: 'pipe' }) } }
  catch (error) { return { ok: false, out: String((error as { stderr?: string }).stderr ?? '') } }
}

describe('rollback script', () => {
  it('finds a kept, built release by its short sha', () => {
    expect(run(server(), 'b7f5220', '--dry-run')).toEqual({ ok: true, out: 'would serve 20260921-120000-b7f5220\n' })
  })
  it('refuses an unknown sha or an unbuilt release, and lists what is kept', () => {
    const root = server()
    expect(run(root, 'abc1234', '--dry-run')).toMatchObject({ ok: false, out: expect.stringContaining('20260921-120000-b7f5220') })
    expect(run(root, 'deadbee', '--dry-run').ok).toBe(false)
  })
  it('does nothing when that release is already live', () => {
    expect(run(server(), '888e2bd')).toEqual({ ok: true, out: '==> 20260923-100000-888e2bd is already live\n' })
  })
})
