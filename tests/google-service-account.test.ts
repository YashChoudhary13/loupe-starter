/**
 * `GOOGLE_SERVICE_ACCOUNT_JSON` must fail loudly, not silently.
 *
 * The value in `.env` was raw unquoted multi-line JSON, which dotenv truncates at
 * the first newline — so the variable's value was the single character `{`. Every
 * truthiness check passed. Phase 3 would have discovered it as a parse error inside
 * a Drive worker, or as a worker that claimed a lease and died on every file.
 *
 * Each test below is a way this has been or could be got wrong, and asserts that the
 * error names THAT mistake rather than a generic one. A validator that rejects
 * everything with "invalid credential" is barely better than the silent failure.
 */
import { describe, expect, it } from 'vitest'

import {
  ServiceAccountError,
  checkGoogleServiceAccount,
  googleServiceAccount,
  parseServiceAccountJson,
} from '@/lib/google/service-account'

const PRIVATE_KEY =
  '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQ\n-----END PRIVATE KEY-----\n'

const VALID = {
  type: 'service_account',
  project_id: 'qimati-loupe',
  private_key_id: '8a8b9ee7264ed4e4cbb98a758d5f35eaefd26f64',
  private_key: PRIVATE_KEY,
  client_email: 'loupe-drive@qimati-loupe.iam.gserviceaccount.com',
  client_id: '112288105908534251679',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  universe_domain: 'googleapis.com',
}

const RAW_JSON = JSON.stringify(VALID)
const BASE64 = Buffer.from(RAW_JSON, 'utf8').toString('base64')

function reasonOf(raw: string | undefined): string {
  try {
    parseServiceAccountJson(raw)
    return 'no error'
  } catch (error) {
    return error instanceof ServiceAccountError ? error.reason : 'not a ServiceAccountError'
  }
}

describe('parseServiceAccountJson — accepted forms', () => {
  it('accepts base64 on one line, the recommended form', () => {
    const account = parseServiceAccountJson(BASE64)
    expect(account.client_email).toBe(VALID.client_email)
    expect(account.project_id).toBe('qimati-loupe')
    expect(account.private_key).toContain('BEGIN PRIVATE KEY')
  })

  it('accepts base64 with surrounding whitespace or wrapped lines', () => {
    const wrapped = (BASE64.match(/.{1,64}/g) ?? []).join('\n')
    expect(parseServiceAccountJson(`  ${wrapped}  `).client_email).toBe(VALID.client_email)
  })

  it('accepts raw JSON that survived intact — quoted in .env, or single-line', () => {
    expect(parseServiceAccountJson(RAW_JSON).client_email).toBe(VALID.client_email)
    expect(parseServiceAccountJson(JSON.stringify(VALID, null, 2)).client_email).toBe(
      VALID.client_email,
    )
  })

  it('returns only the fields Loupe needs, not the whole blob', () => {
    const account = parseServiceAccountJson(BASE64)
    expect(Object.keys(account).sort()).toEqual([
      'client_email',
      'client_id',
      'private_key',
      'private_key_id',
      'project_id',
      'token_uri',
      'type',
    ])
  })
})

describe('parseServiceAccountJson — the failures, each named', () => {
  it('THE ACTUAL BUG: dotenv truncated multi-line JSON to "{"', () => {
    expect(reasonOf('{')).toBe('truncated')
    // The message has to say what happened and what to do, not "invalid JSON".
    expect(() => parseServiceAccountJson('{')).toThrow(/truncated it at the first newline/)
    expect(() => parseServiceAccountJson('{')).toThrow(/base64/)
  })

  it('rejects unset, empty and whitespace-only', () => {
    expect(reasonOf(undefined)).toBe('missing')
    expect(reasonOf('')).toBe('missing')
    expect(reasonOf('   \n  ')).toBe('missing')
    expect(reasonOf(null as unknown as undefined)).toBe('missing')
  })

  it('rejects a value that is neither JSON nor base64', () => {
    expect(reasonOf('/Users/yash/keys/service-account.json')).toBe('not_json')
    expect(() => parseServiceAccountJson('~/keys/sa.json')).toThrow(/neither JSON nor base64/)
  })

  it('rejects base64 that decodes to something other than JSON', () => {
    expect(reasonOf(Buffer.from('not json at all', 'utf8').toString('base64'))).toBe('not_json')
  })

  it('rejects JSON that is truncated mid-document', () => {
    expect(reasonOf(RAW_JSON.slice(0, RAW_JSON.length - 30))).toBe('not_json')
  })

  it('rejects valid JSON that is not an object', () => {
    expect(reasonOf(Buffer.from('[1,2,3]', 'utf8').toString('base64'))).toBe('not_an_object')
    expect(reasonOf(Buffer.from('"a string"', 'utf8').toString('base64'))).toBe('not_an_object')
  })

  it('rejects an OAuth client secret pasted in by mistake — valid JSON, wrong file', () => {
    // A genuinely likely mistake: both files are downloaded from the same console.
    const oauthClient = JSON.stringify({
      installed: { client_id: 'x.apps.googleusercontent.com', client_secret: 'y' },
    })
    expect(reasonOf(Buffer.from(oauthClient, 'utf8').toString('base64'))).toBe('missing_fields')
  })

  it('names every missing field, so one round trip fixes it', () => {
    const rest: Record<string, unknown> = { ...VALID }
    delete rest.private_key
    delete rest.client_email

    const error = (() => {
      try {
        parseServiceAccountJson(Buffer.from(JSON.stringify(rest), 'utf8').toString('base64'))
        return null
      } catch (e) {
        return e as ServiceAccountError
      }
    })()

    expect(error?.reason).toBe('missing_fields')
    expect(error?.message).toMatch(/private_key/)
    expect(error?.message).toMatch(/client_email/)
  })

  it('rejects a present-but-empty client_email', () => {
    expect(reasonOf(Buffer.from(JSON.stringify({ ...VALID, client_email: '   ' })).toString('base64'))).toBe(
      'missing_fields',
    )
  })

  it('rejects a private_key whose newlines were flattened', () => {
    // Parses fine, then fails to sign. The worst kind: it looks correct.
    const flattened = { ...VALID, private_key: PRIVATE_KEY.replace(/\n/g, '') }
    expect(reasonOf(Buffer.from(JSON.stringify(flattened), 'utf8').toString('base64'))).toBe(
      'malformed_private_key',
    )
  })

  it('rejects a private_key that is not a PEM block at all', () => {
    const notPem = { ...VALID, private_key: 'MIIEvgIBADANBgkqhkiG9w0BAQEF\nAASCBKgwggSk\n' }
    expect(reasonOf(Buffer.from(JSON.stringify(notPem), 'utf8').toString('base64'))).toBe(
      'malformed_private_key',
    )
  })
})

describe('googleServiceAccount / checkGoogleServiceAccount', () => {
  it('reads the variable from the environment it is given', () => {
    expect(googleServiceAccount({ GOOGLE_SERVICE_ACCOUNT_JSON: BASE64 }).client_email).toBe(
      VALID.client_email,
    )
  })

  it('check…() reports instead of throwing, for /health', () => {
    expect(checkGoogleServiceAccount({ GOOGLE_SERVICE_ACCOUNT_JSON: BASE64 })).toEqual({
      ok: true,
      clientEmail: VALID.client_email,
      projectId: 'qimati-loupe',
    })

    const broken = checkGoogleServiceAccount({ GOOGLE_SERVICE_ACCOUNT_JSON: '{' })
    expect(broken.ok).toBe(false)
    expect(broken).toMatchObject({ reason: 'truncated' })
  })

  it('never puts the private key in a message that might get logged', () => {
    const flattened = { ...VALID, private_key: PRIVATE_KEY.replace(/\n/g, '') }
    const result = checkGoogleServiceAccount({
      GOOGLE_SERVICE_ACCOUNT_JSON: Buffer.from(JSON.stringify(flattened)).toString('base64'),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).not.toContain('MIIEvgIBADANBgkq')
  })
})
