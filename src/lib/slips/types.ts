/** Packing slips (D146): the open-order shape the rules read, the mark each order gets, and the printed rows. */
export interface SlipAddress { name: string | null; phone: string | null; address1: string | null; address2: string | null; city: string | null; provinceCode: string | null; zip: string | null; country: string | null }
export interface SlipLine { title: string; variantTitle: string | null; sku: string | null; quantity: number; unfulfilledQuantity: number; requiresShipping: boolean; imageUrl: string | null }
export interface SlipFulfillmentOrder { id: string; status: string; holdReasons: string[] }
/** One open Shopify order as the rules see it. Read fresh on every print; never stored. */
export interface SlipOrder {
  id: string; name: string; createdAt: string; note: string | null; tags: string[]; email: string | null; phone: string | null
  financialStatus: string; fulfillmentStatus: string; total: number
  customer: { id: string | null; displayName: string | null; email: string | null; phone: string | null } | null
  shippingAddress: SlipAddress | null; billingAddress: SlipAddress | null
  fulfillmentOrders: SlipFulfillmentOrder[]; lines: SlipLine[]
}
export const MARKS = ['PACK', 'HOLD', 'CLUB', 'CLUB + HOLD'] as const
export type Mark = (typeof MARKS)[number]
export const NEED_ADDRESS = 'Need Address'
/** What the strip on the slip says, besides the mark. Stored with the printed row so a reprint shows exactly what was printed. */
export interface SlipStrip { detail: string; flags: string[]; how: string[]; heldWith: number[]; with: { number: number; status: string }[] }
export interface SlipRow { order: SlipOrder; mark: Mark; strip: SlipStrip }
export type Progress = 'marked' | 'already' | 'failed' | 'not_needed'
export interface SlipPrintRow { id: string; batch_id: string; order_id: string; order_name: string; order_number: number; mark: Mark | 'BASELINE'; strip: SlipStrip; progress: Progress; progress_error: string | null; printed_at: string }
export interface SlipBatchRow { id: string; printed_by: string; printed_at: string; order_count: number; from_number: number | null; rows: SlipPrintRow[] }
