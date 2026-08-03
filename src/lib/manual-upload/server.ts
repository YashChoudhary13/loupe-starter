import 'server-only'

import { randomUUID } from 'node:crypto'

import sharp, { type Metadata } from 'sharp'

import type { Operator } from '@/lib/auth/authorize'
import { ConsoleError } from '@/lib/console/mutations'
import { perceptualHash } from '@/lib/duplicates/phash'
import { makeThumbnail } from '@/lib/enhance/image'
import { R2ObjectStore } from '@/lib/enhance/storage'
import { serverEnv } from '@/lib/env'
import { supabaseServer } from '@/lib/supabase/server'

export const MANUAL_UPLOAD_MAX_BYTES = 50_000_000
const UPLOAD_URL_TTL_SECONDS = 15 * 60

const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const

export type ManualUploadMimeType = keyof typeof EXTENSIONS

export interface BeginManualUploadInput {
  readonly filename: string
  readonly mimeType: string
  readonly bytes: number
}

export interface ManualUploadTicket {
  readonly uploadId: string
  readonly uploadUrl: string
  readonly contentType: ManualUploadMimeType
  readonly expiresAt: number
}

interface ManualUploadRow {
  id: string
  filename: string
  mime_type: ManualUploadMimeType
  bytes: number | string
  storage_key: string
  status: 'pending' | 'completed' | 'failed'
  created_by: string
  intake_file_id: string | null
}

function objectStore(): R2ObjectStore {
  return new R2ObjectStore({
    endpoint: serverEnv.r2Endpoint,
    accessKeyId: serverEnv.r2AccessKeyId,
    secretAccessKey: serverEnv.r2SecretAccessKey,
    bucket: serverEnv.r2Bucket,
  })
}

function validatedFilename(value: string): string {
  const filename = value.trim()
  if (
    filename.length === 0 ||
    filename.length > 255 ||
    filename.includes('/') ||
    filename.includes('\\') ||
    /[\u0000-\u001f\u007f]/u.test(filename)
  ) {
    throw new ConsoleError(
      'That filename cannot be used. Rename the image with a simple filename and try again.',
      null,
      false,
    )
  }
  return filename
}

function validatedMimeType(value: string): ManualUploadMimeType {
  if (value in EXTENSIONS) return value as ManualUploadMimeType
  throw new ConsoleError(
    'Ready images must be JPEG, PNG or WebP. Export this image in one of those formats and try again.',
    `Received content type: ${value || '(missing)'}`,
    false,
  )
}

function validatedBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConsoleError('That image is empty or its size could not be read.', null, false)
  }
  if (value > MANUAL_UPLOAD_MAX_BYTES) {
    throw new ConsoleError(
      'That image is larger than 50 MB. Export a smaller copy and try again.',
      `${value} bytes exceeds the 50,000,000-byte limit.`,
      false,
    )
  }
  return value
}

function storageKey(uploadId: string, mimeType: ManualUploadMimeType): string {
  return `manual/${uploadId}/original.${EXTENSIONS[mimeType]}`
}

function thumbKey(uploadId: string): string {
  return `manual/${uploadId}/thumb.webp`
}

export async function beginManualUpload(
  operator: Operator,
  input: BeginManualUploadInput,
): Promise<ManualUploadTicket> {
  const filename = validatedFilename(input.filename)
  const mimeType = validatedMimeType(input.mimeType)
  const bytes = validatedBytes(input.bytes)
  const uploadId = randomUUID()
  const key = storageKey(uploadId, mimeType)
  const db = supabaseServer()

  const { error } = await db.from('manual_uploads').insert({
    id: uploadId,
    filename,
    mime_type: mimeType,
    bytes,
    storage_key: key,
    created_by: operator.email,
  })
  if (error) {
    throw new ConsoleError(
      'The ready-image upload could not be started. Try again.',
      error.message,
      true,
    )
  }

  try {
    const uploadUrl = await objectStore().presignPut(key, mimeType, UPLOAD_URL_TTL_SECONDS)
    return {
      uploadId,
      uploadUrl,
      contentType: mimeType,
      expiresAt: Date.now() + UPLOAD_URL_TTL_SECONDS * 1_000,
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    await db
      .from('manual_uploads')
      .update({ status: 'failed', error: message.slice(0, 2_000) })
      .eq('id', uploadId)
      .eq('status', 'pending')
    throw new ConsoleError(
      'The private upload link could not be created. Try again.',
      message,
      true,
    )
  }
}

function actualMimeType(format: string | undefined): ManualUploadMimeType | null {
  if (format === 'jpeg') return 'image/jpeg'
  if (format === 'png') return 'image/png'
  if (format === 'webp') return 'image/webp'
  return null
}

async function loadOwnedUpload(uploadId: string, operator: Operator): Promise<ManualUploadRow> {
  const { data, error } = await supabaseServer()
    .from('manual_uploads')
    .select('id, filename, mime_type, bytes, storage_key, status, created_by, intake_file_id')
    .eq('id', uploadId)
    .maybeSingle<ManualUploadRow>()
  if (error || !data) {
    throw new ConsoleError(
      'That ready-image upload no longer exists. Choose the image again.',
      error?.message ?? null,
      false,
    )
  }
  if (data.created_by !== operator.email) {
    throw new ConsoleError('That ready-image upload belongs to another operator.', null, false)
  }
  if (data.status === 'failed') {
    throw new ConsoleError('That upload already failed. Choose the image again.', null, false)
  }
  return data
}

/**
 * Verifies the browser-written object before exposing it as queue work.
 *
 * The R2 bytes stay untouched. Sharp is used only to prove the image decodes,
 * read its display dimensions, and make the small WebP queue thumbnail. The
 * selected publish version remains the photographer's exact uploaded file.
 */
export async function finalizeManualUpload(
  operator: Operator,
  uploadId: string,
): Promise<string> {
  const upload = await loadOwnedUpload(uploadId, operator)
  if (upload.status === 'completed' && upload.intake_file_id) return upload.intake_file_id

  const store = objectStore()
  const object = await store.head(upload.storage_key)
  if (!object) {
    throw new ConsoleError(
      'The image has not finished uploading. Wait a moment and try again.',
      `No object found at ${upload.storage_key}.`,
      true,
    )
  }

  const expectedBytes = Number(upload.bytes)
  if (object.bytes !== expectedBytes) {
    throw new ConsoleError(
      'The uploaded image is incomplete. Choose the image again.',
      `Expected ${expectedBytes} bytes; R2 contains ${object.bytes}.`,
      false,
    )
  }

  const original = await store.get(upload.storage_key)
  let metadata: Metadata
  try {
    metadata = await sharp(original, { failOn: 'error' }).metadata()
  } catch (cause) {
    throw new ConsoleError(
      'That file could not be opened as an image. Export it again and retry.',
      cause instanceof Error ? cause.message : String(cause),
      false,
    )
  }

  const detectedMimeType = actualMimeType(metadata.format)
  if (!detectedMimeType || detectedMimeType !== upload.mime_type) {
    throw new ConsoleError(
      'The file extension and image format do not match. Export it again and retry.',
      `Declared ${upload.mime_type}; decoded ${metadata.format ?? '(unknown)'}.`,
      false,
    )
  }

  const oriented = metadata.autoOrient ?? { width: metadata.width, height: metadata.height }
  if (!oriented.width || !oriented.height) {
    throw new ConsoleError('The image dimensions could not be read.', null, false)
  }

  const [thumbnail, phash] = await Promise.all([
    makeThumbnail(original),
    perceptualHash(original),
  ])
  const thumbnailKey = thumbKey(upload.id)
  await store.putImmutable(thumbnailKey, thumbnail, 'image/webp', {
    'manual-upload-id': upload.id,
    source: 'manual-ready-image',
  })

  const { data, error } = await supabaseServer().rpc('finalize_manual_image_upload', {
    p_upload_id: upload.id,
    p_thumb_key: thumbnailKey,
    p_width: oriented.width,
    p_height: oriented.height,
    p_phash: phash,
    p_actor: operator.email,
  })
  if (error || typeof data !== 'string') {
    throw new ConsoleError(
      'The image is safely uploaded, but it could not be added to Pending. Try again.',
      error?.message ?? 'The database returned no intake id.',
      true,
    )
  }
  return data
}
