import { afterEach, describe, expect, it, vi } from 'vitest'
import { carrierLookup, carriersFor, chooseCarrier, clearCarrierCache, pinOf, readDelhivery, readDtdc } from '@/lib/slips/carrier'

/** Answers captured from the two live checkers on 2026-10-29. */
const DTDC_OK = { SERV_LIST: [{ b2C_SERVICEABLE: 'YES', special_Destination: 'NO', remote_Delivery_Area: 'NO' }], ZIPCODE_RESP: [{ MESSAGE: 'SUCCESS', ORGPIN: '302029', DESTCITY: 'BANGALORE', SERVFLAG: 'Y', DESTPIN: '560068' }] }
const DTDC_SPECIAL = { SERV_LIST: [{ b2C_SERVICEABLE: 'YES', special_Destination: 'YES', remote_Delivery_Area: 'NO' }], ZIPCODE_RESP: [{ MESSAGE: 'SUCCESS', ORGPIN: '302029', DESTCITY: 'MALAPPURAM', SERVFLAG: 'Y', DESTPIN: '679340' }] }
const DTDC_NO = { ZIPCODE_RESP: [{ MESSAGE: 'DESTPIN is not valid', ORGPIN: '302029', SERVFLAG: 'Y', DESTPIN: '795010' }, { MESSAGE: 'ORGPIN is not valid', ORGPIN: '302029', SERVFLAG: 'N', DESTPIN: '795010' }] }
const DLV_YES = { delivery_codes: [{ postal_code: { pin: 796012, pre_paid: 'Y', pickup: 'Y', is_oda: 'N', district: 'Aizawl' } }] }
const DLV_NO = { delivery_codes: [] }

describe('reading the checkers', () => {
  it('DTDC: served only on a SUCCESS row with SERVFLAG Y; not served only on a DESTPIN-not-valid row; anything else is no answer', () => {
    expect(readDtdc(DTDC_OK)).toEqual({ serviceable: true, flagged: false })
    expect(readDtdc(DTDC_SPECIAL)).toEqual({ serviceable: true, flagged: true })
    expect(readDtdc({ ...DTDC_OK, SERV_LIST: [{ remote_Delivery_Area: 'YES' }] }).flagged).toBe(true)
    expect(readDtdc(DTDC_NO)).toEqual({ serviceable: false, flagged: false })
    expect(() => readDtdc({})).toThrow('unexpected'); expect(() => readDtdc(null)).toThrow('unexpected')
    expect(() => readDtdc({ ZIPCODE_RESP: [] })).toThrow('unexpected')
    expect(() => readDtdc({ ZIPCODE_RESP: [{ MESSAGE: 'ORGPIN is not valid', SERVFLAG: 'N' }] })).toThrow('unexpected')
    expect(() => readDtdc({ ZIPCODE_RESP: [{ MESSAGE: 'SUCCESS', SERVFLAG: 'N' }] })).toThrow('unexpected')
  })
  it('Delhivery: served when the pin comes back prepaid Y; an empty list is not served', () => {
    expect(readDelhivery(DLV_YES)).toBe(true); expect(readDelhivery(DLV_NO)).toBe(false)
    expect(readDelhivery({ delivery_codes: [{ postal_code: { pre_paid: 'N' } }] })).toBe(false)
    expect(() => readDelhivery({ detail: 'Invalid token' })).toThrow('unexpected')
  })
  it('a pincode is six digits, spaces and dashes ignored', () => {
    expect(pinOf({ shippingAddress: { zip: '796 012' } })).toBe('796012'); expect(pinOf({ shippingAddress: { zip: '30200' } })).toBeNull(); expect(pinOf({ shippingAddress: null })).toBeNull()
  })
})
describe("the owner's rule (2026-10-29)", () => {
  it('DTDC whenever DTDC serves, flags or not; Delhivery only when DTDC does not serve and Delhivery does; neither = Speed Post', () => {
    expect(chooseCarrier({ serviceable: true, flagged: false }, null)).toBe('DTDC')
    expect(chooseCarrier({ serviceable: true, flagged: false }, true)).toBe('DTDC')
    expect(chooseCarrier({ serviceable: true, flagged: true }, true)).toBe('DTDC')
    expect(chooseCarrier({ serviceable: true, flagged: true }, false)).toBe('DTDC')
    expect(chooseCarrier({ serviceable: false, flagged: false }, true)).toBe('Delhivery')
    expect(chooseCarrier({ serviceable: false, flagged: false }, false)).toBe('Speed Post')
  })
  it('without an answer there is no guess', () => {
    expect(chooseCarrier(null, true)).toBeNull(); expect(chooseCarrier(null, null)).toBeNull()
    expect(chooseCarrier({ serviceable: false, flagged: false }, null)).toBeNull()
  })
})
describe('the lookup', () => {
  afterEach(() => { vi.unstubAllGlobals(); clearCarrierCache() })
  const answers: Record<string, { dtdc: unknown; delhivery?: unknown }> = { '560068': { dtdc: DTDC_OK }, '679340': { dtdc: DTDC_SPECIAL, delhivery: DLV_YES }, '795010': { dtdc: DTDC_NO, delhivery: DLV_NO }, '796012': { dtdc: DTDC_NO, delhivery: DLV_YES } }
  function stubFetch() {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const pin = url.includes('dtdc') ? String(JSON.parse(String(init?.body)).desPincode) : url.split('filter_codes=')[1]
      calls.push(`${url.includes('dtdc') ? 'dtdc' : 'delhivery'}:${pin}`)
      const answer = answers[pin]
      if (!answer) return new Response('down', { status: 502 })
      return Response.json(url.includes('dtdc') ? answer.dtdc : answer.delhivery)
    })
    return calls
  }
  it('asks DTDC first; a "not served" is asked twice before Delhivery is asked; only "DTDC serves" is remembered', async () => {
    const calls = stubFetch()
    const lookup = carrierLookup('secret-token')
    expect(await lookup('560068')).toEqual({ carrier: 'DTDC', dtdc: 'served', delhivery: 'not asked' })
    expect(await lookup('679340')).toEqual({ carrier: 'DTDC', dtdc: 'served, special destination', delhivery: 'not asked' })
    expect(await lookup('795010')).toEqual({ carrier: 'Speed Post', dtdc: 'not served', delhivery: 'not served' })
    expect(await lookup('796012')).toEqual({ carrier: 'Delhivery', dtdc: 'not served', delhivery: 'served' })
    expect(calls).toEqual(['dtdc:560068', 'dtdc:679340', 'dtdc:795010', 'dtdc:795010', 'delhivery:795010', 'dtdc:796012', 'dtdc:796012', 'delhivery:796012'])
    await lookup('560068'); await lookup('796012')
    expect(calls).toHaveLength(11) // 560068 from memory; 796012 asked all over again
  })
  it('two different DTDC answers settle nothing', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    let asked = 0
    vi.stubGlobal('fetch', async () => Response.json(asked++ % 2 ? DTDC_OK : DTDC_NO))
    expect(await carrierLookup('secret-token')('111111')).toEqual({ carrier: null, dtdc: 'no answer', delhivery: 'not asked' })
    expect(asked).toBe(2); expect(quiet).toHaveBeenCalledWith('courier check:', 'DTDC gave two different answers.')
  })
  it('no Delhivery key, or a checker that is down, is unknown, never a guess, and asked again next time', async () => {
    const calls = stubFetch()
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const lookup = carrierLookup('')
    expect(await lookup('679340')).toEqual({ carrier: 'DTDC', dtdc: 'served, special destination', delhivery: 'not asked' })
    expect(await lookup('795010')).toEqual({ carrier: null, dtdc: 'not served', delhivery: 'no key' })
    expect(await lookup('999999')).toEqual({ carrier: null, dtdc: 'no answer', delhivery: 'not asked' })
    expect(await lookup('999999')).toEqual({ carrier: null, dtdc: 'no answer', delhivery: 'not asked' })
    expect(await lookup('795010')).toEqual({ carrier: null, dtdc: 'not served', delhivery: 'no key' })
    expect(calls).toEqual(['dtdc:679340', 'dtdc:795010', 'dtdc:795010', 'dtdc:999999', 'dtdc:999999', 'dtdc:795010', 'dtdc:795010'])
    expect(quiet).toHaveBeenCalledTimes(2)
  })
  it('carriersFor asks each distinct pin once, a few at a time', async () => {
    let running = 0, peak = 0
    const map = await carriersFor(['1', '2', '1', '3', '4', '5', '6', '7'], async pin => { running++; peak = Math.max(peak, running); await new Promise(done => setTimeout(done, 5)); running--; return { carrier: pin === '7' ? null : 'DTDC', dtdc: 'served', delhivery: 'not asked' } }, 3)
    expect([...map.entries()].map(([pin, check]) => [pin, check.carrier])).toEqual([['1', 'DTDC'], ['2', 'DTDC'], ['3', 'DTDC'], ['4', 'DTDC'], ['5', 'DTDC'], ['6', 'DTDC'], ['7', null]]); expect(peak).toBe(3)
  })
})
