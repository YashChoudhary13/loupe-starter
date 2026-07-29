export type IntakeDiscoverySource = 'watch' | 'reconcile'

export interface IntakeFileDiscovery {
  readonly driveFileId: string
  readonly filename: string
  readonly driveMd5: string | null
  readonly bytes: number | null
  readonly mimeType: string | null
  readonly source: IntakeDiscoverySource
}

export interface IntakeDiscoveryResult {
  readonly id: string
  readonly inserted: boolean
  readonly status: string
  readonly attempts: number
}

export interface SyncStateLease {
  readonly key: string
  readonly value: string | null
  readonly leaseToken: string
  readonly leaseExpiresAt: string
}

export interface SystemEvent {
  readonly event: string
  readonly detail: Readonly<Record<string, string | number | boolean | null>>
  readonly actor: string
}

/**
 * Persistence boundary for Drive intake.
 *
 * The production implementation uses service-role-only RPCs. Fakes implement
 * the same contract, so race behaviour can be proven without a live database.
 */
export interface IntakeRepository {
  discoverIntakeFile(input: IntakeFileDiscovery): Promise<IntakeDiscoveryResult>
  claimSyncState(key: string, leaseSeconds: number): Promise<SyncStateLease | null>
  completeSyncState(key: string, leaseToken: string, value: string): Promise<boolean>
  releaseSyncState(key: string, leaseToken: string): Promise<boolean>
  sweepExpiredIntakeLeases(): Promise<number>
  recordSystemEvent(event: SystemEvent): Promise<void>
}

export class IntakeRepositoryError extends Error {
  readonly retryable: boolean
  readonly detail?: unknown

  constructor(message: string, options: { readonly retryable: boolean; readonly detail?: unknown }) {
    super(message)
    this.name = 'IntakeRepositoryError'
    this.retryable = options.retryable
    this.detail = options.detail
  }
}
