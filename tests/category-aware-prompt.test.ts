import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  COMPOSITION_DETAIL_TOKEN,
  PRODUCT_DESCRIPTION_TOKEN,
  resolveImagePrompt,
} from '@/lib/enhance/prompt'
import {
  compositionDetailFor,
  PRESENTATION_CLASSES,
} from '@/lib/enhance/presentation'

import { TEST_DESCRIPTION } from './helpers/enhancement'

function migrationBody(filename: string, delimiter: 'image'): string {
  const sql = readFileSync(
    resolve(process.cwd(), 'supabase', 'migrations', filename),
    'utf8',
  )
  const marker = `$${delimiter}$`
  const start = sql.indexOf(marker)
  const end = sql.indexOf(marker, start + marker.length)
  if (start < 0 || end < 0) {
    throw new Error(`Could not find ${marker} body in ${filename}.`)
  }
  return sql.slice(start + marker.length, end)
}

const PHASE_3B_IMAGE_TEMPLATE = migrationBody(
  '20260729132000_phase_3b_two_call_enhancement.sql',
  'image',
)
const PHASE_3C_IMAGE_TEMPLATE = migrationBody(
  '20260730100000_phase_3c_category_aware_composition.sql',
  'image',
)

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1
}

function fidelityBlock(text: string): string {
  const start = text.indexOf('FIDELITY —')
  const end = text.indexOf('\n\nDO NOT INCLUDE', start)
  if (start < 0 || end < 0) throw new Error('Prompt has no complete FIDELITY block.')
  return text.slice(start, end)
}

describe('Phase 3C production prompt resolution', () => {
  it('preserves the Phase 3B FIDELITY block byte-for-byte', () => {
    expect(fidelityBlock(PHASE_3C_IMAGE_TEMPLATE)).toBe(
      fidelityBlock(PHASE_3B_IMAGE_TEMPLATE),
    )
  })

  it('removes the conflicting orientation instruction', () => {
    expect(PHASE_3C_IMAGE_TEMPLATE).not.toContain(
      'Preserve the angle and orientation of the piece as photographed',
    )
    expect(PHASE_3C_IMAGE_TEMPLATE).not.toContain(
      'do not reposition, rotate or restage it',
    )
  })

  it('contains each recognised token exactly once before resolution', () => {
    expect(occurrences(PHASE_3C_IMAGE_TEMPLATE, PRODUCT_DESCRIPTION_TOKEN)).toBe(1)
    expect(occurrences(PHASE_3C_IMAGE_TEMPLATE, COMPOSITION_DETAIL_TOKEN)).toBe(1)
  })

  it.each(PRESENTATION_CLASSES)(
    'resolves %s exactly once with no template token left',
    (presentationClass) => {
      const resolved = resolveImagePrompt(
        PHASE_3C_IMAGE_TEMPLATE,
        TEST_DESCRIPTION,
        true,
        false,
        presentationClass,
      )
      const detail = compositionDetailFor(presentationClass)

      expect(resolved.compositionDetail).toBe(detail)
      expect(occurrences(resolved.text, detail)).toBe(1)
      expect(resolved.text).toContain(
        `PRODUCT\n${TEST_DESCRIPTION}\n\nSUBJECT`,
      )
      expect(resolved.text).not.toMatch(/\{\{[A-Z][A-Z0-9_]*\}\}/u)
    },
  )

  it('keeps description exclusion behaviour while still resolving composition', () => {
    const resolved = resolveImagePrompt(
      PHASE_3C_IMAGE_TEMPLATE,
      TEST_DESCRIPTION,
      false,
      false,
      'flat-arc',
    )

    expect(resolved.descriptionInjected).toBe(false)
    expect(resolved.descriptionMissing).toBe(false)
    expect(resolved.text).not.toMatch(/^PRODUCT\s*$/mu)
    expect(resolved.text).not.toContain(TEST_DESCRIPTION)
    expect(resolved.text).toContain(compositionDetailFor('flat-arc'))
  })

  it('fails safely when the composition token is missing or repeated', () => {
    expect(() =>
      resolveImagePrompt(
        PHASE_3C_IMAGE_TEMPLATE.replace(COMPOSITION_DETAIL_TOKEN, ''),
        TEST_DESCRIPTION,
        true,
        false,
        'flat-curve',
      ),
    ).toThrow(/exactly one/)

    expect(() =>
      resolveImagePrompt(
        `${PHASE_3C_IMAGE_TEMPLATE}\n${COMPOSITION_DETAIL_TOKEN}`,
        TEST_DESCRIPTION,
        true,
        false,
        'flat-curve',
      ),
    ).toThrow(/exactly one/)
  })

  it('rejects any other recognised-looking token left by a future template edit', () => {
    expect(() =>
      resolveImagePrompt(
        `${PHASE_3C_IMAGE_TEMPLATE}\n{{FUTURE_TOKEN}}`,
        TEST_DESCRIPTION,
        true,
        false,
        'flat-curve',
      ),
    ).toThrow(/unresolved template tokens.*FUTURE_TOKEN/)
  })
})

/**
 * Self-staging presets (hand chain worn on a hand, bag standing upright) fix the
 * staging themselves. The describer's composition classes all describe a piece
 * lying on a surface, so injecting one would send the image model two
 * contradictory instructions — and it would resolve that differently every time.
 */
describe('presets that stage the product themselves', () => {
  const selfStaging = PHASE_3C_IMAGE_TEMPLATE.replace(
    '{{COMPOSITION_DETAIL}}',
    'Worn on a relaxed hand.',
  )

  it('resolves without injecting any composition class', () => {
    const resolved = resolveImagePrompt(
      selfStaging,
      TEST_DESCRIPTION,
      true,
      false,
      'flat-arc',
      false,
    )
    expect(resolved.compositionDetail).toBeNull()
    expect(resolved.text).toContain('Worn on a relaxed hand.')
    // The flat-arc paragraph must be nowhere near it.
    expect(resolved.text).not.toContain('lay the piece flat')
    expect(resolved.text).not.toContain('{{')
  })

  it('refuses a self-staging prompt that still carries the token', () => {
    expect(() =>
      resolveImagePrompt(PHASE_3C_IMAGE_TEMPLATE, TEST_DESCRIPTION, true, false, 'flat-arc', false),
    ).toThrow(/must NOT contain/i)
  })

  it('still refuses a composition-using prompt that is missing the token', () => {
    expect(() =>
      resolveImagePrompt(selfStaging, TEST_DESCRIPTION, true, false, 'flat-arc', true),
    ).toThrow(/exactly one/i)
  })
})
