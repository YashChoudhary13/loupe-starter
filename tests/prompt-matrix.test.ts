/**
 * D104 — every category × setting combination must produce prompt bodies the
 * ACTUAL pipeline accepts. resolveImagePrompt() is the worker's own gate
 * (exact PRODUCT block, no composition token on a self-staging prompt, no
 * unresolved {{TOKENS}}), so running all 130 combinations through it — with
 * and without an injected description — is the guarantee that no combination
 * can be selected in the UI and then die at claim time.
 */
import { describe, expect, it } from 'vitest'

import { resolveImagePrompt } from '@/lib/enhance/prompt'
import {
  composeClientPair,
  PROMPT_CATEGORY_CORES,
  PROMPT_MEASUREMENTS,
  PROMPT_SETTINGS,
} from '@/lib/prompts/matrix'

import { TEST_DESCRIPTION } from './helpers/enhancement'

describe('the prompt matrix (13 cores × 10 settings)', () => {
  it('every combination resolves through the worker contract, injected and description-less', () => {
    let combinations = 0
    for (const core of PROMPT_CATEGORY_CORES) {
      for (const setting of PROMPT_SETTINGS) {
        const pair = composeClientPair(core.slug, setting.slug)
        expect(pair, `${core.slug} × ${setting.slug}`).not.toBeNull()

        // Self-staging (usesComposition=false), description injected.
        const injected = resolveImagePrompt(
          pair!.imageBody,
          TEST_DESCRIPTION,
          true,
          false,
          'flat-curve',
          false,
        )
        expect(injected.text).toContain(setting.scene)
        expect(injected.text).not.toContain('{{')
        expect(injected.descriptionInjected).toBe(true)

        // Describer exhausted — the PRODUCT block is removed as one unit.
        const missing = resolveImagePrompt(
          pair!.imageBody,
          null,
          true,
          true,
          'flat-curve',
          false,
        )
        expect(missing.text).not.toContain('PRODUCT\n')
        expect(missing.descriptionMissing).toBe(true)
        combinations += 1
      }
    }
    expect(combinations).toBe(PROMPT_CATEGORY_CORES.length * PROMPT_SETTINGS.length)
  })

  it('describe bodies are token-free and demand the strict two-field JSON contract', () => {
    for (const core of PROMPT_CATEGORY_CORES) {
      expect(core.describeBody, core.slug).not.toMatch(/\{\{[A-Z_]+\}\}/u)
      expect(core.describeBody, core.slug).toContain('presentation')
      expect(core.describeBody, core.slug).toContain('description')
    }
  })

  it('every setting scene is pure environment — no pose or product claims sneak in', () => {
    for (const setting of PROMPT_SETTINGS) {
      expect(setting.scene, setting.slug).not.toMatch(/\{\{/u)
      // A scene must never re-pose the product; 'worn on' / 'model' language
      // would contradict a core's staging.
      expect(setting.scene.toLowerCase(), setting.slug).not.toContain('worn on')
      expect(setting.scene.toLowerCase(), setting.slug).not.toMatch(/\bmannequin\b/u)
    }
  })
})

/**
 * The third axis. A measured pair adds a scale-reading rule to the describer and
 * a callout rule to the image prompt; both must survive the same gates, the DB's
 * 20,000-character body limit and the preset_slug pattern. 'plain' must keep the
 * two-part slug every stored pair already has, or every existing pair would be
 * re-materialised as a new row on first use.
 */
describe('the measurement axis', () => {
  const measured = PROMPT_MEASUREMENTS.find((m) => m.slug === 'measured')!

  it('leaves an unmeasured pair byte-identical to the two-axis pair it has always been', () => {
    for (const core of PROMPT_CATEGORY_CORES) {
      const implicit = composeClientPair(core.slug, 'ivory-seamless')!
      const explicit = composeClientPair(core.slug, 'ivory-seamless', 'plain')!
      expect(explicit).toEqual(implicit)
      expect(implicit.slug).toBe(`${core.slug}--ivory-seamless`)
      expect(implicit.imageBody).not.toContain('MEASUREMENT CALLOUTS')
    }
  })

  it('rejects a measurement that does not exist rather than quietly dropping it', () => {
    expect(composeClientPair('necklace', 'ivory-seamless', 'roughly')).toBeNull()
  })

  it('every measured combination carries both rules and still resolves for the worker', () => {
    for (const core of PROMPT_CATEGORY_CORES) {
      for (const setting of PROMPT_SETTINGS) {
        const pair = composeClientPair(core.slug, setting.slug, 'measured')
        expect(pair, `${core.slug} × ${setting.slug}`).not.toBeNull()
        expect(pair!.slug).toBe(`${core.slug}--${setting.slug}--measured`)
        // The DB's own preset_slug check constraint.
        expect(pair!.slug).toMatch(/^[a-z0-9-]{1,64}(--[a-z0-9-]{1,64})?$/u)

        expect(pair!.describeBody).toContain(measured.describeRule)
        expect(pair!.imageBody).toContain(measured.imageRule)
        expect(pair!.describeBody).not.toMatch(/\{\{[A-Z_]+\}\}/u)
        expect(pair!.describeBody.length).toBeLessThanOrEqual(20_000)
        expect(pair!.imageBody.length).toBeLessThanOrEqual(20_000)

        // The JSON contract stays the describer's last instruction.
        expect(pair!.describeBody.indexOf('MEASUREMENT —')).toBeLessThan(
          pair!.describeBody.indexOf('Return ONLY raw JSON'),
        )

        const resolved = resolveImagePrompt(
          pair!.imageBody,
          TEST_DESCRIPTION,
          true,
          false,
          'flat-curve',
          false,
        )
        expect(resolved.text).toContain(setting.scene)
        expect(resolved.text).not.toContain('{{')
        expect(resolved.descriptionInjected).toBe(true)
      }
    }
  })

  it('will not draw a figure the describer did not supply', () => {
    // Without a PRODUCT block there is nothing to print, so the callout rule must
    // carry its own stand-down instruction rather than leaving the model to guess.
    expect(measured.imageRule).toContain('not legible')
    expect(measured.imageRule).toContain('never round, convert, recompute or invent one')
    // And the ruler itself must never survive into the output.
    expect(measured.imageRule).toContain('never appears in the output')
  })
})
