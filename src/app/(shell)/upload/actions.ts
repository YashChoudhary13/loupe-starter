'use server'

import { NotAuthorisedError, requireOperatorForAction } from '@/lib/auth/authorize'
import { ConsoleError } from '@/lib/console/mutations'
import { nudgeEnhanceCron } from '@/lib/cron/jobs'
import {
  beginManualUpload,
  finalizeRawUpload,
  readRawUploadImage,
  type BeginManualUploadInput,
  type ManualUploadTicket,
} from '@/lib/manual-upload/server'
import { AUTO_SETTING, defaultSettingFor, pickSetting } from '@/lib/prompts/art-director'
import { ensurePromptPair } from '@/lib/prompts/ensure-pair'
import { categoryCore, promptSetting } from '@/lib/prompts/matrix'

/**
 * D103 — the Upload section. Same result contract as the console actions so
 * failures always carry an operator-facing sentence.
 */

export interface UploadActionError {
  readonly message: string
  readonly detail: string | null
  readonly retryable: boolean
}

export type UploadActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: UploadActionError }

async function withOperator<T>(
  run: (operator: Awaited<ReturnType<typeof requireOperatorForAction>>) => Promise<T>,
): Promise<UploadActionResult<T>> {
  try {
    return { ok: true, data: await run(await requireOperatorForAction()) }
  } catch (cause) {
    if (cause instanceof NotAuthorisedError) {
      return { ok: false, error: { message: cause.message, detail: null, retryable: false } }
    }
    if (cause instanceof ConsoleError) {
      return {
        ok: false,
        error: {
          message: cause.operatorMessage,
          detail: cause.detail,
          retryable: cause.retryable,
        },
      }
    }
    const detail = cause instanceof Error ? cause.message : String(cause)
    console.error('upload action failed:', detail)
    return {
      ok: false,
      error: {
        message: 'That did not work and nothing was queued. Try the file again.',
        detail,
        retryable: true,
      },
    }
  }
}

export async function beginRawUploadAction(
  input: BeginManualUploadInput,
): Promise<UploadActionResult<ManualUploadTicket>> {
  return withOperator((operator) => beginManualUpload(operator, input, 'raw'))
}

export async function finalizeRawUploadAction(input: {
  readonly uploadId: string
  readonly categorySlug: string | null
  readonly settingSlug: string | null
}): Promise<UploadActionResult<{ intakeFileId: string; presetSlug: string | null }>> {
  return withOperator(async (operator) => {
    let presetSlug: string | null = null
    let settingSlug = input.settingSlug
    // D120 — "Auto" delegates the scene choice to the art director. It never
    // blocks the upload: any failure inside pickSetting resolves to the house
    // ground, and a category is still required (D1 — nothing guesses that).
    if (input.categorySlug && settingSlug === AUTO_SETTING) {
      const source = await readRawUploadImage(operator, input.uploadId)
      settingSlug = source
        ? (await pickSetting(source.image, source.mimeType, input.categorySlug)).settingSlug
        : defaultSettingFor(input.categorySlug)
    }
    if (input.categorySlug && settingSlug) {
      if (!categoryCore(input.categorySlug) || !promptSetting(settingSlug)) {
        throw new ConsoleError(
          'That prompt combination no longer exists. Pick the category and setting again.',
          `${input.categorySlug} × ${settingSlug}`,
          false,
        )
      }
      presetSlug = await ensurePromptPair(input.categorySlug, settingSlug, operator.email)
    }

    const intakeFileId = await finalizeRawUpload(operator, input.uploadId, presetSlug)
    // The pipeline normally waits for the minute tick; a fresh upload deserves
    // the same nudge a Drive discovery gets.
    await nudgeEnhanceCron().catch(() => undefined)
    return { intakeFileId, presetSlug }
  })
}
