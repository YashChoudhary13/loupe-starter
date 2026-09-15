import { createHash } from 'node:crypto'
import type { QcOrder } from './types'

/** Ignore prices/notes, but invalidate changed units, options, codes or cancellation. */
export function orderFingerprint(order: QcOrder): string {
  return createHash('sha256').update(JSON.stringify({
    id: order.id, cancelledAt: order.cancelledAt, blockedReason: order.blockedReason,
    lines: [...order.lines].sort((a, b) => a.id.localeCompare(b.id)).map(line => ({
      id: line.id, variant: line.variantId, required: line.required,
      sku: line.sku, barcode: line.barcode, title: line.title, option: line.variantTitle,
    })),
  })).digest('hex')
}
