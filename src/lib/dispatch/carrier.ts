import { CARRIERS, type Carrier } from './types'

export function normalizeTracking(input: string): string { return input.replace(/\s+/g, '').toUpperCase() }

/** A sentence for the operator, or null when the (already normalised) number is acceptable. */
export function trackingProblem(value: string): string | null {
  if (value.length < 6 || value.length > 30) return 'A tracking number is 6 to 30 characters.'
  if (!/^[0-9A-Z]+$/.test(value)) return 'Use letters and digits only in a tracking number.'
  return null
}

/** Owner's rules, 2026-09-21: ER → India Post; X or D → DTDC (D only "sometimes", so the select stays editable); digits → Tirupati. */
export function detectCarrier(value: string): Carrier | null {
  if (/^ER[0-9A-Z]+$/.test(value)) return 'India Post'
  if (/^[XD][0-9A-Z]+$/.test(value)) return 'DTDC'
  if (/^[0-9]+$/.test(value)) return 'Tirupati Courier'
  return null
}

export function parseCarrier(value: unknown): Carrier {
  if (typeof value === 'string' && (CARRIERS as readonly string[]).includes(value)) return value as Carrier
  throw new Error(`Choose a carrier: ${CARRIERS.join(', ')}.`)
}

/** `manual`: undefined = operator did not touch the select, '' = back to automatic, otherwise their choice. */
export function resolveCarrier(current: { carrier: Carrier | null; source: 'auto' | 'manual' } | null, tracking: string, manual: string | undefined): { carrier: Carrier | null; source: 'auto' | 'manual' } {
  if (manual) return { carrier: parseCarrier(manual), source: 'manual' }
  if (manual === undefined && current?.source === 'manual') return { carrier: current.carrier, source: 'manual' }
  return { carrier: tracking ? detectCarrier(tracking) : null, source: 'auto' }
}
