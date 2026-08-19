import 'server-only'

import { supabaseServer } from '@/lib/supabase/server'

import { composeClientPair } from './matrix'

/**
 * D103/D104 — category × setting prompt pairs, materialised on demand.
 *
 * The matrix in matrix.ts is code: category cores carry every protection rule
 * and a single {{SETTING_DETAIL}} slot; settings carry pure scene paragraphs.
 * A pair only becomes prompt ROWS (slug `category--setting`, or
 * `category--setting--measured` when dimension callouts are on) the first time an
 * operator uses that combination, through the same create_prompt_version RPC
 * every hand-written revision goes through — so validation, audit events and
 * immutability are identical. Re-ensuring after a matrix improvement writes a
 * NEW revision; the worker and promote both pick newest-per-kind (D96), so
 * bound photographs and promoted defaults follow automatically.
 */

const DESCRIBE_MODEL = 'moonshotai/kimi-k3'
const IMAGE_MODEL = 'openai/gpt-image-2'

async function newestPair(slug: string): Promise<{
  describe: { id: string; body: string } | null
  image: { id: string; body: string } | null
}> {
  const db = supabaseServer()
  const { data, error } = await db
    .from('prompts')
    .select('id, kind, body, created_at')
    .eq('preset_slug', slug)
    .in('kind', ['describe', 'image'])
    .order('created_at', { ascending: false })
  if (error) throw new Error(`prompt pair read: ${error.message}`)
  const rows = (data ?? []) as { id: string; kind: string; body: string }[]
  return {
    describe: rows.find((row) => row.kind === 'describe') ?? null,
    image: rows.find((row) => row.kind === 'image') ?? null,
  }
}

async function createHalf(
  kind: 'describe' | 'image',
  name: string,
  body: string,
  model: string,
  slug: string,
  actor: string,
): Promise<void> {
  const db = supabaseServer()
  const { data, error } = await db.rpc('create_prompt_version', {
    p_kind: kind,
    p_name: name,
    p_body: body,
    p_model: model,
    p_actor: actor,
  })
  if (error || typeof data !== 'string') {
    throw new Error(`create_prompt_version ${kind}: ${error?.hint || error?.message}`)
  }
  // create_prompt_version predates presets and takes no slug; stamping it after
  // the fact is what every migration-inserted preset row carries too.
  const { error: stampError } = await db
    .from('prompts')
    .update({ preset_slug: slug })
    .eq('id', data)
  if (stampError) throw new Error(`preset stamp ${kind}: ${stampError.message}`)
}

/**
 * Returns the pair slug, creating or refreshing the two prompt rows when the
 * composed bodies differ from the newest stored revision.
 */
export async function ensurePromptPair(
  categorySlug: string,
  settingSlug: string,
  actor: string,
  measurementSlug: string = 'plain',
): Promise<string> {
  const composed = composeClientPair(categorySlug, settingSlug, measurementSlug)
  if (!composed) {
    throw new Error(
      `Unknown prompt combination: ${categorySlug} × ${settingSlug} × ${measurementSlug}`,
    )
  }

  const existing = await newestPair(composed.slug)
  if (!existing.describe || existing.describe.body !== composed.describeBody) {
    await createHalf(
      'describe',
      `${composed.label} — describe`,
      composed.describeBody,
      DESCRIBE_MODEL,
      composed.slug,
      actor,
    )
  }
  if (!existing.image || existing.image.body !== composed.imageBody) {
    await createHalf(
      'image',
      `${composed.label} — image`,
      composed.imageBody,
      IMAGE_MODEL,
      composed.slug,
      actor,
    )
  }
  return composed.slug
}
