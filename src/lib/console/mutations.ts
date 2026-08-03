import 'server-only'

import type { PostgrestError } from '@supabase/supabase-js'

import type { Operator } from '@/lib/auth/authorize'
import type { VariantKind } from '@/lib/console/types'
import { supabaseServer } from '@/lib/supabase/server'

/**
 * Every write the console makes, and the translation of a Postgres failure into
 * something the operator can act on.
 *
 * DESIGN.md: *"Error messages are written for the operator, not the developer.
 * Say what happened and what to do."* The database functions already carry that
 * sentence in their `HINT`, deliberately — the person who knew why a rule exists
 * wrote the rule and the explanation together. So the hint is what surfaces, and
 * the raw SQLSTATE and message go behind Details.
 */

export class ConsoleError extends Error {
  /** Safe to show. Never contains a token, a key, a signed URL or a stack. */
  readonly operatorMessage: string
  /** For the Details expander. May name tables and SQLSTATEs. */
  readonly detail: string | null
  /** True when reloading and trying again is the right move. */
  readonly retryable: boolean

  constructor(operatorMessage: string, detail: string | null = null, retryable = true) {
    super(detail ? `${operatorMessage} — ${detail}` : operatorMessage)
    this.name = 'ConsoleError'
    this.operatorMessage = operatorMessage
    this.detail = detail
    this.retryable = retryable
  }
}

function fail(context: string, error: PostgrestError): never {
  const detail = [error.code, error.message].filter(Boolean).join(' · ')
  // The hint is the operator-facing sentence the SQL function was written with.
  // Falling back to `context` rather than to `error.message` keeps PostgREST
  // wording — "duplicate key value violates unique constraint" — off the screen.
  throw new ConsoleError(error.hint?.trim() || context, detail, error.code === '55000')
}

export async function createDraftFromPhotos(
  operator: Operator,
  categoryId: string,
  intakeFileIds: readonly string[],
): Promise<string> {
  const { data, error } = await supabaseServer().rpc('create_product_draft', {
    p_category_id: categoryId,
    p_intake_file_ids: intakeFileIds,
    p_actor: operator.email,
  })
  if (error) fail('Those photographs could not be grouped. Reload the queue and try again.', error)
  return data as string
}

export async function attachPhoto(
  operator: Operator,
  draftId: string,
  intakeFileId: string,
): Promise<void> {
  const { error } = await supabaseServer().rpc('attach_intake_file', {
    p_draft_id: draftId,
    p_intake_file_id: intakeFileId,
    p_actor: operator.email,
  })
  if (error) fail('That photograph could not be added to this product.', error)
}

export async function detachPhoto(
  operator: Operator,
  draftId: string,
  intakeFileId: string,
): Promise<void> {
  const { error } = await supabaseServer().rpc('detach_intake_file', {
    p_draft_id: draftId,
    p_intake_file_id: intakeFileId,
    p_actor: operator.email,
  })
  if (error) fail('That photograph could not be returned to the queue.', error)
}

export interface DraftSaveInput {
  readonly draftId: string
  /** The `updated_at` the editor was opened with. A mismatch refuses the save. */
  readonly expectedUpdatedAt: string | null
  readonly categoryId: string
  readonly materialId: string | null
  readonly customMaterial: string | null
  readonly descriptionOverride: string | null
  readonly titleSuffix: string | null
  readonly pricePaise: number | null
  readonly weightG: number | null
  readonly stock: number
  readonly variantKind: VariantKind
  readonly variants: readonly { value: string; stock: number }[]
  readonly images: readonly { imageVersionId: string; position: number }[]
}

/** Returns the draft's new `updated_at`, which the editor keeps for the next save. */
export async function saveDraft(operator: Operator, input: DraftSaveInput): Promise<string> {
  const { data, error } = await supabaseServer().rpc('save_product_draft', {
    p_draft_id: input.draftId,
    p_expected_updated_at: input.expectedUpdatedAt,
    p_category_id: input.categoryId,
    p_material_id: input.materialId,
    p_custom_material: input.customMaterial,
    p_description_override: input.descriptionOverride,
    p_title_suffix: input.titleSuffix,
    p_price_paise: input.pricePaise,
    p_weight_g: input.weightG,
    p_stock: input.stock,
    p_variant_kind: input.variantKind,
    p_variants: input.variants,
    p_images: input.images.map((image) => ({
      image_version_id: image.imageVersionId,
      position: image.position,
    })),
    p_actor: operator.email,
  })
  if (error) fail('This draft could not be saved.', error)
  return data as string
}
