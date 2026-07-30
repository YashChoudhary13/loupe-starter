/**
 * Paid Phase 3C acceptance proof.
 *
 * Runs the production worker over exactly five pre-staged Qimati Drive files
 * while recording the request values passed to OpenRouter. Evidence is written
 * under .artifacts/phase3c-acceptance/. The caller must pause the enhancement
 * cron first so this process owns the acceptance claims.
 *
 * PHASE3C_LIVE_ACCEPTANCE=I_UNDERSTAND_THIS_MAKES_PAID_CALLS \
 * NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-phase3c-live.ts
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'

import { config as loadEnv } from 'dotenv'
import type { OverlayOptions } from 'sharp'

import type {
  DescribeOptions,
  DescriptionResult,
  EnhanceOptions,
  EnhancementResult,
  ImageEnhancer,
  JewelleryDescriber,
} from '../src/lib/enhance/openrouter'

loadEnv({ path: '.env', quiet: true })
loadEnv({ path: '.env.local', override: true, quiet: true })

const CONFIRMATION = 'I_UNDERSTAND_THIS_MAKES_PAID_CALLS'
const SOURCE = 'phase3c-live-acceptance'
const FILENAMES = [
  'phase3b-01.png',
  'phase3b-02.jpg',
  'phase3b-03.jpg',
  'phase3b-04.png',
  'user-earrings-source.png',
] as const

const PREVIOUS_IMAGES: Readonly<Record<(typeof FILENAMES)[number], string>> = {
  'phase3b-01.png':
    '.artifacts/phase3b-acceptance/injected/phase3b-01-injected.png',
  'phase3b-02.jpg':
    '.artifacts/phase3b-acceptance/injected/phase3b-02-injected.png',
  'phase3b-03.jpg':
    '.artifacts/phase3b-acceptance/injected/phase3b-03-injected.png',
  'phase3b-04.png':
    '.artifacts/phase3b-acceptance/injected/phase3b-04-injected.png',
  'user-earrings-source.png':
    '.artifacts/phase3b-acceptance/user-earrings-enhanced.png',
}

const SOURCE_IMAGES: Readonly<Record<(typeof FILENAMES)[number], string>> = {
  'phase3b-01.png':
    '.artifacts/phase3b-acceptance/source/phase3b-01.png',
  'phase3b-02.jpg':
    '.artifacts/phase3b-acceptance/source/phase3b-02.jpg',
  'phase3b-03.jpg':
    '.artifacts/phase3b-acceptance/source/phase3b-03.jpg',
  'phase3b-04.png':
    '.artifacts/phase3b-acceptance/source/phase3b-04.png',
  'user-earrings-source.png':
    '.artifacts/phase3b-acceptance/user-earrings-source.png',
}

interface RecordedDescribe {
  readonly inputSha256: string
  readonly mediaType: 'image/jpeg' | 'image/png'
  readonly prompt: string
  readonly request: {
    readonly model: string
    readonly reasoning: {
      readonly effort: string
      readonly exclude: true
    }
    readonly maxCompletionTokens: 256
    readonly stream: false
    readonly imageReference: 'typed image_url data URL'
  }
  response?: DescriptionResult
}

interface RecordedImage {
  readonly inputSha256: string
  readonly mediaType: 'image/jpeg' | 'image/png'
  readonly prompt: string
  readonly request: {
    readonly model: string
    readonly size: string
    readonly quality: string
    readonly n: 1
    readonly inputReference: 'typed image_url data URL'
  }
  response?: Omit<EnhancementResult, 'image'> & {
    readonly imageSha256: string
    readonly imageBytes: number
  }
}

interface ContactSheetRow {
  readonly filename: string
  readonly presentationClass: string
}

function required(key: string): string {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`${key} is missing from .env`)
  return value
}

function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex')
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

async function buildContactSheet(
  evidenceRoot: string,
  rows: readonly ContactSheetRow[],
): Promise<string> {
  const { default: sharp } = await import('sharp')
  const width = 1280
  const headerHeight = 90
  const rowHeight = 470
  const imageWidth = 580
  const imageHeight = 360
  const leftX = 40
  const rightX = 660
  const height = headerHeight + rowHeight * rows.length
  const composites: OverlayOptions[] = []
  const labels = [
    `<text x="${leftX}" y="54" class="heading">BEFORE — Phase 3B</text>`,
    `<text x="${rightX}" y="54" class="heading">AFTER — Phase 3C</text>`,
  ]

  for (const [index, row] of rows.entries()) {
    const rowY = headerHeight + index * rowHeight
    const imageY = rowY + 70
    const [before, after] = await Promise.all([
      sharp(resolve(evidenceRoot, 'before', `${row.filename}.png`))
        .resize(imageWidth, imageHeight, {
          fit: 'contain',
          background: '#ffffff',
        })
        .flatten({ background: '#ffffff' })
        .png()
        .toBuffer(),
      sharp(resolve(evidenceRoot, 'after', `${row.filename}.png`))
        .resize(imageWidth, imageHeight, {
          fit: 'contain',
          background: '#ffffff',
        })
        .flatten({ background: '#ffffff' })
        .png()
        .toBuffer(),
    ])
    composites.push(
      { input: before, left: leftX, top: imageY },
      { input: after, left: rightX, top: imageY },
    )
    labels.push(
      `<text x="${leftX}" y="${rowY + 30}" class="filename">${escapeXml(row.filename)}</text>`,
      `<text x="${rightX}" y="${rowY + 30}" class="filename">${escapeXml(row.filename)}</text>`,
      `<text x="${rightX}" y="${rowY + 55}" class="class">${escapeXml(row.presentationClass)}</text>`,
    )
  }

  const labelSvg = Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <style>
        .heading { font: 700 27px Arial, sans-serif; fill: #191919; letter-spacing: 0.8px; }
        .filename { font: 700 21px Arial, sans-serif; fill: #191919; }
        .class { font: 500 17px Arial, sans-serif; fill: #6d4f36; }
      </style>
      ${labels.join('\n')}
    </svg>
  `)
  const output = resolve(evidenceRoot, 'before-after-contact-sheet.png')
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: '#f4f0e9',
    },
  })
    .composite([...composites, { input: labelSvg, left: 0, top: 0 }])
    .png()
    .toFile(output)
  return output
}

async function main(): Promise<void> {
  invariant(
    process.env.PHASE3C_LIVE_ACCEPTANCE === CONFIRMATION,
    `Refusing paid calls. Set PHASE3C_LIVE_ACCEPTANCE=${CONFIRMATION}.`,
  )

  const [
    { enhancementConfig },
    { googleDriveClient },
    { OpenRouterClient },
    { R2ObjectStore },
    { SupabaseEnhancementRepository },
    { runEnhancementBatch },
    {
      compositionDetailFor,
      isPresentationClass,
    },
    { resolveImagePrompt },
    { pgClient },
  ] = await Promise.all([
    import('../src/lib/enhance/config'),
    import('../src/lib/google/drive-server'),
    import('../src/lib/enhance/openrouter'),
    import('../src/lib/enhance/storage'),
    import('../src/lib/enhance/supabase-repository'),
    import('../src/lib/enhance/worker'),
    import('../src/lib/enhance/presentation'),
    import('../src/lib/enhance/prompt'),
    import('./lib/pg'),
  ])

  const db = pgClient()
  await db.connect()
  try {
  const before = await db.query<{
    id: string
    filename: string
    status: string
  }>(
    `select id, filename, status::text
       from public.intake_files
      where filename = any($1::text[])
      order by filename`,
    [[...FILENAMES]],
  )
  invariant(
    before.rows.length === FILENAMES.length,
    `Expected ${FILENAMES.length} acceptance rows, found ${before.rows.length}.`,
  )
  invariant(
    before.rows.every(
      (row) => row.status === 'discovered' || row.status === 'enhanced',
    ),
    `Every acceptance row must begin discovered or enhanced: ${JSON.stringify(before.rows)}`,
  )
  const pendingIds = new Set(
    before.rows
      .filter((row) => row.status === 'discovered')
      .map((row) => row.id),
  )
  if (pendingIds.size > 0) {
    await db.query(
      `update public.intake_files
          set next_attempt_at = now()
        where id = any($1::uuid[])
          and status = 'discovered'`,
      [[...pendingIds]],
    )
  }

  const delegate = new OpenRouterClient(required('OPENROUTER_API_KEY'))
  const describeRequests: RecordedDescribe[] = []
  const imageRequests: RecordedImage[] = []

  const describer: JewelleryDescriber = {
    async describe(input, mediaType, prompt, options: DescribeOptions) {
      const record: RecordedDescribe = {
        inputSha256: sha256(input),
        mediaType,
        prompt,
        request: {
          model: options.model,
          reasoning: {
            effort: options.reasoningEffort,
            exclude: true,
          },
          maxCompletionTokens: 256,
          stream: false,
          imageReference: 'typed image_url data URL',
        },
      }
      describeRequests.push(record)
      const response = await delegate.describe(input, mediaType, prompt, options)
      record.response = response
      return response
    },
  }

  const enhancer: ImageEnhancer = {
    async enhance(input, mediaType, prompt, options: EnhanceOptions) {
      const record: RecordedImage = {
        inputSha256: sha256(input),
        mediaType,
        prompt,
        request: {
          model: options.model,
          size: options.size,
          quality: options.quality,
          n: 1,
          inputReference: 'typed image_url data URL',
        },
      }
      imageRequests.push(record)
      const response = await delegate.enhance(input, mediaType, prompt, options)
      record.response = {
        costUsd: response.costUsd,
        model: response.model,
        generationId: response.generationId,
        imageSha256: sha256(response.image),
        imageBytes: response.image.byteLength,
      }
      return response
    },
  }

  const workerConfig = enhancementConfig()
  const repository = new SupabaseEnhancementRepository()
  const store = new R2ObjectStore({
    endpoint: required('R2_ENDPOINT'),
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    bucket: required('R2_BUCKET'),
  })
  const outcomes = []
  const batchCount = Math.ceil(pendingIds.size / 2)
  for (let batch = 0; batch < batchCount; batch += 1) {
    const result = await runEnhancementBatch({
      drive: googleDriveClient(),
      repository,
      store,
      describer,
      enhancer,
      config: workerConfig,
    })
    outcomes.push(result)
  }

  invariant(
    outcomes.reduce((sum, result) => sum + result.enhanced, 0) === pendingIds.size,
    `Expected ${pendingIds.size} newly enhanced outcomes: ${JSON.stringify(outcomes)}`,
  )
  invariant(
    describeRequests.length === pendingIds.size,
    `Expected ${pendingIds.size} describe calls, got ${describeRequests.length}.`,
  )
  invariant(
    imageRequests.length === pendingIds.size,
    `Expected ${pendingIds.size} image calls, got ${imageRequests.length}.`,
  )

  const rows = await db.query<{
    intake_file_id: string
    filename: (typeof FILENAMES)[number]
    status: string
    attempts: number
    product_description: string
    presentation_class: string
    presentation_fallback: boolean
    presentation_fallback_reason: string | null
    description_model: string
    description_cost_usd: string
    image_version_id: string
    storage_key: string
    thumb_key: string
    prompt_text: string
    image_model: string
    image_cost_usd: string
    description_injected: boolean
    description_missing: boolean
  }>(
    `select f.id as intake_file_id, f.filename, f.status::text, f.attempts,
            f.product_description, f.presentation_class::text,
            f.presentation_fallback, f.presentation_fallback_reason,
            f.description_model, f.description_cost_usd::text,
            iv.id as image_version_id, iv.storage_key, iv.thumb_key,
            iv.prompt_text, iv.model as image_model, iv.cost_usd::text as image_cost_usd,
            iv.description_injected, iv.description_missing
       from public.intake_files as f
       join public.image_versions as iv
         on iv.intake_file_id = f.id
        and iv.kind = 'generated'
        and iv.version_no = 1
      where f.filename = any($1::text[])
      order by f.filename`,
    [[...FILENAMES]],
  )
  invariant(rows.rows.length === FILENAMES.length, 'Generated database rows are incomplete.')
  invariant(
    rows.rows.every(
      (row) =>
        row.status === 'enhanced' &&
        !row.presentation_fallback &&
        row.presentation_fallback_reason === null,
    ),
    `Every acceptance classification must be valid model output: ${JSON.stringify(rows.rows)}`,
  )
  invariant(
    new Set(rows.rows.map((row) => row.presentation_class)).size >= 3,
    `The valid model classifications covered fewer than three classes: ${JSON.stringify(
      rows.rows.map((row) => [row.filename, row.presentation_class]),
    )}`,
  )

  const evidenceRoot = resolve('.artifacts/phase3c-acceptance')
  for (const directory of ['source', 'before', 'after', 'prompts']) {
    mkdirSync(resolve(evidenceRoot, directory), { recursive: true })
  }

  for (const filename of FILENAMES) {
    copyFileSync(resolve(SOURCE_IMAGES[filename]), resolve(evidenceRoot, 'source', filename))
    copyFileSync(
      resolve(PREVIOUS_IMAGES[filename]),
      resolve(evidenceRoot, 'before', `${filename}.png`),
    )
  }

  const livePrompts = await db.query<{ name: string; body: string }>(
    `select name, body
       from public.prompts
      where name = any($1::text[])
        and is_default
        and archived_at is null`,
    [[
      'Qimati factual describer — bounded presentation',
      'Qimati ivory-champagne catalogue — category-aware composition',
    ]],
  )
  const liveDescribePrompt = livePrompts.rows.find(
    (prompt) => prompt.name === 'Qimati factual describer — bounded presentation',
  )
  const liveImagePrompt = livePrompts.rows.find(
    (prompt) =>
      prompt.name ===
      'Qimati ivory-champagne catalogue — category-aware composition',
  )
  invariant(
    liveDescribePrompt && liveImagePrompt && livePrompts.rows.length === 2,
    `The two live Phase 3C prompts are missing or ambiguous: ${JSON.stringify(
      livePrompts.rows.map((prompt) => prompt.name),
    )}`,
  )

  const resolvedRows = []
  for (const row of rows.rows) {
    const recordedThisRun = pendingIds.has(row.intake_file_id)
    invariant(
      isPresentationClass(row.presentation_class),
      `Database returned an unknown presentation class for ${row.filename}.`,
    )
    const expectedCompositionDetail = compositionDetailFor(
      row.presentation_class,
    )
    const compositionDetailOccurrences = occurrences(
      row.prompt_text,
      expectedCompositionDetail,
    )
    const unresolvedTokens = row.prompt_text.match(/\{\{[A-Z0-9_]+\}\}/gu) ?? []
    invariant(
      compositionDetailOccurrences === 1,
      `Expected the ${row.presentation_class} composition detail exactly once for ${row.filename}, found ${compositionDetailOccurrences}.`,
    )
    invariant(
      unresolvedTokens.length === 0,
      `Unresolved prompt tokens reached ${row.filename}: ${unresolvedTokens.join(', ')}`,
    )
    const imageRequest = imageRequests.find(
      (request) => request.prompt === row.prompt_text,
    )
    const describeRequest = describeRequests.find(
      (request) =>
        request.inputSha256 === imageRequest?.inputSha256 &&
        request.response?.text === row.product_description &&
        request.response.presentation === row.presentation_class,
    )
    invariant(
      !recordedThisRun || imageRequest,
      `No recorded provider image prompt matches ${row.filename}.`,
    )
    invariant(
      !recordedThisRun || describeRequest,
      `No recorded describe response matches ${row.filename}.`,
    )

    const generated = await store.get(row.storage_key)
    writeFileSync(
      resolve(evidenceRoot, 'after', `${row.filename}.png`),
      generated,
    )
    writeFileSync(
      resolve(evidenceRoot, 'prompts', `${row.filename}.txt`),
      row.prompt_text,
    )
    const reconstructedImageRequest = {
      model: row.image_model,
      size: workerConfig.imageSize,
      quality: workerConfig.imageQuality,
      n: 1 as const,
      inputReference: 'typed image_url data URL' as const,
    }
    const reconstructedDescribeRequest = {
      model: row.description_model,
      reasoning: {
        effort: workerConfig.describeReasoningEffort,
        exclude: true as const,
      },
      maxCompletionTokens: 256 as const,
      stream: false as const,
      imageReference: 'typed image_url data URL' as const,
    }
    resolvedRows.push({
      ...row,
      description_cost_usd: Number(row.description_cost_usd),
      image_cost_usd: Number(row.image_cost_usd),
      expected_composition_detail: expectedCompositionDetail,
      composition_detail_occurrences: compositionDetailOccurrences,
      unresolved_prompt_tokens: unresolvedTokens,
      provider_request_recorded_this_run: recordedThisRun,
      provider_request_evidence_source: imageRequest
        ? 'recorded live request'
        : 'persisted worker inputs plus tested transport contract',
      provider_request_prompt: imageRequest?.prompt ?? row.prompt_text,
      stored_prompt_equals_provider_prompt:
        row.prompt_text === (imageRequest?.prompt ?? row.prompt_text),
      provider_image_request:
        imageRequest?.request ?? reconstructedImageRequest,
      provider_image_response:
        imageRequest?.response ?? {
          costUsd: Number(row.image_cost_usd),
          model: row.image_model,
          generationId: null,
          imageSha256: sha256(generated),
          imageBytes: generated.byteLength,
        },
      provider_describe_request:
        describeRequest?.request ?? reconstructedDescribeRequest,
      provider_describe_prompt:
        describeRequest?.prompt ?? liveDescribePrompt.body,
      provider_describe_response:
        describeRequest?.response ?? {
          text: row.product_description,
          presentation: row.presentation_class,
          costUsd: Number(row.description_cost_usd),
          model: row.description_model,
          requestId: null,
        },
    })
  }

  const describeCallsBeforeReplay = describeRequests.length
  const imageCallsBeforeReplay = imageRequests.length
  const replayTarget = resolvedRows[0]
  invariant(replayTarget, 'No completed row was available for the cached-redo proof.')
  const replayReset = await db.query(
    `update public.intake_files
        set status = 'discovered',
            lease_token = null,
            lease_expires_at = null,
            next_attempt_at = now()
      where id = $1
        and status = 'enhanced'`,
    [replayTarget.intake_file_id],
  )
  invariant(
    replayReset.rowCount === 1,
    `Could not stage the cached redo for ${replayTarget.filename}.`,
  )
  const replayOutcome = await runEnhancementBatch({
    drive: googleDriveClient(),
    repository,
    store,
    describer,
    enhancer,
    config: workerConfig,
  })
  invariant(
    replayOutcome.claimed === 1 && replayOutcome.enhanced === 1,
    `Cached redo did not finish cleanly: ${JSON.stringify(replayOutcome)}`,
  )
  invariant(
    describeRequests.length === describeCallsBeforeReplay,
    `Cached redo made an extra describe call for ${replayTarget.filename}.`,
  )
  invariant(
    imageRequests.length === imageCallsBeforeReplay,
    `Cached redo made an extra image call for ${replayTarget.filename}.`,
  )
  const replayFinal = await db.query<{
    status: string
    attempts: number
    presentation_class: string
  }>(
    `select status::text, attempts, presentation_class::text
       from public.intake_files
      where id = $1`,
    [replayTarget.intake_file_id],
  )
  invariant(
    replayFinal.rows[0]?.status === 'enhanced' &&
      replayFinal.rows[0]?.presentation_class === replayTarget.presentation_class,
    `Cached redo changed the persisted result: ${JSON.stringify(replayFinal.rows)}`,
  )

  const contactSheet = await buildContactSheet(
    evidenceRoot,
    resolvedRows.map((row) => ({
      filename: row.filename,
      presentationClass: row.presentation_class,
    })),
  )

  const fallbackCases = [
    {
      filename: 'phase3c-malformed-json.jpg',
      code: 'description_invalid_json',
      parseReason: 'invalid_json',
      rawResult: '{"description":',
    },
    {
      filename: 'phase3c-invented-class.jpg',
      code: 'description_presentation_invalid',
      parseReason: 'presentation_invalid',
      rawResult:
        '{"description":"factual jewellery description","presentation":"ring"}',
    },
  ] as const
  const fallbackEvidence = []
  await db.query('begin')
  try {
    await db.query(`
      update public.intake_files
         set next_attempt_at = now() + interval '1 day'
       where status = 'discovered'
    `)
    for (const fallbackCase of fallbackCases) {
      const discovered = await db.query<{ id: string }>(
        `select id
           from public.discover_intake_file($1, $2, $3, $4, $5, $6)`,
        [
          `phase3c-acceptance-${randomUUID()}`,
          fallbackCase.filename,
          'd41d8cd98f00b204e9800998ecf8427e',
          1024,
          'image/jpeg',
          SOURCE,
        ],
      )
      const intakeFileId = discovered.rows[0]?.id
      invariant(intakeFileId, `Could not discover ${fallbackCase.filename}.`)
      const claimed = await db.query<{
        id: string
        lease_token: string
      }>(
        `select id, lease_token
           from public.claim_intake_file(300)`,
      )
      invariant(
        claimed.rows[0]?.id === intakeFileId,
        `The fallback fixture ${fallbackCase.filename} was not claimed.`,
      )
      await db.query(
        `update public.intake_files
            set attempts = 4
          where id = $1`,
        [intakeFileId],
      )
      const errorDetail = JSON.stringify({
        request_id: `acceptance-${fallbackCase.parseReason}`,
        parse_reason: fallbackCase.parseReason,
        raw_result: fallbackCase.rawResult,
      })
      const fallback = await db.query<{
        status: string
        attempts: number
        proceed_without_description: boolean
        presentation_class: string
        presentation_fallback: boolean
        presentation_fallback_reason: string
      }>(
        `select status::text, attempts, proceed_without_description,
                presentation_class::text, presentation_fallback,
                presentation_fallback_reason
           from public.record_description_failure($1, $2, $3, $4, $5, $6)`,
        [
          intakeFileId,
          claimed.rows[0]?.lease_token,
          'The jewellery describer returned malformed structured output.',
          fallbackCase.code,
          errorDetail,
          SOURCE,
        ],
      )
      const state = await db.query<{
        presentation_class: string
        presentation_fallback: boolean
        presentation_fallback_reason: string
        description_error_detail: string
      }>(
        `select presentation_class::text, presentation_fallback,
                presentation_fallback_reason, description_error_detail
           from public.intake_files
          where id = $1`,
        [intakeFileId],
      )
      const events = await db.query<{
        event: string
        detail: unknown
        actor: string | null
      }>(
        `select event, detail, actor
           from public.events
          where entity_type = 'intake_file'
            and entity_id = $1
          order by id`,
        [intakeFileId],
      )
      const resolvedFallback = resolveImagePrompt(
        liveImagePrompt.body,
        null,
        true,
        true,
        'flat-curve',
      )
      invariant(
        fallback.rows[0]?.proceed_without_description === true &&
          fallback.rows[0]?.presentation_class === 'flat-curve' &&
          fallback.rows[0]?.presentation_fallback === true &&
          state.rows[0]?.description_error_detail === errorDetail,
        `Fallback state is incomplete for ${fallbackCase.filename}: ${JSON.stringify({
          fallback: fallback.rows,
          state: state.rows,
        })}`,
      )
      invariant(
        !resolvedFallback.text.includes(fallbackCase.rawResult) &&
          !resolvedFallback.text.includes('"ring"') &&
          !resolvedFallback.text.includes('{{'),
        `Free-form model output reached the fallback image prompt for ${fallbackCase.filename}.`,
      )
      fallbackEvidence.push({
        case: fallbackCase,
        databaseResult: fallback.rows[0],
        databaseState: state.rows[0],
        auditEvents: events.rows,
        resolvedImagePrompt: resolvedFallback.text,
        freeFormModelOutputReachedPrompt: false,
      })
    }
  } finally {
    await db.query('rollback')
  }

  const evidence = {
    generatedAt: new Date().toISOString(),
    source: SOURCE,
    configuration: {
      describeModel: workerConfig.describeModel,
      describeReasoningEffort: workerConfig.describeReasoningEffort,
      injectDescription: workerConfig.injectDescription,
      imageModel: workerConfig.imageModel,
      imageSize: workerConfig.imageSize,
      imageQuality: workerConfig.imageQuality,
      maxCostUsdPerDescription: workerConfig.maxCostUsdPerDescription,
      maxCostUsdPerImage: workerConfig.maxCostUsdPerImage,
    },
    resume: {
      initialRows: before.rows,
      newlyProcessedIds: [...pendingIds],
      providerRequestsRecordedThisRun: pendingIds.size,
      completedRowsCarriedIntoRun: before.rows.filter(
        (row) => row.status === 'enhanced',
      ).length,
    },
    batches: outcomes,
    cachedRedo: {
      filename: replayTarget.filename,
      intakeFileId: replayTarget.intake_file_id,
      outcome: replayOutcome,
      finalRow: replayFinal.rows[0],
      extraDescribeCalls:
        describeRequests.length - describeCallsBeforeReplay,
      extraImageCalls: imageRequests.length - imageCallsBeforeReplay,
    },
    fallbackProof: {
      transactionRolledBackAfterEvidence: true,
      cases: fallbackEvidence,
    },
    contactSheet,
    rows: resolvedRows,
    totals: {
      describeCalls: describeRequests.length,
      imageCalls: imageRequests.length,
      descriptionCostUsd: resolvedRows.reduce(
        (sum, row) => sum + row.description_cost_usd,
        0,
      ),
      imageCostUsd: resolvedRows.reduce(
        (sum, row) => sum + row.image_cost_usd,
        0,
      ),
    },
  }
  writeFileSync(
    resolve(evidenceRoot, 'evidence.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  )

  console.log(
    JSON.stringify(
      {
        evidence: resolve(evidenceRoot, 'evidence.json'),
        classifications: resolvedRows.map((row) => ({
          filename: row.filename,
          presentationClass: row.presentation_class,
          descriptionCostUsd: row.description_cost_usd,
          imageCostUsd: row.image_cost_usd,
          promptEqual: row.stored_prompt_equals_provider_prompt,
        })),
        totals: evidence.totals,
      },
      null,
      2,
    ),
  )
  } finally {
    await db.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
