import 'server-only'

import { serverEnv } from '@/lib/env'
import { googleDriveClient } from '@/lib/google/drive-server'
import { runReconcileJob } from '@/lib/intake/reconcile'
import { SupabaseIntakeRepository } from '@/lib/intake/supabase-repository'
import { sweepExpiredLeases } from '@/lib/intake/sweep'
import { watchRawFolder } from '@/lib/intake/watch'

export async function runWatchCron() {
  // Validates the service-account JSON before touching sync state or claiming a
  // lease, rather than failing lazily after work has begun.
  const drive = googleDriveClient()
  const repository = new SupabaseIntakeRepository()
  const result = await watchRawFolder(drive, repository, serverEnv.driveRawFolderId)

  // New photographs start enhancing NOW rather than on the next minute boundary.
  // Both jobs already run every minute, so this only removes the gap between
  // them — up to a minute of dead time on the first photograph of a batch, which
  // is the whole wait when an operator drops in a single test image.
  const nudged = result.inserted > 0 ? await nudgeEnhanceCron() : 'not_needed'
  return { ...result, nudged }
}

/**
 * Fire-and-forget POST to the enhancement endpoint.
 *
 * Deliberately gives up after two seconds. The request has been sent by then and
 * the handler is running; waiting for its response would hold this function open
 * for the whole batch and risk the watcher's own 30 s pg_net timeout. Exactly
 * the pg_cron pattern — pg_net does not wait either.
 *
 * No failure here is fatal — this is an optimisation on top of a cron job that
 * fires anyway; if it does not land, the next tick picks the work up as before.
 * But the reason is RETURNED rather than swallowed. A missing CRON_BASE_URL
 * would otherwise make this quietly do nothing in production for ever, while
 * every test passed.
 */
async function nudgeEnhanceCron(): Promise<string> {
  let url: string
  try {
    url = `${serverEnv.cronBaseUrl.replace(/\/+$/, '')}/api/cron/enhance`
  } catch (cause) {
    return `misconfigured: ${cause instanceof Error ? cause.message : String(cause)}`
  }

  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serverEnv.cronSecret}`,
      },
      body: JSON.stringify({ source: 'drive-watch-nudge' }),
      signal: AbortSignal.timeout(2_000),
    })
    return 'sent'
  } catch (cause) {
    // A timeout here is the EXPECTED path: the enhancement handler is running
    // and will not answer within two seconds.
    return cause instanceof Error && cause.name === 'TimeoutError'
      ? 'sent'
      : `failed: ${cause instanceof Error ? cause.message : String(cause)}`
  }
}

export async function runReconcileCron() {
  const drive = googleDriveClient()
  const repository = new SupabaseIntakeRepository()
  return runReconcileJob(drive, repository, serverEnv.driveRawFolderId)
}

export async function runSweepCron() {
  const repository = new SupabaseIntakeRepository()
  return sweepExpiredLeases(repository)
}

export async function runEnhanceCron() {
  // Redos are operator-requested and already have a cached description. Give
  // one queued redo the whole request budget; if there is none, continue with
  // the normal intake batch.
  const { runProductionRedoBatch } = await import('@/lib/enhance/redo-server')
  const redo = await runProductionRedoBatch()
  if (redo.claimed > 0) return { redo, intake: null }

  // Importing the production worker validates Drive only when intake work is
  // actually needed; the lightweight watcher/reconcile endpoints do not need it.
  const { runProductionEnhancementBatch } = await import('@/lib/enhance/server')
  const intake = await runProductionEnhancementBatch()

  // Photographs that have finished failing leave /Raw, so the folder shows only
  // work that is still Loupe's to do. Housekeeping, and it runs AFTER the batch
  // so a move that fails cannot affect an enhancement result (hard rule 3).
  const { sweepFailedFilesOutOfRaw, terminalFailures } = await import(
    '@/lib/enhance/failed-housekeeping'
  )
  let swept: Awaited<ReturnType<typeof sweepFailedFilesOutOfRaw>> = []
  if (terminalFailures(intake.outcomes).length > 0) {
    const { supabaseServer } = await import('@/lib/supabase/server')
    swept = await sweepFailedFilesOutOfRaw(intake.outcomes, {
      db: supabaseServer(),
      drive: googleDriveClient(),
      discardedFolderId: serverEnv.driveDiscardedFolderId,
      actor: 'cron:enhance',
    })
  }

  return { redo, intake, swept }
}

export async function runShopifyReconciliationCron() {
  // Draft sync runs FIRST. A draft published from Shopify's own admin should be
  // compared as a published product in this same run; a draft deleted there
  // should disappear from Loupe before the tracking snapshot is rebuilt.
  const { promotePublishedInShopify } = await import('@/lib/reconciliation/promote')
  const { runShopifyReconciliation } = await import('@/lib/reconciliation/server')

  let promotion
  try {
    promotion = await promotePublishedInShopify('supabase-pg-cron')
  } catch (cause) {
    // Promotion is an enhancement to reconciliation, not a precondition for it.
    // A failure here must not stop the drift check that the business actually
    // depends on.
    promotion = { error: cause instanceof Error ? cause.message : String(cause) }
  }

  const reconciliation = await runShopifyReconciliation('supabase-pg-cron')
  return { promotion, reconciliation }
}
