import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  checkPrompt,
  parseCheckCodes,
  parseCheckVerdict,
  retryPromptFor,
  serialiseCheckCodes,
} from '@/lib/enhance/check'
import { EnhancementError } from '@/lib/enhance/errors'
import { defaultSettingFor, pickSetting } from '@/lib/prompts/art-director'

describe('D120 check verdict parsing', () => {
  it('accepts a plain pass verdict', () => {
    expect(parseCheckVerdict('{"verdict":"pass","failures":[]}')).toEqual({
      pass: true,
      failures: [],
    })
  })

  it('accepts a fenced fail verdict and keeps only known codes', () => {
    const verdict = parseCheckVerdict(
      '```json\n{"verdict":"fail","failures":[{"code":"count","detail":"a stone is missing"},{"code":"made-up","detail":"x"}]}\n```',
    )
    expect(verdict.pass).toBe(false)
    expect(verdict.failures).toEqual([{ code: 'count', detail: 'a stone is missing' }])
  })

  it('rejects malformed JSON, unknown verdicts and code-less failures as checker faults', () => {
    expect(() => parseCheckVerdict('not json')).toThrow(EnhancementError)
    expect(() => parseCheckVerdict('{"verdict":"maybe"}')).toThrow(EnhancementError)
    expect(() =>
      parseCheckVerdict('{"verdict":"fail","failures":[{"code":"nonsense","detail":"x"}]}'),
    ).toThrow(EnhancementError)
  })
})

describe('D120 retry prompt determinism', () => {
  it('is a pure function of base prompt and canonically ordered codes', () => {
    const a = retryPromptFor('BASE', ['gauge', 'count'])
    const b = retryPromptFor('BASE', ['count', 'gauge', 'count'])
    expect(a).toBe(b)
    expect(a).toContain('RENDER CORRECTIONS')
    expect(a.indexOf('COUNT —')).toBeLessThan(a.indexOf('CHAIN GAUGE —'))
    expect(retryPromptFor('BASE', [])).toBe('BASE')
  })

  it('round-trips codes through metadata serialisation', () => {
    const codes = ['orientation', 'count'] as const
    expect(parseCheckCodes(serialiseCheckCodes(codes))).toEqual(['count', 'orientation'])
    expect(parseCheckCodes('')).toEqual([])
    expect(parseCheckCodes('bogus,count')).toEqual(['count'])
  })

  it('tells the checker that re-posing and re-staging are correct', () => {
    const prompt = checkPrompt('two drop earrings')
    expect(prompt).toContain('never failures')
    expect(prompt).toContain('two drop earrings')
    expect(checkPrompt(null)).not.toContain('identity record of the product')
  })
})

describe('D120 art director', () => {
  it('falls back to the house ground when the source image is unavailable', () => {
    expect(defaultSettingFor('rings')).toBe('charcoal-plaster')
  })

  it('accepts a valid rubric answer and rejects an unknown slug', async () => {
    const answer = (setting: string) =>
      ({
        ok: true,
        json: async () => ({
          model: 'google/gemini-3.5-flash-lite',
          choices: [
            { message: { content: JSON.stringify({ setting, reason: 'rule 2' }) } },
          ],
          usage: { cost: 0.0006 },
        }),
      }) as Response

    const original = globalThis.fetch
    try {
      globalThis.fetch = vi.fn(async () => answer('black-marble-mirror')) as typeof fetch
      const pick = await pickSetting(Buffer.from('img'), 'image/jpeg', 'rings')
      expect(pick).toMatchObject({
        settingSlug: 'black-marble-mirror',
        fellBack: false,
        reason: 'rule 2',
      })

      globalThis.fetch = vi.fn(async () => answer('no-such-setting')) as typeof fetch
      const fallback = await pickSetting(Buffer.from('img'), 'image/jpeg', 'rings')
      expect(fallback).toMatchObject({ settingSlug: 'charcoal-plaster', fellBack: true })

      globalThis.fetch = vi.fn(async () => {
        throw new Error('offline')
      }) as typeof fetch
      const offline = await pickSetting(Buffer.from('img'), 'image/jpeg', 'rings')
      expect(offline).toMatchObject({ settingSlug: 'charcoal-plaster', fellBack: true })
    } finally {
      globalThis.fetch = original
    }
  })
})
