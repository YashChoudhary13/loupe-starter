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
  return watchRawFolder(drive, repository, serverEnv.driveRawFolderId)
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
  return { redo, intake: await runProductionEnhancementBatch() }
}

export async function runShopifyReconciliationCron() {
  // Promotion runs FIRST. A draft the operator published from Shopify's own
  // admin should be compared as a published product in the very same run,
  // rather than waiting another day to be noticed.
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
