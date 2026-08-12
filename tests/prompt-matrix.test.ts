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
