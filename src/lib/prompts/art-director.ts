import 'server-only'

import { configuredModel } from '@/lib/config/models'
import { serverEnv } from '@/lib/env'

import { promptSetting, settingsForCategory, type PromptSetting } from './matrix'

/**
 * D120 — the art director.
 *
 * The operator picks the category (D1 — nothing guesses that); the setting can
 * be delegated. "Auto" sends the photograph to a small vision model that
 * applies an explicit written rubric — the same rules the manual prompt
 * sessions settled on — and returns one setting slug from the category's own
 * list. The model advises, this module decides: an invalid or unparseable
 * answer falls back to the house charcoal ground, and any failure at all still
 * yields a usable setting, never a blocked upload.
 */

/** The UI sentinel: "let the art director pick". Never a real setting slug. */
export const AUTO_SETTING = 'auto'

/** The house catalogue ground, and the fallback when the model misbehaves. */
export const DEFAULT_SETTING = 'charcoal-plaster'

const ENV_MODEL = process.env.ART_DIRECTOR_MODEL?.trim() || 'google/gemini-3.5-flash-lite'

export interface ArtDirectorPick {
  readonly settingSlug: string
  readonly reason: string
  readonly model: string
  readonly costUsd: number
  /** True when the model's answer was discarded and the default used instead. */
  readonly fellBack: boolean
}

/**
 * The rubric, distilled from the manual prompt-engineering sessions
 * (loupe-starter/docs/PROMPT-DIRECTIONS.md §3). Deterministic rules, priority
 * ordered; taste was encoded once so the choice is consistent across a batch.
 */
function rubricPrompt(categorySlug: string, settings: readonly PromptSetting[]): string {
  const catalogue = settings
    .map((setting) => `- "${setting.slug}": ${setting.label}. ${setting.note}`)
    .join('\n')
  return `You choose the background scene for one jewellery product photograph. The attached photo shows the product; ignore its current background, packaging, hands and lighting. The product's category is "${categorySlug}".

Choose exactly ONE setting slug from this catalogue:
${catalogue}

Apply these rules in priority order — the FIRST rule that matches decides:
1. Mostly black or very dark stones/components: choose a pale setting ("white-plinth" or "ivory-seamless") so the piece separates from the ground.
2. Predominantly clear/colourless stones on a ring, bracelet or tennis-style piece: choose "black-marble-mirror" for maximum sparkle.
3. White metal (silver-coloured) with no dominant stones: choose "warm-greige" if available for this category.
4. Kundan, polki or festive Indian bridal work: choose "emerald-velvet" or "bridal-blossom".
5. Otherwise — and this covers most gold pieces, coloured stones and fine chains — choose "${DEFAULT_SETTING}", the house catalogue ground; the catalogue grid should read as one shoot.
Never choose a green setting for a piece with green stones.

Return ONLY raw JSON, no markdown, exactly: {"setting":"<slug>","reason":"<one short sentence naming the rule applied>"}`
}

interface ChatResponse {
  model?: string
  choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>
  usage?: { cost?: number | string }
}

function responseText(response: ChatResponse): string | null {
  const content = response.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim() ? content : null
  if (!Array.isArray(content)) return null
  const text = content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
  return text.trim() ? text : null
}

function fallback(categorySlug: string, reason: string, costUsd = 0): ArtDirectorPick {
  const settings = settingsForCategory(categorySlug)
  const slug =
    settings.find((setting) => setting.slug === DEFAULT_SETTING)?.slug ??
    settings[0]?.slug ??
    DEFAULT_SETTING
  return { settingSlug: slug, reason, model: ENV_MODEL, costUsd, fellBack: true }
}

/** The house ground when the photograph itself is unavailable to judge. */
export function defaultSettingFor(categorySlug: string): string {
  return fallback(categorySlug, 'Source image unavailable; used the house ground.').settingSlug
}

/**
 * Never throws: an art-director outage costs one default choice, not an upload.
 */
export async function pickSetting(
  image: Buffer,
  mediaType: string,
  categorySlug: string,
): Promise<ArtDirectorPick> {
  const settings = settingsForCategory(categorySlug)
  if (settings.length === 0) return fallback(categorySlug, 'No settings exist for this category.')

  // D121: the /models section can retarget the art director; env, then the
  // code default, remain the fallbacks.
  const model = await configuredModel('art_director_model', ENV_MODEL)
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serverEnv.openRouterApiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Qimati Loupe',
      },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: rubricPrompt(categorySlug, settings) },
              {
                type: 'image_url',
                image_url: { url: `data:${mediaType};base64,${image.toString('base64')}` },
              },
            ],
          },
        ],
        reasoning: { effort: 'minimal', exclude: true },
        max_completion_tokens: 500,
        stream: false,
      }),
    })
    if (!response.ok) {
      return fallback(categorySlug, `Art director call failed (${response.status}); used the house ground.`)
    }

    const parsed = (await response.json()) as ChatResponse
    const raw = responseText(parsed)
    const cost = typeof parsed.usage?.cost === 'string' ? Number(parsed.usage.cost) : parsed.usage?.cost ?? 0
    if (!raw) return fallback(categorySlug, 'Art director returned nothing; used the house ground.', cost)

    const cleaned = raw.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')
    let answer: { setting?: unknown; reason?: unknown }
    try {
      answer = JSON.parse(cleaned) as { setting?: unknown; reason?: unknown }
    } catch {
      return fallback(categorySlug, 'Art director returned malformed JSON; used the house ground.', cost)
    }

    const chosen =
      typeof answer.setting === 'string' &&
      settings.some((setting) => setting.slug === answer.setting) &&
      promptSetting(answer.setting)
        ? answer.setting
        : null
    if (!chosen) {
      return fallback(categorySlug, 'Art director chose an unknown setting; used the house ground.', cost)
    }

    return {
      settingSlug: chosen,
      reason: typeof answer.reason === 'string' ? answer.reason : '',
      model: parsed.model?.trim() || model,
      costUsd: Number.isFinite(cost) && (cost as number) >= 0 ? (cost as number) : 0,
      fellBack: false,
    }
  } catch (error) {
    return fallback(
      categorySlug,
      `Art director unreachable (${error instanceof Error ? error.message : String(error)}); used the house ground.`,
    )
  }
}
