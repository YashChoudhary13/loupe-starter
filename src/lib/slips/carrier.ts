import https from 'node:https'
import tls from 'node:tls'
import type { SlipCarrier } from './types'

/**
 * Which courier a parcel goes by, from the destination (D162). The owner's rules (2026-10-29): every Gujarat parcel
 * goes by Tirupati Courier; elsewhere whatever DTDC serves plainly goes by DTDC; a pin DTDC flags (special destination,
 * remote area) goes by Delhivery when Delhivery serves it, since Delhivery serves those better, and stays DTDC when it
 * does not; a pin DTDC does not serve goes by Delhivery when Delhivery serves it; a pin neither serves (Manipur) goes
 * by India Post Speed Post from the office. Nothing is guessed: a check that fails prints CHECK COURIER. Pure rules and
 * parsers here; the two lookups below are the only I/O.
 */
export type DtdcFlag = 'special destination' | 'remote area' | 'no B2C'
export interface DtdcVerdict { serviceable: boolean; flag: DtdcFlag | null }
/** One pin's verdict with what each checker said, kept in the print record so a courier line can be audited. */
export interface CarrierCheck { carrier: SlipCarrier | null; dtdc: 'served' | `served, ${DtdcFlag}` | 'not served' | 'no answer'; delhivery: 'served' | 'not served' | 'not asked' | 'no key' | 'no answer' }
export const DTDC_ORIGIN = '302029' // the office's DTDC pin, as dtdc_check.py asks since 2026-09-30
const DTDC_URL = 'https://www.dtdc.com/wp-json/custom/v1/dtdc-pincode/'
const DELHIVERY_URL = 'https://track.delhivery.com/c/api/pin-codes/json/?filter_codes='
const TIMEOUT_MS = 20_000
const CACHE_MS = 24 * 60 * 60 * 1000

export function chooseCarrier(dtdc: DtdcVerdict | null, delhivery: boolean | null): SlipCarrier | null {
  if (!dtdc) return null // DTDC could not be asked: nothing to decide on
  if (dtdc.serviceable && !dtdc.flag) return 'DTDC'
  if (dtdc.serviceable) return delhivery ? 'Delhivery' : 'DTDC' // flagged: Delhivery when it serves, otherwise DTDC still carries it
  if (delhivery === null) return null // Delhivery not asked (no key) or no answer
  return delhivery ? 'Delhivery' : 'Speed Post'
}
/** All Gujarat parcels go by Tirupati Courier (owner, 2026-10-29): the state code, or a pin in Gujarat's 36xxxx to 39xxxx band. */
export function gujarat(order: { shippingAddress: { provinceCode: string | null; zip: string | null } | null }): boolean {
  return (order.shippingAddress?.provinceCode ?? '').trim().toUpperCase() === 'GJ' || /^3[6-9]/.test(pinOf(order) ?? '')
}
/** Six digits or nothing. */
export function pinOf(order: { shippingAddress: { zip: string | null } | null }): string | null {
  const digits = (order.shippingAddress?.zip ?? '').replace(/\D/g, '')
  return digits.length === 6 ? digits : null
}

/** DTDC's website checker: served when a ZIPCODE_RESP row says SUCCESS with SERVFLAG Y; not served only when a row
 * says 'DESTPIN is not valid' (oddly with SERVFLAG Y, so the message is what counts); any other answer is no answer.
 * SERV_LIST carries the surcharge flags, recorded, not acted on. */
export function readDtdc(json: unknown): DtdcVerdict {
  const answer = json as { ZIPCODE_RESP?: { MESSAGE?: string; SERVFLAG?: string }[]; SERV_LIST?: Record<string, string>[] } | null
  if (!answer || !Array.isArray(answer.ZIPCODE_RESP)) throw new Error('DTDC gave an unexpected answer.')
  const flags = answer.SERV_LIST?.[0] ?? {}
  const flag: DtdcFlag | null = flags.special_Destination === 'YES' ? 'special destination' : flags.remote_Delivery_Area === 'YES' ? 'remote area' : flags.b2C_SERVICEABLE === 'NO' ? 'no B2C' : null
  if (answer.ZIPCODE_RESP.some(row => row.MESSAGE === 'SUCCESS' && row.SERVFLAG === 'Y')) return { serviceable: true, flag }
  if (answer.ZIPCODE_RESP.some(row => row.MESSAGE === 'DESTPIN is not valid')) return { serviceable: false, flag: null }
  throw new Error('DTDC gave an unexpected answer.')
}
/** Delhivery's pin-code API: served when the pin comes back with prepaid Y; an unserved pin comes back as an empty list. */
export function readDelhivery(json: unknown): boolean {
  const codes = (json as { delivery_codes?: { postal_code?: { pre_paid?: string } }[] } | null)?.delivery_codes
  if (!Array.isArray(codes)) throw new Error('Delhivery gave an unexpected answer.')
  return codes.some(code => code.postal_code?.pre_paid === 'Y')
}

/** dtdc.com sends its leaf and root but not the Go Daddy G2 intermediate, so Node's fetch fails the chain
 * (UNABLE_TO_VERIFY_LEAF_SIGNATURE, seen 2026-10-29; curl on a Mac fetches the missing link itself). When that is the
 * failure, the same request goes again over node:https with the public intermediate added to Node's roots. */
export async function dtdcCheck(pin: string): Promise<DtdcVerdict> {
  const first = await dtdcAsk(pin)
  if (first.serviceable && !first.flag) return first
  // "Not served" or a flag is what moves a parcel off DTDC, so it is never taken from one answer: DTDC is asked again and must say the same.
  const second = await dtdcAsk(pin)
  if (second.serviceable !== first.serviceable || second.flag !== first.flag) throw new Error('DTDC gave two different answers.')
  return first
}
async function dtdcAsk(pin: string): Promise<DtdcVerdict> {
  const body = JSON.stringify({ orgPincode: DTDC_ORIGIN, desPincode: pin })
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Loupe packing slips)' }
  try {
    const res = await fetch(DTDC_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`DTDC answered ${res.status}.`)
    return readDtdc(await res.json())
  } catch (error) {
    if ((error as { cause?: { code?: string } })?.cause?.code !== 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') throw error
    return readDtdc(await postWithChain(DTDC_URL, body, headers))
  }
}
function postWithChain(url: string, body: string, headers: Record<string, string>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', ca: [...tls.rootCertificates, GODADDY_G2], headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) }, timeout: TIMEOUT_MS }, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 400) return reject(new Error(`DTDC answered ${res.statusCode}.`))
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (cause) { reject(cause) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('DTDC did not answer in time.')))
    req.on('error', reject)
    req.end(body)
  })
}
/** null when there is no key to ask with. */
export async function delhiveryCheck(pin: string, key: string): Promise<boolean | null> {
  if (!key) return null
  const res = await fetch(DELHIVERY_URL + pin, { headers: { Authorization: `Token ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`Delhivery answered ${res.status}.`)
  return readDelhivery(await res.json())
}

// ponytail: in-process cache, gone on restart; a pincode table if the first print after a deploy feels slow.
const cache = new Map<string, { check: CarrierCheck; until: number }>()
const fail = (error: unknown) => { console.error('courier check:', error instanceof Error ? error.message : error) }
/** One pin's courier: DTDC first, Delhivery only when DTDC does not serve or flags the pin. Only a DTDC verdict is
 * remembered, for a day; anything that moves a parcel off DTDC is asked afresh on every print. Never throws: a failed check is a null
 * carrier, which prints as CHECK COURIER, and the reason goes to the server log. */
export function carrierLookup(delhiveryKey: string, now: () => number = Date.now): (pin: string) => Promise<CarrierCheck> {
  return async pin => {
    const hit = cache.get(pin)
    if (hit && hit.until > now()) return hit.check
    const check: CarrierCheck = { carrier: null, dtdc: 'no answer', delhivery: 'not asked' }
    let dtdc: DtdcVerdict | null = null, delhivery: boolean | null = null
    try { dtdc = await dtdcCheck(pin); check.dtdc = dtdc.serviceable ? (dtdc.flag ? `served, ${dtdc.flag}` : 'served') : 'not served' } catch (error) { fail(error) }
    if (dtdc && (!dtdc.serviceable || dtdc.flag)) {
      if (!delhiveryKey) check.delhivery = 'no key'
      else try { delhivery = await delhiveryCheck(pin, delhiveryKey); check.delhivery = delhivery ? 'served' : 'not served' } catch (error) { check.delhivery = 'no answer'; fail(error) }
    }
    check.carrier = chooseCarrier(dtdc, delhivery)
    if (check.carrier === 'DTDC') cache.set(pin, { check, until: now() + CACHE_MS })
    return check
  }
}
export const clearCarrierCache = (): void => cache.clear()
/** Each distinct pin once, a few at a time. */
export async function carriersFor(pins: readonly string[], lookup: (pin: string) => Promise<CarrierCheck>, atOnce = 6): Promise<Map<string, CarrierCheck>> {
  const unique = [...new Set(pins)], out = new Map<string, CarrierCheck>()
  for (let start = 0; start < unique.length; start += atOnce) await Promise.all(unique.slice(start, start + atOnce).map(async pin => { out.set(pin, await lookup(pin)) }))
  return out
}

/** Go Daddy Secure Certificate Authority - G2, public (certs.godaddy.com/repository/gdig2.crt.pem), valid to 2031-05-03. */
const GODADDY_G2 = `-----BEGIN CERTIFICATE-----
MIIE0DCCA7igAwIBAgIBBzANBgkqhkiG9w0BAQsFADCBgzELMAkGA1UEBhMCVVMx
EDAOBgNVBAgTB0FyaXpvbmExEzARBgNVBAcTClNjb3R0c2RhbGUxGjAYBgNVBAoT
EUdvRGFkZHkuY29tLCBJbmMuMTEwLwYDVQQDEyhHbyBEYWRkeSBSb290IENlcnRp
ZmljYXRlIEF1dGhvcml0eSAtIEcyMB4XDTExMDUwMzA3MDAwMFoXDTMxMDUwMzA3
MDAwMFowgbQxCzAJBgNVBAYTAlVTMRAwDgYDVQQIEwdBcml6b25hMRMwEQYDVQQH
EwpTY290dHNkYWxlMRowGAYDVQQKExFHb0RhZGR5LmNvbSwgSW5jLjEtMCsGA1UE
CxMkaHR0cDovL2NlcnRzLmdvZGFkZHkuY29tL3JlcG9zaXRvcnkvMTMwMQYDVQQD
EypHbyBEYWRkeSBTZWN1cmUgQ2VydGlmaWNhdGUgQXV0aG9yaXR5IC0gRzIwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC54MsQ1K92vdSTYuswZLiBCGzD
BNliF44v/z5lz4/OYuY8UhzaFkVLVat4a2ODYpDOD2lsmcgaFItMzEUz6ojcnqOv
K/6AYZ15V8TPLvQ/MDxdR/yaFrzDN5ZBUY4RS1T4KL7QjL7wMDge87Am+GZHY23e
cSZHjzhHU9FGHbTj3ADqRay9vHHZqm8A29vNMDp5T19MR/gd71vCxJ1gO7GyQ5HY
pDNO6rPWJ0+tJYqlxvTV0KaudAVkV4i1RFXULSo6Pvi4vekyCgKUZMQWOlDxSq7n
eTOvDCAHf+jfBDnCaQJsY1L6d8EbyHSHyLmTGFBUNUtpTrw700kuH9zB0lL7AgMB
AAGjggEaMIIBFjAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAdBgNV
HQ4EFgQUQMK9J47MNIMwojPX+2yz8LQsgM4wHwYDVR0jBBgwFoAUOpqFBxBnKLbv
9r0FQW4gwZTaD94wNAYIKwYBBQUHAQEEKDAmMCQGCCsGAQUFBzABhhhodHRwOi8v
b2NzcC5nb2RhZGR5LmNvbS8wNQYDVR0fBC4wLDAqoCigJoYkaHR0cDovL2NybC5n
b2RhZGR5LmNvbS9nZHJvb3QtZzIuY3JsMEYGA1UdIAQ/MD0wOwYEVR0gADAzMDEG
CCsGAQUFBwIBFiVodHRwczovL2NlcnRzLmdvZGFkZHkuY29tL3JlcG9zaXRvcnkv
MA0GCSqGSIb3DQEBCwUAA4IBAQAIfmyTEMg4uJapkEv/oV9PBO9sPpyIBslQj6Zz
91cxG7685C/b+LrTW+C05+Z5Yg4MotdqY3MxtfWoSKQ7CC2iXZDXtHwlTxFWMMS2
RJ17LJ3lXubvDGGqv+QqG+6EnriDfcFDzkSnE3ANkR/0yBOtg2DZ2HKocyQetawi
DsoXiWJYRBuriSUBAA/NxBti21G00w9RKpv0vHP8ds42pM3Z2Czqrpv1KrKQ0U11
GIo/ikGQI31bS/6kA1ibRrLDYGCD+H1QQc7CoZDDu+8CL9IVVO5EFdkKrqeKM+2x
LXY2JtwE65/3YR8V3Idv7kaWKK2hJn0KCacuBKONvPi8BDAB
-----END CERTIFICATE-----`
