import { createHash } from 'node:crypto'

import type {
  EnhancementClaim,
  EnhancementCompletion,
  EnhancementRepository,
  IntakeFailureInput,
  IntakeFailureResult,
  LivePrompts,
} from '@/lib/enhance/repository'
import type {
  ImmutableObjectStore,
  ImmutablePutResult,
  StoredObject,
} from '@/lib/enhance/storage'
import type { PresentationClass } from '@/lib/enhance/presentation'

export const TEST_DESCRIPTION =
  'A matching pair of two drop earrings in polished yellow-gold metal. Each earring has one compact oval upper form with a continuous field of clear round stones, joined by one small hinged fitting to one smooth oval cabochon-style lower element in a slim bezel. Both pieces have the same vertical silhouette and proportions, with no extra pendant or side charm. The visible metal surfaces are smooth without engraving or texture, and the source shows two separate fittings rather than one piece duplicated or mirrored during presentation.'

export const TEST_PROMPTS: LivePrompts = {
  describe: {
    id: 'prompt-describe',
    name: 'describe',
    kind: 'describe',
    usesComposition: true,
    model: 'openai/gpt-5.6-sol',
    body: 'Describe only the jewellery.',
  },
  image: {
    id: 'prompt-image',
    name: 'image',
    kind: 'image',
    usesComposition: true,
    model: 'openai/gpt-image-2',
    body: `A hero image.

PRODUCT
{{PRODUCT_DESCRIPTION}}

COMPOSITION
{{COMPOSITION_DETAIL}}

SUBJECT — jewellery only.`,
  },
}

export function claim(
  id: string,
  overrides: Partial<EnhancementClaim> = {},
): EnhancementClaim {
  return {
    id,
    driveFileId: `drive-${id}`,
    filename: `${id}.jpg`,
    driveMd5: null,
    bytes: null,
    mimeType: 'image/jpeg',
    attempts: 0,
    leaseToken: `lease-${id}`,
    leaseExpiresAt: '2026-07-29T23:00:00.000Z',
    productDescription: null,
    presentationClass: null,
    presentationFallback: false,
    presentationFallbackReason: null,
    descriptionModel: null,
    describedAt: null,
    descriptionCostUsd: null,
    descriptionMissingAt: null,
    ...overrides,
  }
}

export class MemoryEnhancementRepository implements EnhancementRepository {
  readonly claims: EnhancementClaim[] = []
  readonly validLeases = new Set<string>()
  readonly storedDescriptions: Array<{
    intakeFileId: string
    description: string
    presentationClass: PresentationClass
    model: string
    costUsd: number
  }> = []
  readonly storedPerceptualHashes: Array<{
    intakeFileId: string
    phash: string
  }> = []
  readonly completions: Parameters<EnhancementRepository['complete']>[0][] = []
  readonly failures: IntakeFailureInput[] = []
  readonly descriptionFailures: string[] = []
  readonly presentationFallbacks: Array<{
    intakeFileId: string
    reason: string
  }> = []
  readonly attemptsById = new Map<string, number>()

  prompts = TEST_PROMPTS

  enqueue(item: EnhancementClaim): void {
    this.claims.push(item)
    this.validLeases.add(item.leaseToken)
    this.attemptsById.set(item.id, item.attempts)
  }

  async claim(leaseSeconds: number): Promise<EnhancementClaim | null> {
    void leaseSeconds
    return this.claims.shift() ?? null
  }

  async assertLease(_intakeFileId: string, leaseToken: string): Promise<boolean> {
    return this.validLeases.has(leaseToken)
  }

  async storePerceptualHash(input: {
    readonly intakeFileId: string
    readonly leaseToken: string
    readonly phash: string
  }): Promise<string> {
    if (!this.validLeases.has(input.leaseToken)) throw new Error('stale')
    this.storedPerceptualHashes.push(input)
    return input.phash
  }

  async loadLivePrompts(): Promise<LivePrompts> {
    return this.prompts
  }

  async storeDescription(input: {
    readonly intakeFileId: string
    readonly leaseToken: string
    readonly description: string
    readonly presentationClass: PresentationClass
    readonly model: string
    readonly costUsd: number
  }) {
    if (!this.validLeases.has(input.leaseToken)) throw new Error('stale')
    this.storedDescriptions.push(input)
    return {
      text: input.description,
      presentationClass: input.presentationClass,
      presentationFallback: false as const,
      presentationFallbackReason: null,
      model: input.model,
      describedAt: '2026-07-29T12:00:00.000Z',
      costUsd: input.costUsd,
    }
  }

  async ensurePresentationFallback(input: {
    readonly intakeFileId: string
    readonly leaseToken: string
    readonly reason: string
  }) {
    if (!this.validLeases.has(input.leaseToken)) throw new Error('stale')
    this.presentationFallbacks.push(input)
    return {
      presentationClass: 'flat-curve' as const,
      presentationFallback: true,
      presentationFallbackReason: input.reason,
    }
  }

  async recordDescriptionFailure(input: {
    readonly intakeFileId: string
    readonly leaseToken: string
    readonly message: string
    readonly code: string
  }) {
    this.descriptionFailures.push(input.code)
    const active = this.validLeases.has(input.leaseToken)
    if (!active) throw new Error('stale')
    const attempts = this.attemptsById.get(input.intakeFileId) ?? 0
    const completedAttempts = Math.min(4, attempts + 1)
    const proceed = input.code === 'description_cost_ceiling_exceeded'
    const terminal = !proceed && completedAttempts >= 4
    this.attemptsById.set(input.intakeFileId, completedAttempts)
    if (!proceed) this.validLeases.delete(input.leaseToken)
    if (proceed) {
      this.presentationFallbacks.push({
        intakeFileId: input.intakeFileId,
        reason: input.code,
      })
    }
    return {
      status: terminal
        ? ('failed' as const)
        : proceed
          ? ('enhancing' as const)
          : ('discovered' as const),
      attempts: completedAttempts,
      nextAttemptAt: '2026-07-29T12:01:00.000Z',
      proceedWithoutDescription: proceed,
      presentationClass: proceed ? ('flat-curve' as const) : null,
      presentationFallback: proceed,
      presentationFallbackReason: proceed ? input.code : null,
    }
  }

  async complete(
    input: Parameters<EnhancementRepository['complete']>[0],
  ): Promise<EnhancementCompletion> {
    if (!this.validLeases.has(input.leaseToken)) throw new Error('stale')
    this.validLeases.delete(input.leaseToken)
    this.completions.push(input)
    return {
      status: input.costUsd > input.maxCostUsd ? 'failed' : 'enhanced',
      attempts: 1,
      imageVersionId: `version-${input.intakeFileId}`,
      versionNo: 1,
      costUsd: input.costUsd,
    }
  }

  async recordFailure(input: IntakeFailureInput): Promise<IntakeFailureResult> {
    if (!this.validLeases.has(input.leaseToken)) throw new Error('stale')
    this.validLeases.delete(input.leaseToken)
    this.failures.push(input)
    return {
      status: input.retryable ? 'discovered' : 'failed',
      attempts: 1,
      nextAttemptAt: '2026-07-29T12:01:00.000Z',
    }
  }
}

function digest(input: Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

export class MemoryObjectStore implements ImmutableObjectStore {
  readonly objects = new Map<
    string,
    { body: Buffer; contentType: string; metadata: Readonly<Record<string, string>> }
  >()

  async putImmutable(
    key: string,
    body: Buffer,
    contentType: string,
    metadata: Readonly<Record<string, string>> = {},
  ): Promise<ImmutablePutResult> {
    const sha256 = digest(body)
    const existing = this.objects.get(key)
    if (existing && !existing.body.equals(body)) throw new Error(`immutable conflict: ${key}`)
    if (!existing) {
      this.objects.set(key, {
        body: Buffer.from(body),
        contentType,
        metadata: { ...metadata, sha256 },
      })
    }
    const stored = this.objects.get(key)!
    return {
      key,
      bytes: stored.body.byteLength,
      contentType: stored.contentType,
      etag: null,
      metadata: stored.metadata,
      created: !existing,
      sha256,
    }
  }

  async head(key: string): Promise<StoredObject | null> {
    const object = this.objects.get(key)
    if (!object) return null
    return {
      key,
      bytes: object.body.byteLength,
      contentType: object.contentType,
      etag: null,
      metadata: object.metadata,
    }
  }

  async get(key: string): Promise<Buffer> {
    const object = this.objects.get(key)
    if (!object) throw new Error(`missing ${key}`)
    return Buffer.from(object.body)
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return `https://r2.test/${key}?expires=${expiresInSeconds}`
  }
}
