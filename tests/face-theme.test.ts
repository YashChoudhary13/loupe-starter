// tests/face-theme.test.ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/app/globals.css', 'utf8')
const nginx = readFileSync('deploy/loupe.nginx.conf', 'utf8')

describe('per-face look and hosts', () => {
  it.each(['home', 'qc', 'ship'])('%s re-tints the shared tokens', (face) => {
    const block = css.match(new RegExp(`:root\\[data-face="${face}"\\]\\s*{([^}]*)}`))?.[1] ?? ''
    for (const token of ['--bg', '--surface', '--ink', '--ink-soft', '--chip', '--line', '--face-accent', '--face-accent-2']) expect(block).toContain(`${token}:`)
  })
  it('Loupe keeps its palette and the accent tokens have Loupe defaults', () => {
    expect(css).not.toContain('[data-face="loupe"]')
    expect(css).toContain('--face-accent: var(--ink)'); expect(css).toContain('--color-face-accent: var(--face-accent)')
  })
  it('nginx serves all four hosts on 443 and on 80', () => {
    const names = [...nginx.matchAll(/server_name ([^;]+);/g)].map((m) => m[1].trim().split(/\s+/).sort())
    expect(names).toHaveLength(2)
    for (const list of names) expect(list).toEqual(['loupe.qimati-eng.site', 'qc.qimati-eng.site', 'qimati-eng.site', 'ship.qimati-eng.site'])
    expect(nginx).toContain('/etc/letsencrypt/live/loupe.qimati-eng.site/fullchain.pem')
  })
})
