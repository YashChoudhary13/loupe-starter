export type RedoStatus = 'queued' | 'processing' | 'completed' | 'failed'

export interface RedoClaim {
  readonly id: string
  readonly intakeFileId: string
  readonly sourceVersionId: string
  readonly sourceStorageKey: string
  readonly versionNo: number
  readonly promptId: string
  readonly promptText: string
  readonly model: string
  readonly descriptionInjected: boolean
  readonly descriptionMissing: boolean
  readonly attempts: number
  readonly leaseToken: string
  readonly leaseExpiresAt: string
  readonly generationStartedAt: string | null
}

export interface RedoCompletion {
  readonly status: 'completed' | 'failed'
  readonly imageVersionId: string
  readonly versionNo: number
  readonly costUsd: number
}

export interface RedoFailure {
  readonly status: 'queued' | 'failed'
  readonly attempts: number
  readonly nextAttemptAt: string
}

export interface RedoRepository {
  enqueue(input: {
    readonly intakeFileId: string
    readonly promptId: string
    readonly promptText: string
    readonly descriptionInjected: boolean
    readonly descriptionMissing: boolean
    readonly actor: string
  }): Promise<string>
  claim(leaseSeconds: number, jobId?: string): Promise<RedoClaim | null>
  assertLease(jobId: string, leaseToken: string): Promise<boolean>
  markGenerationStarted(jobId: string, leaseToken: string): Promise<string>
  complete(input: {
    readonly jobId: string
    readonly leaseToken: string
    readonly storageKey: string
    readonly thumbKey: string
    readonly width: number
    readonly height: number
    readonly actualModel: string
    readonly costUsd: number
    readonly maxCostUsd: number
    readonly source: string
  }): Promise<RedoCompletion>
  recordFailure(input: {
    readonly jobId: string
    readonly leaseToken: string
    readonly message: string
    readonly code: string
    readonly retryable: boolean
    readonly source: string
  }): Promise<RedoFailure>
}
