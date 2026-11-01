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

export function imageUrl(versionId: string, size: ImageSize = 'preview'): string {
  return `/api/images/${encodeURIComponent(versionId)}?size=${size}`
}
