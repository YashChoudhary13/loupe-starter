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
