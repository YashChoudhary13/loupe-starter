export interface EnhancementClaim {
  readonly id: string
  readonly driveFileId: string
  readonly filename: string
  readonly driveMd5: string | null
  readonly bytes: number | null
  readonly mimeType: string
  readonly attempts: number
  readonly leaseToken: string
  readonly leaseExpiresAt: string
  readonly productDescription: string | null
  readonly descriptionModel: string | null
  readonly describedAt: string | null
  readonly descriptionCostUsd: number | null
  readonly descriptionMissingAt: string | null
}

export type PromptKind = 'describe' | 'image'

export interface LivePrompt {
  readonly id: string
  readonly name: string
  readonly kind: PromptKind
  readonly body: string
}

export interface LivePrompts {
  readonly describe: LivePrompt
  readonly image: LivePrompt
}

export interface DescriptionCache {
  readonly text: string
  readonly model: string
  readonly describedAt: string
  readonly costUsd: number
}

export interface DescriptionFailureResult {
  readonly status: 'discovered' | 'enhancing'
  readonly attempts: number
  readonly nextAttemptAt: string
  readonly proceedWithoutDescription: boolean
}

export interface CompletionInput {
  readonly intakeFileId: string
  readonly leaseToken: string
  readonly originalStorageKey: string
  readonly originalWidth: number
  readonly originalHeight: number
  readonly generatedStorageKey: string
  readonly thumbKey: string
  readonly generatedWidth: number
  readonly generatedHeight: number
  readonly model: string
  readonly promptText: string
  readonly costUsd: number
  readonly maxCostUsd: number
  readonly descriptionInjected: boolean
  readonly descriptionMissing: boolean
  readonly source: string
}

export interface EnhancementCompletion {
  readonly status: 'enhanced' | 'failed'
  readonly attempts: number
  readonly imageVersionId: string
  readonly versionNo: number
  readonly costUsd: number
}

export interface IntakeFailureInput {
  readonly intakeFileId: string
  readonly leaseToken: string
  readonly message: string
  readonly code: string
  readonly retryable: boolean
  readonly detail: string
  readonly source: string
}

export interface IntakeFailureResult {
  readonly status: 'discovered' | 'failed'
  readonly attempts: number
  readonly nextAttemptAt: string
}

export interface EnhancementRepository {
  claim(leaseSeconds: number): Promise<EnhancementClaim | null>
  assertLease(intakeFileId: string, leaseToken: string): Promise<boolean>
  loadLivePrompts(): Promise<LivePrompts>
  storeDescription(input: {
    readonly intakeFileId: string
    readonly leaseToken: string
    readonly description: string
    readonly model: string
    readonly costUsd: number
    readonly source: string
  }): Promise<DescriptionCache>
  recordDescriptionFailure(input: {
    readonly intakeFileId: string
    readonly leaseToken: string
    readonly message: string
    readonly code: string
    readonly detail: string
    readonly source: string
  }): Promise<DescriptionFailureResult>
  complete(input: CompletionInput): Promise<EnhancementCompletion>
  recordFailure(input: IntakeFailureInput): Promise<IntakeFailureResult>
}

export class EnhancementRepositoryError extends Error {
  readonly retryable: boolean
  readonly detail?: unknown

  constructor(message: string, options: { readonly retryable: boolean; readonly detail?: unknown }) {
    super(message)
    this.name = 'EnhancementRepositoryError'
    this.retryable = options.retryable
    this.detail = options.detail
  }
}
