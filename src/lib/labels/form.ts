import { parseLabelRequest, type LabelRequest } from './print'

/** Reads the label selection form (urlencoded, capped) the Labels screen and the console popup both send. */
export async function readLabelForm(request: Request): Promise<LabelRequest | Response> {
  if (Number(request.headers.get('content-length') ?? '0') > 32000) return new Response('Print selection too large.', { status: 413 })
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded') return new Response('Use the label selection form.', { status: 415 })
  const reader = request.body?.getReader()
  if (!reader) return new Response('No labels selected.', { status: 400 })
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > 32000) { await reader.cancel(); return new Response('Print selection too large.', { status: 413 }) }
    chunks.push(value)
  }
  const form = new FormData()
  for (const [key, value] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) form.append(key, value)
  return parseLabelRequest(form)
}
