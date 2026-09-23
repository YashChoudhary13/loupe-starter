import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** A fake ~/loupe: three releases deploy.sh marked complete, one whose build died after next wrote BUILD_ID, one with nothing (an early failure), `current` on the newest. */
function server(): string {
  const root = mkdtempSync(join(tmpdir(), 'loupe-rollback-'))
  const release = (name: string, files: string[]) => { mkdirSync(join(root, 'releases', name, '.next'), { recursive: true }); for (const file of files) writeFileSync(join(root, 'releases', name, file), 'x') }
  for (const name of ['20260921-084302-98db017', '20260921-120000-b7f5220', '20260923-100000-888e2bd']) release(name, ['.next/BUILD_ID', '.deploy-complete'])
  release('20260923-090000-deadbee', [])
  release('20260923-093000-c0ffee1', ['.next/BUILD_ID'])
  symlinkSync(join(root, 'releases', '20260923-100000-888e2bd'), join(root, 'current'))
  return root
}
/** Stand-ins for the server-only commands, first on PATH: `flock` runs `whileWaiting` (what a deploy holding the lock does), `sudo` only records, `mv -T` is one atomic rename (macOS's mv has no -T). */
function fakeBin(root: string, whileWaiting = ''): string {
  const bin = join(root, 'bin'); mkdirSync(bin)
  const script = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  script('flock', whileWaiting)
  script('sudo', `echo "$*" >> "${join(root, 'sudo.log')}"`)
  script('mv', `[ "$1" = -T ] && shift\nexec "${process.execPath}" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$1" "$2"`)
  return bin
}
function run(root: string, args: string[], bin?: string): { ok: boolean; out: string } {
  const env = { ...process.env, LOUPE_ROOT: root, ...(bin ? { PATH: `${bin}:${process.env.PATH}` } : {}) }
  try { return { ok: true, out: execFileSync('bash', ['scripts/rollback.sh', ...args], { env, encoding: 'utf8', stdio: 'pipe' }) } }
  catch (error) { return { ok: false, out: String((error as { stderr?: string }).stderr ?? '') } }
}
const listed = (out: string) => out.trim().split('\n').slice(1)
const COMPLETE = ['20260921-084302-98db017', '20260921-120000-b7f5220', '20260923-100000-888e2bd']

describe('rollback script', () => {
  it('finds a kept, complete release by its short sha', () => {
    expect(run(server(), ['b7f5220', '--dry-run'])).toEqual({ ok: true, out: 'would serve 20260921-120000-b7f5220\n' })
  })
  it('refuses an unknown sha, an unbuilt release, or one with BUILD_ID but no completion mark, and lists only complete releases', () => {
    const root = server()
    for (const sha of ['abc1234', 'deadbee', 'c0ffee1']) {
      const result = run(root, [sha, '--dry-run'])
      expect(result.ok).toBe(false)
      expect(listed(result.out)).toEqual(COMPLETE)
    }
  })
  it('does nothing when that release is already live', () => {
    expect(run(server(), ['888e2bd'])).toEqual({ ok: true, out: '==> 20260923-100000-888e2bd is already live\n' })
  })
  it('switches after re-checking the target under the deploy lock', () => {
    const root = server()
    expect(run(root, ['b7f5220'], fakeBin(root)).ok).toBe(true)
    expect(readlinkSync(join(root, 'current'))).toBe(join(root, 'releases', '20260921-120000-b7f5220'))
    expect(readFileSync(join(root, 'sudo.log'), 'utf8')).toBe('systemctl restart loupe\n')
  })
  it('refuses, and leaves current alone, when a deploy holding the lock pruned the target meanwhile', () => {
    const root = server()
    const result = run(root, ['b7f5220'], fakeBin(root, `rm -rf "${join(root, 'releases', '20260921-120000-b7f5220')}"`))
    expect(result.ok).toBe(false)
    expect(listed(result.out)).toEqual(['20260921-084302-98db017', '20260923-100000-888e2bd'])
    expect(readlinkSync(join(root, 'current'))).toBe(join(root, 'releases', '20260923-100000-888e2bd'))
    expect(existsSync(join(root, 'sudo.log'))).toBe(false)
  })
})
