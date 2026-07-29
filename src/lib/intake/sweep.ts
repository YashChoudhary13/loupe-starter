import type { IntakeRepository } from './repository'

export interface SweepResult {
  readonly requeued: number
}

export async function sweepExpiredLeases(
  repository: IntakeRepository,
): Promise<SweepResult> {
  const requeued = await repository.sweepExpiredIntakeLeases()
  await repository.recordSystemEvent({
    event: 'intake.lease_sweep.completed',
    actor: 'cron',
    detail: {
      source: 'lease-sweeper',
      requeued,
    },
  })
  return { requeued }
}
