import type {
  IntakeDiscoveryResult,
  IntakeFileDiscovery,
  IntakeRepository,
  SyncStateLease,
  SystemEvent,
} from '@/lib/intake/repository'

export class MemoryIntakeRepository implements IntakeRepository {
  readonly discoveries: IntakeFileDiscovery[] = []
  readonly completedValues: string[] = []
  readonly releasedTokens: string[] = []
  readonly events: SystemEvent[] = []
  readonly fileIds = new Set<string>()

  persistedValue: string | null = null
  leaseAvailable = true
  leaseToken = 'lease-1'
  sweepCount = 0

  async discoverIntakeFile(input: IntakeFileDiscovery): Promise<IntakeDiscoveryResult> {
    this.discoveries.push(input)
    const inserted = !this.fileIds.has(input.driveFileId)
    this.fileIds.add(input.driveFileId)
    return {
      id: `intake-${input.driveFileId}`,
      inserted,
      status: 'discovered',
      attempts: 0,
    }
  }

  async claimSyncState(key: string, _leaseSeconds: number): Promise<SyncStateLease | null> {
    void _leaseSeconds
    if (!this.leaseAvailable) return null
    return {
      key,
      value: this.persistedValue,
      leaseToken: this.leaseToken,
      leaseExpiresAt: '2026-07-29T12:05:00.000Z',
    }
  }

  async completeSyncState(
    _key: string,
    leaseToken: string,
    value: string,
  ): Promise<boolean> {
    if (leaseToken !== this.leaseToken) return false
    this.persistedValue = value
    this.completedValues.push(value)
    return true
  }

  async releaseSyncState(_key: string, leaseToken: string): Promise<boolean> {
    this.releasedTokens.push(leaseToken)
    return leaseToken === this.leaseToken
  }

  async sweepExpiredIntakeLeases(): Promise<number> {
    return this.sweepCount
  }

  async recordSystemEvent(event: SystemEvent): Promise<void> {
    this.events.push(event)
  }
}
