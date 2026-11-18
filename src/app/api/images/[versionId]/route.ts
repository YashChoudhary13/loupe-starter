import { createHash } from 'node:crypto'

import { NotAuthorisedError, requireOperatorForAction } from '@/lib/auth/authorize'
import { consoleObjectStore } from '@/lib/console/images'
import { cached } from '@/lib/images/cache'
import { contentTypeFor, renderSize, type VersionKeys } from '@/lib/images/preview'
import { isImageSize } from '@/lib/images/url'
import { supabaseServer } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
type Context = { params: Promise<{ versionId: string }> }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const text = (message: string, status: number) =>
  new Response(message, {
    status,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
  })

/**
 * D165: the console's pictures. One stable URL per image version (or phone photograph, D175) and size, behind the
 * operator's session, served from the VPS disk cache and filled from R2 on the first
 * request. The bytes behind a version id never change, so the browser may keep them for
 * a year. Nothing in a response names an R2 key or carries a presigned URL.
 */
export async function GET(request: Request, context: Context) {
  try {
    await requireOperatorForAction()
  } catch (error) {
    if (error instanceof NotAuthorisedError) return text(error.message, 401)
    throw error
  }
  const { versionId } = await context.params
  const params = new URL(request.url).searchParams
  const size = params.get('size') ?? 'preview'
  const kind = params.get('kind') ?? 'version'
  if (!UUID.test(versionId) || !isImageSize(size) || (kind !== 'version' && kind !== 'phone')) return text('No such image.', 404)

  // D175: `kind=phone` names a phone photograph by its own row (`orig` in the editor, a photo's detail in Enhance).
  // It has no purge: the row and its object leave together when the batch is deleted.
  const db = supabaseServer()
  const { data: version, error } = kind === 'phone'
    ? await db.from('agent_job_photos').select('storage_key, thumb_key').eq('id', versionId).eq('status', 'uploaded').maybeSingle<VersionKeys & { purged_at?: null }>()
    : await db.from('image_versions').select('storage_key, thumb_key, purged_at').eq('id', versionId).maybeSingle<VersionKeys & { purged_at: string | null }>()
  if (error) {
    console.error(`${kind === 'phone' ? 'agent_job_photos' : 'image_versions'} read failed:`, error.message)
    return text('The image could not be read.', 502)
  }
  // A purged version (D62) has no bytes anywhere; say so without asking R2.
  if (!version || version.purged_at) return text('No such image.', 404)

  let bytes: Buffer
  try {
    bytes = await cached(`${versionId}.${size}`, () => renderSize(version, size, consoleObjectStore()))
  } catch (cause) {
    console.error(`image ${versionId} ${size} failed:`, cause instanceof Error ? cause.message : String(cause))
    return text('The image could not be read.', 502)
  }

  const etag = `"${createHash('sha1').update(bytes).digest('base64url')}"`
  const headers: Record<string, string> = {
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Content-Type': contentTypeFor(version, size),
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
  }
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
  return new Response(new Uint8Array(bytes), { headers: { ...headers, 'Content-Length': String(bytes.byteLength) } })
}
