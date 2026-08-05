/**
 * Throwaway paid evaluation of image-prompt art direction.
 *
 * Isolates four things production has never separated:
 *   1. Is IMAGE_QUALITY=medium why outputs look soft?        (A vs B)
 *   2. Is the 621-word compliance-style prompt hurting?      (B vs C)
 *   3. Does injecting the describer's paragraph help?        (C vs D)
 *   4. Does 1280 starve the render of pixels?                (C vs E)
 *
 * This is NOT part of the pipeline. It writes nothing to Supabase or R2 and
 * creates no image_versions rows. Evidence lands in .artifacts/art-direction-eval/.
 *
 * Sources: every image in .artifacts/art-direction-eval/raw/ (sorted by name).
 *
 *   # full 5-variant matrix against one source
 *   EVAL_ART_DIRECTION=I_UNDERSTAND_THIS_MAKES_PAID_CALLS \
 *     npx tsx scripts/eval-art-direction.ts matrix --source 1
 *
 *   # one chosen variant against every source
 *   EVAL_ART_DIRECTION=I_UNDERSTAND_THIS_MAKES_PAID_CALLS \
 *     npx tsx scripts/eval-art-direction.ts sweep --variant C
 *
 *   # resolve prompts and print costs without calling anything (free)
 *   npx tsx scripts/eval-art-direction.ts dry
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'

import { config as loadEnv } from 'dotenv'

import { prepareModelInput } from '../src/lib/enhance/image'
import { OpenRouterClient, type EnhanceOptions } from '../src/lib/enhance/openrouter'
import { type PresentationClass } from '../src/lib/enhance/presentation'
import { COMPOSITION_DETAIL_TOKEN, resolveImagePrompt } from '../src/lib/enhance/prompt'

loadEnv({ path: '.env', quiet: true })
loadEnv({ path: '.env.local', override: true, quiet: true })

const CONFIRMATION = 'I_UNDERSTAND_THIS_MAKES_PAID_CALLS'
const OUT_DIR = resolve('.artifacts/art-direction-eval')
const RAW_DIR = resolve(OUT_DIR, 'raw')
const CACHE = resolve(OUT_DIR, 'descriptions.json')
const IMAGE_MODEL = 'openai/gpt-image-2'
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])

/**
 * The proposed replacement: art direction stated positively and led by camera
 * and light rather than by prohibition. Restyling is explicitly granted — the
 * piece may be re-posed freely, which is the whole point of the tool — while
 * construction identity is held by one sentence instead of twenty negations.
 */
const ART_DIRECTION = `A luxury e-commerce hero photograph of this exact piece of jewellery, restyled and shot by a professional product photographer.

PRODUCT
{{PRODUCT_DESCRIPTION}}

CAMERA — 100mm macro on a copy stand, looking down at the piece with a slight 10-degree rake. f/8, focus-stacked so every link and setting is razor sharp. Natural perspective, no wide-angle distortion. Square frame. The piece is arranged in one confident, deliberate composition and fills roughly 85 percent of it, with generous quiet space around it.

LIGHT — a large softbox high and camera-left as the key, a white bounce card camera-right for gentle fill, and a narrow strip light raking along the metal so a bright specular highlight travels the length of the piece. Warm-neutral white balance, rich shadow separation, and one soft believable contact shadow directly beneath it.

SET — pale pearl-ivory silk, smooth and quiet through the centre, with two broad sculpted folds toward the outer edges of the frame. Nothing touches, crosses or overlaps the piece.

STYLING — re-pose and re-drape the piece freely into its most flattering arrangement. It must remain the same physical object: same chain construction and link style, same component count, order, colour, cut and mounting, same clasp, extender and terminal tag, same metal finish. Clean away the display card, packaging, labels, dust and fingerprints.

{{COMPOSITION_DETAIL}}

Photorealistic and opaque, square, sharp to the edges of the piece. No people, hands, mannequins, props, boxes, borders, text or watermarks.`

/**
 * Round two. Two defects the first matrix exposed, fixed at the prompt level so
 * they can be tested at the cheap quality tier:
 *
 *  - "the chain ends in a heart". The source photo is folded in half over a
 *    display card, so the piece's real closure is never visible and its middle
 *    reads as an end. Every composition class then asks for an OPEN curve, which
 *    needs two termini, so the model invents one and fills it with the motif it
 *    has been repeating. Naming the topology as a closed loop removes the free
 *    end entirely, rather than forbidding the symptom.
 *  - chain substitution. Only the identity-lock language held link geometry in
 *    round one, so that clause returns — targeted at the chain alone.
 */
const ART_DIRECTION_V2 = `A luxury e-commerce hero photograph of this exact piece of jewellery, restyled and shot by a professional product photographer.

PRODUCT
{{PRODUCT_DESCRIPTION}}

CAMERA — 100mm macro on a copy stand, looking down at the piece with a slight 10-degree rake. f/8, focus-stacked so every link and setting is razor sharp. Natural perspective, no wide-angle distortion. Square frame. The piece fills roughly 85 percent of it, with generous quiet space around it.

LIGHT — a large softbox high and camera-left as the key, a white bounce card camera-right for gentle fill, and a narrow strip light raking along the metal so a bright specular highlight travels the length of the piece. Warm-neutral white balance, rich shadow separation, and one soft believable contact shadow directly beneath it.

SET — pale pearl-ivory silk, smooth and quiet through the centre, with two broad sculpted folds toward the outer edges of the frame. Nothing touches, crosses or overlaps the piece.

ARRANGEMENT — the reference photograph shows the necklace folded double over a display card, so its two ends overlap near the card and its true closure is hidden. The piece is a closed loop. Fasten the clasp into the extender chain and lay the whole necklace as one continuous closed oval or soft teardrop with no free ends anywhere in the frame. The clasp, extender chain and terminal tag remain visible where the loop closes near the top. Every station sits along the loop. The chain must never terminate in a station, a charm or a bare cut end.

CHAIN — the chain is the product. Reproduce its exact link geometry as photographed: match flat curb, round cable, box, snake, rope, herringbone or figaro construction, the same link gauge, and the same link-size-to-station-size proportion. A generic round cable chain is not an acceptable substitute for a flat woven one.

STYLING — within that closed loop, re-pose and re-drape the piece freely into its most flattering arrangement. Keep the same station count, order, spacing, shape, colour and mounting, the same clasp, extender and terminal tag, and the same metal finish. Clean away the display card, packaging, labels, dust and fingerprints.

Photorealistic and opaque, square, sharp to the edges of the piece. No people, hands, mannequins, props, boxes, borders, text or watermarks.`

/**
 * Round three. Keep the live prompt exactly as it is — its identity-lock
 * language is what held chain geometry in round one — and correct only the
 * arrangement. Every current class paragraph asks for an OPEN shape, which is
 * what forces the model to invent a free chain end and terminate it with the
 * motif it has been repeating. These replacements name the real topology per
 * class: closed for anything with a clasp, deliberately still open for a lariat.
 */
const CLOSED_LOOP_COMPOSITION: Partial<Record<PresentationClass, string>> = {
  'necklace-station': `Fasten the clasp into the extender chain and lay the same station necklace as one
continuous closed oval or soft teardrop with no free ends anywhere in the frame. Keep the clasp, extender
chain and terminal tag visible together where the loop closes near the top. Preserve the exact component
count, order, side placement, orientation, mounting and relative spacing around the loop, letting the
flexible chain drape naturally. The chain must never terminate in a station, a charm or a bare cut end.
Make the decorated run prominent and readable at storefront-thumbnail size.`,
  'necklace-pendant': `Fasten the clasp into the extender chain and lay the same necklace as one continuous
closed oval or teardrop with no free ends, with the exact primary pendant resting face-readable at the
lowest point of the loop and its attachment naturally aligned. Keep the clasp, extender and terminal tag
visible together where the loop closes near the top. The chain must never terminate in the pendant or a
bare cut end. Any zoom applies uniformly to the photographed piece.`,
  'necklace-multistrand': `Fasten the clasp into the extender chain and lay the same multi-strand necklace
as one continuous closed loop with no free ends. Count the parallel strands in the source and reproduce
exactly that many — never fewer — with their real end caps, nesting order and relative lengths. Separate
the strands only enough to read their construction; do not fan, braid, merge, stretch or regularise them,
and do not substitute a plainer chain for a textured rope, wheat or herringbone strand.`,
  'necklace-lariat': `Preserve the exact open lariat or Y topology. This piece does not close: it must not
be rendered as a closed loop or oval necklace. Place its real junction in the visual centre or lower third
and let the exact drop fall in one intentional straight or gently curving direction, ending in its real
terminal component. Do not relocate the junction, shorten the drop or redistribute motifs.`,
  'flat-arc': `Fasten the clasp into the extender chain and lay the same flexible piece as one continuous
closed loop whose two ends meet at the clasp near the top of the frame, with no free-floating cut end.
Preserve its exact strand count, chain topology, component sequence, spacing, clasp count, extender count
and terminal tags; do not add, remove, duplicate or redistribute any component.`,
}

interface Variant {
  readonly id: string
  readonly label: string
  readonly template: 'live' | 'art-direction' | 'art-direction-v2'
  readonly size: `${number}x${number}`
  readonly quality: 'low' | 'medium' | 'high'
  readonly injectDescription: boolean
  /**
   * False for v2, which states the arrangement itself. The class paragraphs all
   * ask for an OPEN shape ("broad relaxed curve or shallow S-shape"), which is
   * precisely the instruction that forces the model to invent a free chain end.
   */
  readonly usesComposition?: boolean
  /** Substitute the corrected per-class arrangement for the built-in one. */
  readonly closedLoopComposition?: boolean
}

const VARIANTS: readonly Variant[] = [
  { id: 'A', label: 'production baseline — live prompt, 1280, medium, +desc', template: 'live', size: '1280x1280', quality: 'medium', injectDescription: true },
  { id: 'B', label: 'live prompt, 1280, HIGH, +desc', template: 'live', size: '1280x1280', quality: 'high', injectDescription: true },
  { id: 'C', label: 'art direction, 1280, HIGH, no desc', template: 'art-direction', size: '1280x1280', quality: 'high', injectDescription: false },
  { id: 'D', label: 'art direction, 1280, HIGH, +desc', template: 'art-direction', size: '1280x1280', quality: 'high', injectDescription: true },
  { id: 'E', label: 'art direction, 2048, HIGH, no desc', template: 'art-direction', size: '2048x2048', quality: 'high', injectDescription: false },
  { id: 'F', label: 'art direction v2 (closed loop + chain lock), 1280, MEDIUM, no desc', template: 'art-direction-v2', size: '1280x1280', quality: 'medium', injectDescription: false, usesComposition: false },
  { id: 'G', label: 'LIVE prompt + corrected shape only, 1280, MEDIUM, +desc', template: 'live', size: '1280x1280', quality: 'medium', injectDescription: true, closedLoopComposition: true },
  { id: 'H', label: 'LIVE prompt + corrected shape, 1280, MEDIUM, no desc', template: 'live', size: '1280x1280', quality: 'medium', injectDescription: false, closedLoopComposition: true },
]

interface CachedDescription {
  readonly text: string
  readonly presentation: PresentationClass
  readonly costUsd: number
  readonly model: string
}

function required(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) throw new Error(`${name} is required.`)
  return v
}

function argOf(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

function negationCount(text: string): number {
  return (text.match(/\b(never|no|not|do not|don't|avoid|forbidden|without)\b/gi) ?? []).length
}

function sources(): string[] {
  if (!existsSync(RAW_DIR)) return []
  return readdirSync(RAW_DIR)
    .filter((f) => IMAGE_EXTENSIONS.has(extname(f).toLowerCase()))
    .sort()
    .map((f) => resolve(RAW_DIR, f))
}

async function fetchLivePrompt(kind: 'image' | 'describe'): Promise<{ name: string; body: string; model: string | null }> {
  const url = new URL('/rest/v1/prompts', required('NEXT_PUBLIC_SUPABASE_URL'))
  url.searchParams.set('kind', `eq.${kind}`)
  url.searchParams.set('is_default', 'is.true')
  url.searchParams.set('archived_at', 'is.null')
  url.searchParams.set('select', 'name,body,model')
  const key = required('SUPABASE_SERVICE_ROLE_KEY')
  const response = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } })
  if (!response.ok) {
    throw new Error(`Could not read the live ${kind} prompt: ${response.status} ${await response.text()}`)
  }
  const rows = (await response.json()) as Array<{ name: string; body: string; model: string | null }>
  if (rows.length !== 1) throw new Error(`Expected exactly one live ${kind} prompt, got ${rows.length}.`)
  return rows[0]
}

function loadCache(): Record<string, CachedDescription> {
  if (!existsSync(CACHE)) return {}
  return JSON.parse(readFileSync(CACHE, 'utf8')) as Record<string, CachedDescription>
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'dry'
  mkdirSync(RAW_DIR, { recursive: true })

  const files = sources()
  if (files.length === 0) {
    throw new Error(`No source images found. Drop the raw photos in ${RAW_DIR} and re-run.`)
  }

  const [liveImage, liveDescribe] = await Promise.all([
    fetchLivePrompt('image'),
    fetchLivePrompt('describe'),
  ])

  console.log(`live image prompt   "${liveImage.name}"`)
  console.log(`  ${liveImage.body.split(/\s+/).length} words · ${negationCount(liveImage.body)} negations`)
  console.log(`art-direction prompt`)
  console.log(`  ${ART_DIRECTION.split(/\s+/).length} words · ${negationCount(ART_DIRECTION)} negations`)
  console.log(`\nsources (${files.length}):`)
  files.forEach((f, i) => console.log(`  ${i + 1}. ${f.split('/').pop()}`))

  if (mode === 'dry') {
    console.log('\ndry run — nothing called, nothing spent.')
    return
  }
  if (process.env.EVAL_ART_DIRECTION !== CONFIRMATION) {
    throw new Error(`Refusing to spend money. Set EVAL_ART_DIRECTION=${CONFIRMATION}.`)
  }

  const client = new OpenRouterClient(required('OPENROUTER_API_KEY'))
  const cache = loadCache()
  let spent = 0

  // Describe every source we will use, exactly as production does, and cache it
  // so re-running the matrix never re-pays for the same paragraph.
  const prepared = new Map<string, Awaited<ReturnType<typeof prepareModelInput>>>()
  for (const file of files) {
    const name = file.split('/').pop() as string
    const input = await prepareModelInput(readFileSync(file))
    prepared.set(file, input)
    console.log(`\n${name}: ${input.originalWidth}x${input.originalHeight} -> ${input.width}x${input.height}`)
    if (cache[name]) {
      console.log(`  description cached (${cache[name].presentation})`)
      continue
    }
    process.stdout.write('  describing ... ')
    const described = await client.describe(input.buffer, input.mediaType, liveDescribe.body, {
      model: liveDescribe.model?.trim() || 'openai/gpt-5.6-sol',
      reasoningEffort: 'minimal',
    })
    spent += described.costUsd
    cache[name] = {
      text: described.text,
      presentation: described.presentation,
      costUsd: described.costUsd,
      model: described.model,
    }
    writeFileSync(CACHE, JSON.stringify(cache, null, 2))
    console.log(`$${described.costUsd.toFixed(6)}  ${described.presentation}`)
  }

  const jobs: Array<{ file: string; variant: Variant }> = []
  if (mode === 'matrix') {
    const index = Number(argOf('--source') ?? '1') - 1
    const file = files[index]
    if (!file) throw new Error(`--source ${index + 1} is out of range (${files.length} sources).`)
    for (const variant of VARIANTS) jobs.push({ file, variant })
  } else if (mode === 'sweep') {
    const id = (argOf('--variant') ?? 'C').toUpperCase()
    const variant = VARIANTS.find((v) => v.id === id)
    if (!variant) throw new Error(`Unknown variant ${id}.`)
    for (const file of files) jobs.push({ file, variant })
  } else {
    throw new Error(`Unknown mode "${mode}". Use dry, matrix or sweep.`)
  }

  const report: unknown[] = []
  console.log(`\nrunning ${jobs.length} image call(s)\n`)

  for (const { file, variant } of jobs) {
    const name = file.split('/').pop() as string
    const stem = name.replace(/\.[^.]+$/, '')
    const cached = cache[name]
    const input = prepared.get(file)
    if (!input) throw new Error(`No prepared input for ${name}.`)

    let template =
      variant.template === 'live'
        ? liveImage.body
        : variant.template === 'art-direction-v2'
          ? ART_DIRECTION_V2
          : ART_DIRECTION
    let usesComposition = variant.usesComposition ?? true

    if (variant.closedLoopComposition) {
      const override = CLOSED_LOOP_COMPOSITION[cached.presentation]
      if (!override) {
        throw new Error(`No corrected arrangement written for class ${cached.presentation}.`)
      }
      // Substitute before resolution, then tell the resolver the token is gone.
      template = template.replace(COMPOSITION_DETAIL_TOKEN, override.replace(/\s*\n\s*/gu, ' ').trim())
      usesComposition = false
    }

    const resolved = resolveImagePrompt(
      template,
      cached.text,
      variant.injectDescription,
      false,
      cached.presentation,
      usesComposition,
    )
    const options: EnhanceOptions = { model: IMAGE_MODEL, size: variant.size, quality: variant.quality }

    process.stdout.write(`${stem}  ${variant.id}  ${variant.label} ... `)
    const startedAt = Date.now()
    try {
      const result = await client.enhance(input.buffer, input.mediaType, resolved.text, options)
      const seconds = (Date.now() - startedAt) / 1000
      spent += result.costUsd
      writeFileSync(resolve(OUT_DIR, `${stem}-${variant.id}.png`), result.image)
      writeFileSync(resolve(OUT_DIR, `${stem}-${variant.id}.prompt.txt`), resolved.text)
      console.log(`$${result.costUsd.toFixed(6)}  ${seconds.toFixed(1)}s`)
      report.push({
        source: name,
        ...variant,
        presentationClass: cached.presentation,
        promptWords: resolved.text.split(/\s+/).length,
        promptNegations: negationCount(resolved.text),
        descriptionInjected: resolved.descriptionInjected,
        costUsd: result.costUsd,
        seconds,
        model: result.model,
        generationId: result.generationId,
      })
    } catch (error) {
      console.log(`FAILED — ${error instanceof Error ? error.message : String(error)}`)
      report.push({ source: name, ...variant, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const reportPath = resolve(OUT_DIR, `report-${mode}.json`)
  writeFileSync(reportPath, JSON.stringify({ mode, totalCostUsd: spent, variants: report }, null, 2))
  console.log(`\ntotal spend this run: $${spent.toFixed(6)}`)
  console.log(`evidence: ${OUT_DIR}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
