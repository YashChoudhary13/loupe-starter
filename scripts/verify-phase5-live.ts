import 'dotenv/config'

import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import { serverEnv } from '@/lib/env'
import {
  makeThumbnail,
  readImageDimensions,
} from '@/lib/enhance/image'
import {
  queueImageRedo,
  runProductionRedoBatch,
} from '@/lib/enhance/redo-server'
import { R2ObjectStore } from '@/lib/enhance/storage'
import { supabaseServer } from '@/lib/supabase/server'

const ACTOR = 'acceptance:phase5'
const ROOT = path.resolve('.artifacts/phase5-acceptance')
const FIXTURES = path.join(ROOT, 'fixtures.json')
const EVIDENCE = path.join(ROOT, 'evidence.json')
const SOURCE_PATH = path.resolve(
  '.artifacts/phase3c-acceptance/source/phase3b-01.png',
)
const V1_PATH = path.resolve(
  '.artifacts/phase3c-acceptance/after/phase3b-01.png.png',
)
const PHASE3C_EVIDENCE = path.resolve(
  '.artifacts/phase3c-acceptance/evidence.json',
)

interface PromptRow {
  id: string
  name: string
  body: string
  model: string
  archived_at: string | null
}

interface FixtureState {
  intakeFileId: string
  originalPrompt: PromptRow
  acceptancePromptId: string
  restoredPromptId: string
  redoJobId: string
  objectKeys: string[]
}

interface Phase3cRow {
  product_description: string
  presentation_class: string
  description_model: string
  description_cost_usd: number
  prompt_text: string
  image_model: string
  image_cost_usd: number
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function objectStore() {
  return new R2ObjectStore({
    endpoint: serverEnv.r2Endpoint,
    accessKeyId: serverEnv.r2AccessKeyId,
    secretAccessKey: serverEnv.r2SecretAccessKey,
    bucket: serverEnv.r2Bucket,
  })
}

async function readFixtureState(): Promise<FixtureState> {
  return JSON.parse(await readFile(FIXTURES, 'utf8')) as FixtureState
}

async function currentImagePrompt(): Promise<PromptRow> {
  const { data, error } = await supabaseServer()
    .from('prompts')
    .select('id, name, body, model, archived_at')
    .eq('kind', 'image')
    .eq('is_default', true)
    .is('archived_at', null)
    .single<PromptRow>()
  if (error || !data) throw new Error(error?.message || 'No current image prompt.')
  return data
}

async function accept(): Promise<void> {
  await mkdir(ROOT, { recursive: true })
  try {
    await readFile(FIXTURES)
    throw new Error('Phase 5 fixtures already exist. Run cleanup before another acceptance.')
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error
  }

  const db = supabaseServer()
  const store = objectStore()
  const run = randomUUID()
  const source = await readFile(SOURCE_PATH)
  const v1 = await readFile(V1_PATH)
  const phase3c = JSON.parse(await readFile(PHASE3C_EVIDENCE, 'utf8')) as {
    rows: Phase3cRow[]
  }
  const sourceEvidence = phase3c.rows[0]
  assert(sourceEvidence, 'The preserved Phase 3C evidence has no first row.')

  const originalPrompt = await currentImagePrompt()
  const acceptanceBody = `${originalPrompt.body}\n`
  const { data: acceptancePromptId, error: createError } = await db.rpc(
    'create_prompt_version',
    {
      p_kind: 'image',
      p_name: 'Phase 5 acceptance — same instructions',
      p_body: acceptanceBody,
      p_model: originalPrompt.model,
      p_actor: ACTOR,
    },
  )
  if (createError || typeof acceptancePromptId !== 'string') {
    throw new Error(createError?.message || 'Could not create acceptance prompt.')
  }
  assert((await currentImagePrompt()).id === originalPrompt.id, 'Creating changed the default.')

  const { data: promotedId, error: promoteError } = await db.rpc(
    'promote_prompt_version',
    { p_prompt_id: acceptancePromptId, p_actor: ACTOR },
  )
  if (promoteError || promotedId !== acceptancePromptId) {
    throw new Error(promoteError?.message || 'Could not promote acceptance prompt.')
  }
  assert((await currentImagePrompt()).id === acceptancePromptId, 'Promotion did not become current.')

  const { data: intake, error: intakeError } = await db
    .from('intake_files')
    .insert({
      drive_file_id: `phase5-acceptance-${run}`,
      filename: 'phase5-redo-necklace.png',
      bytes: source.byteLength,
      mime_type: 'image/png',
      status: 'enhanced',
      enhanced_at: new Date().toISOString(),
      product_description: sourceEvidence.product_description,
      presentation_class: sourceEvidence.presentation_class,
      presentation_fallback: false,
      description_model: sourceEvidence.description_model,
      described_at: new Date().toISOString(),
      description_cost_usd: sourceEvidence.description_cost_usd,
    })
    .select('id')
    .single<{ id: string }>()
  if (intakeError || !intake) throw new Error(intakeError?.message || 'Could not seed intake.')

  const intakeFileId = intake.id
  const originalKey = `originals/${intakeFileId}.png`
  const v1Key = `versions/${intakeFileId}/v1.png`
  const v1ThumbKey = `versions/${intakeFileId}/v1_thumb.webp`
  const v2Key = `versions/${intakeFileId}/v2.png`
  const v2ThumbKey = `versions/${intakeFileId}/v2_thumb.webp`
  const originalDimensions = await readImageDimensions(source)
  const v1Dimensions = await readImageDimensions(v1)
  const v1Thumb = await makeThumbnail(v1)

  await store.putImmutable(originalKey, source, 'image/png', {
    'intake-id': intakeFileId,
    'acceptance-fixture': 'phase5',
  })
  await store.putImmutable(v1Key, v1, 'image/png', {
    'intake-id': intakeFileId,
    'version-no': '1',
    'acceptance-fixture': 'phase5',
  })
  await store.putImmutable(v1ThumbKey, v1Thumb, 'image/webp', {
    'intake-id': intakeFileId,
    'version-no': '1',
    'acceptance-fixture': 'phase5',
  })

  const { data: originalVersion, error: originalError } = await db
    .from('image_versions')
    .insert({
      intake_file_id: intakeFileId,
      version_no: 0,
      kind: 'original',
      storage_key: originalKey,
      width: originalDimensions.width,
      height: originalDimensions.height,
      is_selected: false,
    })
    .select('id')
    .single<{ id: string }>()
  if (originalError || !originalVersion) {
    throw new Error(originalError?.message || 'Could not seed original version.')
  }
  const { error: v1Error } = await db.from('image_versions').insert({
    intake_file_id: intakeFileId,
    version_no: 1,
    kind: 'generated',
    storage_key: v1Key,
    thumb_key: v1ThumbKey,
    width: v1Dimensions.width,
    height: v1Dimensions.height,
    prompt_text: sourceEvidence.prompt_text,
    model: sourceEvidence.image_model,
    cost_usd: sourceEvidence.image_cost_usd,
    parent_version_id: originalVersion.id,
    is_selected: true,
    description_injected: true,
    description_missing: false,
  })
  if (v1Error) throw new Error(`Could not seed version 1: ${v1Error.message}`)

  const descriptionBefore = {
    text: sourceEvidence.product_description,
    model: sourceEvidence.description_model,
    costUsd: sourceEvidence.description_cost_usd,
  }
  const redoJobId = await queueImageRedo(intakeFileId, ACTOR)
  const redo = await runProductionRedoBatch(redoJobId)
  assert(redo.completed === 1, `Redo did not complete: ${JSON.stringify(redo)}`)
  assert(redo.paidCalls === 1, 'Acceptance redo did not make exactly one image call.')
  assert(redo.versionNo === 2, 'Acceptance redo did not reserve version 2.')
  assert(redo.costUsd !== null && redo.costUsd <= 0.2, 'Redo exceeded the cost ceiling.')

  const [{ data: intakeAfter }, { data: versions }, { data: events }] = await Promise.all([
    db
      .from('intake_files')
      .select(
        'product_description, description_model, description_cost_usd, presentation_class',
      )
      .eq('id', intakeFileId)
      .single(),
    db
      .from('image_versions')
      .select(
        'id, version_no, kind, storage_key, thumb_key, prompt_text, model, cost_usd, parent_version_id, is_selected, description_injected, description_missing',
      )
      .eq('intake_file_id', intakeFileId)
      .order('version_no'),
    db
      .from('events')
      .select('event, actor, detail')
      .eq('entity_id', redoJobId)
      .order('id'),
  ])
  assert(intakeAfter, 'Acceptance intake disappeared.')
  assert(
    intakeAfter.product_description === descriptionBefore.text &&
      intakeAfter.description_model === descriptionBefore.model &&
      Number(intakeAfter.description_cost_usd) === descriptionBefore.costUsd,
    'Redo changed the cached descriptor result.',
  )
  assert(versions?.length === 3, 'Redo did not retain original, v1 and v2.')
  assert(versions[1]?.is_selected === true, 'Redo silently changed the selected version.')
  assert(versions[2]?.is_selected === false, 'Unreviewed redo became selected.')
  assert(versions[2]?.prompt_text?.includes(sourceEvidence.product_description), 'V2 omitted cached description.')
  assert(versions[2]?.model === originalPrompt.model, 'V2 recorded the wrong model.')
  assert(
    events?.map((event) => event.event).join(',') ===
      'image.redo_queued,image.redo_claimed,image.redo_completed',
    'Redo audit events are incomplete.',
  )
  assert(
    !(events ?? []).some((event) => event.event.startsWith('description.')),
    'Redo made or recorded a descriptor call.',
  )

  const { data: restoredPromptId, error: restoreError } = await db.rpc(
    'promote_prompt_version',
    { p_prompt_id: originalPrompt.id, p_actor: ACTOR },
  )
  if (restoreError || typeof restoredPromptId !== 'string') {
    throw new Error(restoreError?.message || 'Could not restore the accepted prompt.')
  }
  const restored = await currentImagePrompt()
  assert(restored.body === originalPrompt.body, 'Restored prompt body differs.')
  assert(restored.model === originalPrompt.model, 'Restored prompt model differs.')

  const state: FixtureState = {
    intakeFileId,
    originalPrompt,
    acceptancePromptId,
    restoredPromptId,
    redoJobId,
    objectKeys: [originalKey, v1Key, v1ThumbKey, v2Key, v2ThumbKey],
  }
  await writeFile(FIXTURES, `${JSON.stringify(state, null, 2)}\n`)
  const v2 = await store.get(v2Key)
  await writeFile(path.join(ROOT, 'redo-v2.png'), v2)
  await writeFile(
    EVIDENCE,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        actor: ACTOR,
        prompt: {
          originalId: originalPrompt.id,
          acceptanceId: acceptancePromptId,
          restoredId: restoredPromptId,
          currentAfterAcceptance: restored.id,
          createDidNotPromote: true,
          promotionWasAtomic: true,
        },
        intakeFileId,
        descriptionBefore,
        descriptionAfter: intakeAfter,
        redo,
        versions,
        events,
        noDescriptorCall: true,
        objectKeys: state.objectKeys,
        screenshotPaths: {
          prompts: path.join(ROOT, 'prompts.png'),
          versions: path.join(ROOT, 'versions.png'),
        },
      },
      null,
      2,
    )}\n`,
  )

  console.log(`Phase 5 live acceptance PASS`)
  console.log(`prompt create/promote/restore · ${acceptancePromptId}`)
  console.log(`redo ${redoJobId} · v2 · $${redo.costUsd} · descriptor calls 0`)
  console.log(`fixture ${intakeFileId} left for browser review; run cleanup afterwards`)
}

async function cleanup(): Promise<void> {
  const state = await readFixtureState()
  const db = supabaseServer()
  const store = objectStore()
  const current = await currentImagePrompt()
  assert(
    current.id === state.restoredPromptId ||
      current.id === state.originalPrompt.id,
    'The live image prompt changed after acceptance. Cleanup refuses to overwrite it.',
  )

  const { error: clearDefaultsError } = await db
    .from('prompts')
    .update({ is_default: false, archived_at: new Date().toISOString() })
    .eq('kind', 'image')
    .eq('is_default', true)
  if (clearDefaultsError) throw new Error(clearDefaultsError.message)
  const { error: restoreError } = await db
    .from('prompts')
    .update({
      is_default: true,
      archived_at: state.originalPrompt.archived_at,
    })
    .eq('id', state.originalPrompt.id)
  if (restoreError) throw new Error(restoreError.message)

  const { error: jobsError } = await db
    .from('image_redo_jobs')
    .delete()
    .eq('id', state.redoJobId)
  if (jobsError) throw new Error(jobsError.message)
  const { error: intakeError } = await db
    .from('intake_files')
    .delete()
    .eq('id', state.intakeFileId)
  if (intakeError) throw new Error(intakeError.message)

  const promptIds = [state.acceptancePromptId, state.restoredPromptId].filter(
    (id) => id !== state.originalPrompt.id,
  )
  if (promptIds.length) {
    const { error: promptsError } = await db.from('prompts').delete().in('id', promptIds)
    if (promptsError) throw new Error(promptsError.message)
  }
  await db.from('events').delete().eq('actor', ACTOR)
  await db.from('events').delete().eq('entity_id', state.redoJobId)

  for (const key of state.objectKeys) await store.delete(key)
  await writeFile(
    path.join(ROOT, 'cleanup.json'),
    `${JSON.stringify(
      {
        cleanedAt: new Date().toISOString(),
        intakeFileId: state.intakeFileId,
        redoJobId: state.redoJobId,
        restoredPromptId: state.originalPrompt.id,
        removedObjectKeys: state.objectKeys,
      },
      null,
      2,
    )}\n`,
  )
  await import('node:fs/promises').then(({ unlink }) => unlink(FIXTURES))
  console.log('Phase 5 acceptance cleanup PASS')
}

async function main() {
  const mode = process.argv[2]
  if (mode === 'accept') await accept()
  else if (mode === 'cleanup') await cleanup()
  else throw new Error('Usage: npm run verify:phase5 -- accept|cleanup')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
