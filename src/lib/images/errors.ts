/**
 * The error shape the image helpers (sharp + R2) throw. Kept from the retired
 * enhancement worker (D144) because `image.ts` and `storage.ts` are the parts
 * of it every upload path still uses.
 */
export type EnhancementErrorStage = 'input' | 'image' | 'storage' | 'database' | 'fencing'

export interface EnhancementErrorInit {
  readonly stage: EnhancementErrorStage
  readonly code: string
  readonly retryable: boolean
  readonly detail?: unknown
}

export class EnhancementError extends Error {
  readonly stage: EnhancementErrorStage
  readonly code: string
  readonly retryable: boolean
  readonly detail?: unknown

  constructor(message: string, init: EnhancementErrorInit) {
    super(message)
    this.name = 'EnhancementError'
    this.stage = init.stage
    this.code = init.code
    this.retryable = init.retryable
    this.detail = init.detail
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

export function statusOf(error: unknown): number | undefined {
  const root = record(error)
  if (typeof root?.status === 'number') return root.status
  if (typeof root?.$metadata === 'object') {
    const status = record(root.$metadata)?.httpStatusCode
    if (typeof status === 'number') return status
  }
  const response = record(root?.response)
  return typeof response?.status === 'number' ? response.status : undefined
}
