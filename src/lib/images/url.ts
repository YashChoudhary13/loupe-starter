/**
 * Where the console gets its pictures (D165): Loupe's own route, one stable URL per
 * image version and size, so the browser keeps it for good. The route checks the
 * operator's session and serves from the VPS disk cache, filled from R2 once.
 * Pure on purpose — client components build these URLs too.
 */
export const IMAGE_SIZES = ['thumb', 'preview', 'full'] as const
export type ImageSize = (typeof IMAGE_SIZES)[number]

export function isImageSize(value: unknown): value is ImageSize {
  return typeof value === 'string' && (IMAGE_SIZES as readonly string[]).includes(value)
}

/** `phone` (D175): the phone photograph a render was made from, an `agent_job_photos` row. */
export type ImageKind = 'version' | 'phone'

export function imageUrl(id: string, size: ImageSize = 'preview', kind: ImageKind = 'version'): string {
  return `/api/images/${encodeURIComponent(id)}?size=${size}${kind === 'phone' ? '&kind=phone' : ''}`
}
