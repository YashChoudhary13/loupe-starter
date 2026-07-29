/**
 * Reads and VALIDATES `GOOGLE_SERVICE_ACCOUNT_JSON`.
 *
 * WHY THIS EXISTS AT ALL
 *
 *   The value was originally pasted into `.env` as raw, unquoted, multi-line JSON:
 *
 *       GOOGLE_SERVICE_ACCOUNT_JSON={
 *         "type": "service_account",
 *         ...
 *
 *   dotenv terminates an unquoted value at the newline, so the variable's value was
 *   the single character `{`. Nothing complained. `process.env.GOOGLE_SERVICE_ACCOUNT_JSON`
 *   was truthy, a `required()`-style check passed, and the failure would only have
 *   surfaced in Phase 3 as an unhelpful JSON parse error inside a Drive worker — or,
 *   worse, as a worker that started, claimed a lease and then died on every file.
 *   (`source .env` in a shell fails outright on the same input, which is how it was
 *   found.)
 *
 *   Truthiness is not validity. So this module refuses to hand back a credential it
 *   has not actually looked inside, and every rejection says which of the several
 *   possible mistakes was made.
 *
 * ACCEPTED FORMS
 *
 *   1. Base64 of the JSON — the recommended form, because it is one line and cannot
 *      be broken by a newline, a quote or a `#`.
 *   2. Raw JSON on one line, or quoted so dotenv keeps the newlines.
 *
 * Phase 3 must call `googleServiceAccount()` once at worker start-up, not lazily on
 * the first file, so a bad credential fails immediately and loudly.
 */

/** The fields Loupe actually needs to sign a Drive request. */
export interface GoogleServiceAccount {
  readonly type: string
  readonly project_id: string
  readonly private_key_id: string
  readonly private_key: string
  readonly client_email: string
  readonly client_id: string
  readonly token_uri: string
}

export class ServiceAccountError extends Error {
  readonly reason:
    | 'missing'
    | 'truncated'
    | 'not_json'
    | 'not_an_object'
    | 'missing_fields'
    | 'malformed_private_key'

  constructor(reason: ServiceAccountError['reason'], message: string) {
    super(message)
    this.name = 'ServiceAccountError'
    this.reason = reason
  }
}

const REQUIRED_FIELDS = [
  'type',
  'project_id',
  'private_key_id',
  'private_key',
  'client_email',
  'client_id',
  'token_uri',
] as const

const ENV_KEY = 'GOOGLE_SERVICE_ACCOUNT_JSON'

const REPASTE_HINT =
  `Re-paste it base64-encoded on ONE line:\n` +
  `      base64 -i service-account.json | tr -d '\\n'\n` +
  `    Raw multi-line JSON does not survive dotenv — the value becomes "{".`

/** Base64 of `{"…` — how a correctly-encoded credential always begins. */
function looksLikeBase64(value: string): boolean {
  return /^[A-Za-z0-9+/\r\n\s]+={0,2}$/.test(value) && value.replace(/\s/g, '').length % 4 === 0
}

function decode(raw: string): string {
  const value = raw.trim()

  // The exact symptom of unquoted multi-line JSON in .env. Named separately
  // because "not valid JSON" would send someone looking at the wrong thing.
  if (value === '{' || value === '{}') {
    throw new ServiceAccountError(
      'truncated',
      `${ENV_KEY} is "${value}" — dotenv truncated it at the first newline, so the ` +
        `credential was never actually read.\n    ${REPASTE_HINT}`,
    )
  }

  if (value.startsWith('{')) return value

  if (looksLikeBase64(value)) {
    let decoded: string
    try {
      decoded = Buffer.from(value, 'base64').toString('utf8')
    } catch {
      throw new ServiceAccountError('not_json', `${ENV_KEY} is not decodable base64.`)
    }
    // Only reject what is not JSON *of any kind*. A decoded `[` or `"` is valid
    // JSON and belongs to the object check below, so that "you gave me an array"
    // is reported as `not_an_object` rather than as a base64 problem.
    if (!/^\s*[[{"]/.test(decoded)) {
      throw new ServiceAccountError(
        'not_json',
        `${ENV_KEY} decoded from base64 but the result is not JSON — it starts with ` +
          `"${decoded.trimStart().slice(0, 24)}…".`,
      )
    }
    return decoded
  }

  throw new ServiceAccountError(
    'not_json',
    `${ENV_KEY} is neither JSON nor base64 — it starts with "${value.slice(0, 24)}…".\n` +
      `    ${REPASTE_HINT}`,
  )
}

/**
 * Parses and validates a raw environment value. Pure, so it can be tested against
 * every way this has actually been got wrong.
 */
export function parseServiceAccountJson(raw: string | undefined | null): GoogleServiceAccount {
  if (raw === undefined || raw === null || raw.trim() === '') {
    throw new ServiceAccountError(
      'missing',
      `${ENV_KEY} is not set. Phase 3 cannot read the Drive inbox without it.`,
    )
  }

  const json = decode(raw)

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (cause) {
    throw new ServiceAccountError(
      'not_json',
      `${ENV_KEY} did not parse as JSON: ${cause instanceof Error ? cause.message : String(cause)}.\n` +
        `    ${REPASTE_HINT}`,
    )
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ServiceAccountError(
      'not_an_object',
      `${ENV_KEY} parsed as ${Array.isArray(parsed) ? 'an array' : typeof parsed}, not an object.`,
    )
  }

  const record = parsed as Record<string, unknown>
  const missing = REQUIRED_FIELDS.filter(
    (field) => typeof record[field] !== 'string' || (record[field] as string).trim() === '',
  )

  if (missing.length > 0) {
    throw new ServiceAccountError(
      'missing_fields',
      `${ENV_KEY} is valid JSON but is missing ${missing.join(', ')}. ` +
        `That is not a service-account key — download a fresh one from Google Cloud ` +
        `console → IAM & Admin → Service Accounts → Keys.`,
    )
  }

  // A private_key whose \n escapes were flattened produces a key that parses fine
  // and then fails to sign, which is a genuinely awful thing to debug at 2 a.m.
  const privateKey = record.private_key as string
  if (
    !privateKey.includes('-----BEGIN PRIVATE KEY-----') ||
    !privateKey.includes('-----END PRIVATE KEY-----') ||
    !privateKey.includes('\n')
  ) {
    throw new ServiceAccountError(
      'malformed_private_key',
      `${ENV_KEY}.private_key is not a PEM block with real newlines. It will parse and ` +
        `then fail to sign. Base64-encode the whole file rather than editing the key by hand.`,
    )
  }

  return {
    type: record.type as string,
    project_id: record.project_id as string,
    private_key_id: record.private_key_id as string,
    private_key: privateKey,
    client_email: record.client_email as string,
    client_id: record.client_id as string,
    token_uri: record.token_uri as string,
  }
}

/**
 * The validated credential from the environment.
 *
 * Call this at start-up, not on first use. A worker that boots with a broken
 * credential and dies on every file looks like a Drive problem for an hour before
 * anyone checks `.env`.
 */
export function googleServiceAccount(
  env: Record<string, string | undefined> = process.env,
): GoogleServiceAccount {
  return parseServiceAccountJson(env[ENV_KEY])
}

/**
 * Non-throwing form for status surfaces such as `/health`, where the point is to
 * SHOW that the credential is broken rather than to take the page down with it.
 */
export function checkGoogleServiceAccount(
  env: Record<string, string | undefined> = process.env,
): { ok: true; clientEmail: string; projectId: string } | { ok: false; reason: string; message: string } {
  try {
    const account = googleServiceAccount(env)
    return { ok: true, clientEmail: account.client_email, projectId: account.project_id }
  } catch (error) {
    if (error instanceof ServiceAccountError) {
      return { ok: false, reason: error.reason, message: error.message }
    }
    return { ok: false, reason: 'unknown', message: String(error) }
  }
}
