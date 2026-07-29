import { createHash, timingSafeEqual } from 'node:crypto'

function safeEqual(candidate: string, expected: string): boolean {
  // Hashing gives timingSafeEqual two fixed-length inputs even when a caller
  // supplies a secret of the wrong length.
  const candidateDigest = createHash('sha256').update(candidate, 'utf8').digest()
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(candidateDigest, expectedDigest)
}

function bearerToken(header: string | null): string | null {
  if (!header) return null
  const match = /^Bearer[ \t]+(.+)$/i.exec(header)
  return match?.[1] ?? null
}

/**
 * Accepts Vercel's bearer form and the database scheduler's x-cron-secret form.
 * Either may authenticate; missing configuration and missing/wrong headers all
 * fail closed.
 */
export function isCronAuthorized(request: Request, expectedSecret: string): boolean {
  if (!expectedSecret) return false

  const candidates = [
    bearerToken(request.headers.get('authorization')),
    request.headers.get('x-cron-secret'),
  ].filter((candidate): candidate is string => candidate !== null)

  return candidates.some((candidate) => safeEqual(candidate, expectedSecret))
}
