/** Reads a request body up to `maxBytes`, refusing on a declared `content-length` before anything is read, and mid-stream once the running total is exceeded — `request.text()` alone buffers the whole body first and only checks after. Null means "too large"; an absent body reads as `''`. */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<string | null> {
  if (Number(request.headers.get('content-length') ?? '0') > maxBytes) return null
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) { await reader.cancel(); return null }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}
