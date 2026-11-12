import type { QcShortage, QcView } from './types'

/**
 * Order QC → WhatsApp bot (D168). When a checklist passes with units accepted as short, the bot sends the fixed
 * staff number the same Create / Cancel offer as the staff command `missing <order> <item> [qty]`; the coupon is
 * made only on Create, by the bot. Loupe sends the order number and the pieces, never money and never a customer.
 * Off (null) until BOT_MISSING_WEBHOOK_URL and BOT_WEBHOOK_SECRET are set.
 */
export interface MissingItem { code: string; qty: number }

/** One entry per line still open as short: the SKU, plus the option words so a shared (legacy) SKU still names one line. */
export function missingItems(shortages: readonly QcShortage[]): { items: MissingItem[]; skipped: number } {
  const byCode = new Map<string, number>()
  let skipped = 0
  for (const shortage of shortages) {
    if (shortage.resolved_at) continue
    if (!shortage.sku) { skipped++; continue }
    const code = `${shortage.sku} ${shortage.variant_title ?? ''}`.trim()
    byCode.set(code, (byCode.get(code) ?? 0) + shortage.quantity)
  }
  return { items: [...byCode].map(([code, qty]) => ({ code, qty })), skipped }
}

type Post = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>
const FAILED = 'The WhatsApp bot did not take the missing pieces. Open Shortages and press Send to WhatsApp.'

/** A sentence for the operator, or null when there is nothing to send or the bot door is not configured. Never throws. */
export async function notifyMissing(orderName: string, shortages: readonly QcShortage[], by: string, env: Record<string, string | undefined> = process.env, post: Post = fetch): Promise<string | null> {
  const { items, skipped } = missingItems(shortages)
  const url = env.BOT_MISSING_WEBHOOK_URL?.trim(), secret = env.BOT_WEBHOOK_SECRET?.trim()
  const order = orderName.replace(/\D/g, '')
  if (!url || !/^https:\/\//.test(url) || !secret) return null
  if (!items.length || !order) return skipped ? `${skipped} missing line(s) have no SKU; make their coupon by hand.` : null
  try {
    // The bot takes at most 20 pieces per order, the same as the typed command.
    const response = await post(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ order, by: by.slice(0, 60), items: items.slice(0, 20) }), signal: AbortSignal.timeout(8000) })
    if (!response.ok) { console.warn('bot missing webhook answered', response.status); return FAILED }
    const left = items.length > 20 ? ` ${items.length - 20} more line(s) did not fit; send those by hand.` : ''
    return `Missing pieces of ${orderName} sent to WhatsApp: press Create there for the coupon and the apology link.${left}${skipped ? ` ${skipped} line(s) have no SKU; make their coupon by hand.` : ''}`
  } catch (error) {
    console.warn('bot missing webhook failed:', error instanceof Error ? error.message : error)
    return FAILED
  }
}

/** After a `complete` that passed just now (not a replay): tell the bot, and put what happened on the view. */
export async function withMissingNotice(view: QcView, action: string | undefined): Promise<QcView> {
  if (action !== 'complete' || view.event?.outcome !== 'passed' || view.replayed || !view.shortages.length) return view
  const notice = await notifyMissing(view.session.snapshot.name ?? view.order.name, view.shortages, view.event.actor_name)
  return notice ? { ...view, botNotice: notice } : view
}
