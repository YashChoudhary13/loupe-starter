import { describe, expect, it } from 'vitest'
import { detectCarrier, normalizeTracking, parseCarrier, resolveCarrier, trackingProblem } from '@/lib/dispatch/carrier'

describe('tracking numbers', () => {
  it('normalises spaces and case', () => { expect(normalizeTracking('  x12 345 678a ')).toBe('X12345678A') })
  it('accepts 6 to 30 letters and digits only', () => {
    expect(trackingProblem('X1234')).toMatch(/6 to 30/)
    expect(trackingProblem('X'.repeat(31))).toMatch(/6 to 30/)
    expect(trackingProblem('X1234-567')).toMatch(/letters and digits/)
    expect(trackingProblem('X1234567')).toBeNull()
  })
})
describe('carrier detection', () => {
  it.each([['X1234567890', 'DTDC'], ['D9876543210', 'DTDC'], ['ER123456789IN', 'India Post'], ['884512209', 'Tirupati Courier']])('%s is %s', (value, carrier) => { expect(detectCarrier(value)).toBe(carrier) })
  it('leaves anything else to the operator', () => { expect(detectCarrier('AB12345678')).toBeNull(); expect(detectCarrier('E12345678')).toBeNull() })
  it('rejects a carrier that is not one of the three', () => { expect(() => parseCarrier('BlueDart')).toThrow(/carrier/i); expect(parseCarrier('India Post')).toBe('India Post') })
})
describe('carrier resolution while staging', () => {
  it('an explicit choice wins and is remembered as manual', () => { expect(resolveCarrier({ carrier: 'DTDC', source: 'auto' }, '884512209', 'India Post')).toEqual({ carrier: 'India Post', source: 'manual' }) })
  it('a manual choice survives an edit to the number', () => { expect(resolveCarrier({ carrier: 'India Post', source: 'manual' }, 'X1234567', undefined)).toEqual({ carrier: 'India Post', source: 'manual' }) })
  it('an empty choice returns the row to detection', () => { expect(resolveCarrier({ carrier: 'India Post', source: 'manual' }, 'X1234567', '')).toEqual({ carrier: 'DTDC', source: 'auto' }) })
  it('detects when nothing was chosen, and clears with the number', () => {
    expect(resolveCarrier(null, 'ER123456789IN', undefined)).toEqual({ carrier: 'India Post', source: 'auto' })
    expect(resolveCarrier({ carrier: 'DTDC', source: 'auto' }, '', undefined)).toEqual({ carrier: null, source: 'auto' })
  })
})
