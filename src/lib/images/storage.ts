import { createHash } from 'node:crypto'

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import { EnhancementError, statusOf } from './errors'

export interface StoredObject {
  readonly key: string
  readonly bytes: number
  readonly contentType: string | null
  readonly etag: string | null
  readonly metadata: Readonly<Record<string, string>>
}

export interface ImmutablePutResult extends StoredObject {
  readonly created: boolean
  readonly sha256: string
}

export interface ImmutableObjectStore {
  putImmutable(
    key: string,
    body: Buffer,
    contentType: string,
    metadata?: Readonly<Record<string, string>>,
  ): Promise<ImmutablePutResult>
  head(key: string): Promise<StoredObject | null>
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
  presignGet(key: string, expiresInSeconds: number): Promise<string>
}

export interface R2Config {
  readonly endpoint: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly bucket: string
}

export function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex')
}

function contentMd5(input: Buffer): string {
  return createHash('md5').update(input).digest('base64')
}

function cleanEtag(etag: string | undefined): string | null {
  return etag?.replace(/^"|"$/g, '') || null
}

function metadataOf(value: Record<string, string> | undefined): Readonly<Record<string, string>> {
  return value ?? {}
}

function storageError(
  message: string,
  code: string,
  error: unknown,
  retryable?: boolean,
): EnhancementError {
  const status = statusOf(error)
  return new EnhancementError(message, {
    stage: 'storage',
    code,
    retryable:
      retryable ??
      (status === 408 ||
        status === 429 ||
        (status !== undefined && status >= 500)),
    detail: error,
  })
}

export class R2ObjectStore implements ImmutableObjectStore {
  private readonly client: S3Client

  constructor(
    private readonly config: R2Config,
    client?: S3Client,
  ) {
    this.client =
      client ??
      new S3Client({
        region: 'auto',
        endpoint: config.endpoint,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      })
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      )
      return {
        key,
        bytes: result.ContentLength ?? 0,
        contentType: result.ContentType ?? null,
        etag: cleanEtag(result.ETag),
        metadata: metadataOf(result.Metadata),
      }
    } catch (error) {
      const status = statusOf(error)
      if (status === 404 || (error as { name?: string }).name === 'NotFound') return null
      throw storageError(`Cloudflare R2 could not inspect ${key}.`, 'r2_head_failed', error)
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      )
      if (!result.Body) {
        throw new Error('R2 returned no object body.')
      }
      return Buffer.from(await result.Body.transformToByteArray())
    } catch (error) {
      throw storageError(`Cloudflare R2 could not read ${key}.`, 'r2_get_failed', error)
    }
  }

  async putImmutable(
    key: string,
    body: Buffer,
    contentType: string,
    metadata: Readonly<Record<string, string>> = {},
  ): Promise<ImmutablePutResult> {
    const digest = sha256(body)
    const storedMetadata = { ...metadata, sha256: digest }
    try {
      const result = await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
          ContentLength: body.byteLength,
          ContentType: contentType,
          ContentMD5: contentMd5(body),
          Metadata: storedMetadata,
          IfNoneMatch: '*',
        }),
      )
      return {
        key,
        bytes: body.byteLength,
        contentType,
        etag: cleanEtag(result.ETag),
        metadata: storedMetadata,
        created: true,
        sha256: digest,
      }
    } catch (error) {
      if (statusOf(error) !== 412 && (error as { name?: string }).name !== 'PreconditionFailed') {
        throw storageError(`Cloudflare R2 could not write ${key}.`, 'r2_put_failed', error)
      }

      const existing = await this.head(key)
      if (!existing) {
        throw storageError(
          `Cloudflare R2 reported an immutable collision for ${key}, but the object is missing.`,
          'r2_immutable_race',
          error,
          true,
        )
      }

      const existingDigest =
        existing.metadata.sha256 ??
        sha256(await this.get(key))
      if (existingDigest !== digest || existing.bytes !== body.byteLength) {
        throw new EnhancementError(
          `Cloudflare R2 refused to overwrite immutable object ${key} because its bytes differ.`,
          {
            stage: 'storage',
            code: 'r2_immutable_conflict',
            retryable: false,
            detail: {
              key,
              expected_sha256: digest,
              existing_sha256: existingDigest,
              expected_bytes: body.byteLength,
              existing_bytes: existing.bytes,
            },
          },
        )
      }

      return {
        ...existing,
        created: false,
        sha256: digest,
      }
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
      )
    } catch (error) {
      throw storageError(`Cloudflare R2 could not delete ${key}.`, 'r2_delete_failed', error)
    }
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0 || expiresInSeconds > 604_800) {
      throw new Error('Presigned URL expiry must be an integer from 1 to 604800 seconds.')
    }
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    )
  }

  /**
   * Short-lived browser upload for a catalogue-ready image.
   *
   * The URL authorises exactly one object key and one content type. R2 remains
   * private; no credential crosses the server boundary. Finalisation reads the
   * object back and verifies its size, format and decodability before any
   * intake/image-version row becomes visible in Loupe.
   */
  async presignPut(
    key: string,
    contentType: string,
    expiresInSeconds: number,
  ): Promise<string> {
    if (!key.trim()) throw new Error('Presigned upload key must not be empty.')
    if (!contentType.trim()) throw new Error('Presigned upload content type must not be empty.')
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0 || expiresInSeconds > 3_600) {
      throw new Error('Presigned upload expiry must be an integer from 1 to 3600 seconds.')
    }
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: expiresInSeconds },
    )
  }
}
