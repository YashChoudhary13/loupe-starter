import { MISSING, lines, num } from './plan'
import { NEED_ADDRESS, type SlipAddress, type SlipOrder, type SlipPrintRow, type SlipStrip } from './types'

/** The slip document: one packing slip per order in the layout of Shopify's own slip, a slim mark strip on top, designed
 * for a black-and-white printer. The browser prints it (Ctrl+P or the auto dialog); no file is written anywhere.
 * `@page { margin: 0 }` with the margins as padding on each slip: Chrome draws its date/title/URL/page-number lines inside
 * the page margin, so a zero margin is the only way to keep them off the paper whatever the dialog says (seen 2026-10-10). */
const SHOP_FOOT = ['Qimati', 'Acharya Kriplani Marg, Adarsh Nagar, Jaipur., 302, A-6, SV Tower, 302004 Jaipur RJ, India', 'info@qimati.in', 'www.qimati.in']
const CLS: Record<string, string> = { PACK: 'PACK', HOLD: 'HOLD', CLUB: 'CLUB', 'CLUB + HOLD': 'CLUBHOLD' }
export const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
const ist = (iso: string) => new Date(iso)
const fmtDate = (iso: string) => ist(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'Asia/Kolkata' })
export const fmtWhen = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })

/** Strip on the slip: PACK, HOLD, CLUB or CLUB + HOLD; CLUB kinds add → and the orders to club with, status under each.
 * Need Address sits at the right end; every other flag stays off the strip (owner, 2026-10-05 and 2026-10-07). */
export function strip(mark: string, strip: SlipStrip): string {
  const orders = strip.with.map(other => `<div class=w><b>${other.number}</b><small>${esc(other.status)}</small></div>`).join('')
  const flag = strip.flags.includes(NEED_ADDRESS) ? `<em>${NEED_ADDRESS}</em>` : ''
  return `<b>${esc(mark)}</b>${orders ? `<i>→</i>${orders}` : ''}${flag}`
}
function address(a: SlipAddress | null, phone = true): string {
  const place = [a?.zip, a?.city, a?.provinceCode].filter(Boolean).join(' ')
  const rows = [a?.name, a?.address1, a?.address2, place, a?.country, ...(phone ? [a?.phone] : [])].filter(Boolean)
  return rows.map(row => `<div>${esc(row)}</div>`).join('') || `<div>${MISSING}</div>`
}
export function slip(row: SlipPrintRow, order: SlipOrder | undefined): string {
  if (!order) return `<section class="slip PACK"><div class=mark><b>${esc(row.mark)}</b></div><header><div class=shop>QIMATI</div><div class=right><div>Order ${esc(row.order_name)}</div></div></header><p>Shopify could not return this order, so its slip could not be rendered. Open it in Shopify.</p></section>`
  const items = lines(order).map(line => {
    const variant = line.variantTitle && line.variantTitle !== 'Default Title' ? `<div>${esc(line.variantTitle)}</div>` : ''
    return `<tr><td class=pic>${line.imageUrl ? `<img src="${esc(line.imageUrl)}" alt="" loading="eager">` : '<i></i>'}</td><td><div>${esc(line.title)}</div>${variant}<div>${esc(line.sku || MISSING)}</div></td><td class=q>${line.unfulfilledQuantity} of ${line.quantity}</td></tr>`
  }).join('')
  const note = (order.note ?? '').split(/\s+/).filter(Boolean).join(' ')
  return `<section class="slip ${CLS[row.mark] ?? 'PACK'}" data-order="${esc(order.name)}"><div class=mark>${strip(row.mark, row.strip)}</div>
<header><div class=shop>QIMATI</div><div class=right><div>Order ${esc(order.name)}</div><div>${esc(fmtDate(order.createdAt))}</div></div></header>
<div class=cols><div><h6>Ship to</h6>${address(order.shippingAddress)}</div><div><h6>Bill to</h6>${address(order.billingAddress, false)}</div></div>
<table><thead><tr><th colspan=2>Items</th><th class=q>Quantity</th></tr></thead><tbody>${items}</tbody></table>${note ? `<div class=notes><h6>Notes</h6><div>${esc(note)}</div></div>` : ''}
<footer><p>Thank you for shopping with us!</p>${SHOP_FOOT.map(text => `<div>${esc(text)}</div>`).join('')}</footer></section>`
}

export interface SlipDocument { rows: readonly SlipPrintRow[]; orders: readonly SlipOrder[]; title: string; printedBy: string; printedAt: string; auto: boolean; backHref: string }
export function renderSlipDocument(doc: SlipDocument): string {
  const byId = new Map(doc.orders.map(order => [order.id, order]))
  const rows = doc.rows.filter(row => row.mark !== 'BASELINE').sort((a, b) => a.order_number - b.order_number)
  const slips = rows.map(row => slip(row, byId.get(row.order_id))).join('')
  const missing = rows.filter(row => !byId.has(row.order_id)).map(row => row.order_name)
  const failed = rows.filter(row => row.progress === 'failed').map(row => row.order_name)
  const first = rows[0] ? num(rows[0].order_name) : 0, last = rows.length ? num(rows[rows.length - 1].order_name) : 0
  const summary = `${rows.length} slip${rows.length === 1 ? '' : 's'}${rows.length ? ` · Qimati${first} to Qimati${last}` : ''} · printed ${esc(fmtWhen(doc.printedAt))} IST by ${esc(doc.printedBy)}`
  const warnings = [
    ...(failed.length ? [`Not marked In progress in Shopify (mark by hand or use Retry on the Print slips page): ${failed.join(', ')}`] : []),
    ...(missing.length ? [`Could not be read from Shopify: ${missing.join(', ')}`] : []),
  ].map(text => `<p class=warn>${esc(text)}</p>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(doc.title)}</title><style>
@page{size:A4;margin:0}
body{font:10px/1.45 "Helvetica Neue",Helvetica,Arial,sans-serif;color:#000;margin:0;background:#fff}
.toolbar{font-size:14px;line-height:1.5;padding:16px 20px;max-width:760px;margin:auto}.toolbar h1{font-size:18px;margin:0 0 6px}.toolbar button{background:#111;color:#fff;border:0;border-radius:999px;padding:10px 22px;cursor:pointer;font:inherit}.toolbar a{color:#111;margin-left:14px}.warn{color:#a8302a;font-weight:600}
.slip{break-after:page}.slip:last-child{break-after:auto}
.mark{display:flex;align-items:center;gap:14px;padding:4px 10px;border:2px solid #000;border-radius:3px;background:#fff;color:#000;margin-bottom:9mm;-webkit-print-color-adjust:exact;print-color-adjust:exact}.mark>b{font-size:13px;letter-spacing:.05em;white-space:nowrap}.mark i{font-style:normal;font-size:14px}
.w{display:flex;flex-direction:column;line-height:1.15}.w b{font-size:12px}.w small{font-size:8px;text-transform:uppercase;letter-spacing:.03em}
.mark em{margin-left:auto;font-style:normal;font-weight:700;font-size:12px;white-space:nowrap;padding:1px 7px;border:1.5px solid currentColor;border-radius:3px}
.PACK .mark{border-color:#b5b5b5;color:#555}.PACK .mark>b{font-size:11px}.PACK .mark em{color:#000}.HOLD .mark,.CLUBHOLD .mark{background:#000;color:#fff}
header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:9mm}.shop{font-size:19px;letter-spacing:.02em}.right{text-align:right}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:7mm}h6{margin:0 0 7px;font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em}
table{width:100%;border-collapse:collapse;border-top:2px solid #000;border-bottom:2px solid #000}
th{font-size:8.5px;text-transform:uppercase;letter-spacing:.03em;text-align:left;padding:14px 0 10px}th.q,td.q{text-align:right;white-space:nowrap}
td{padding:6px 0;vertical-align:middle}td.pic{width:58px}td.pic img,td.pic i{display:block;width:48px;height:48px;object-fit:cover;background:#eee}
tr{break-inside:avoid}.notes{margin-top:7mm}footer{text-align:center;margin-top:9mm}footer p{margin:0 0 10px}
@media screen{body{background:#e9e7e3}.slip{background:#fff;max-width:150mm;margin:16px auto;padding:10mm 30mm 14mm;box-shadow:0 1px 4px rgba(0,0,0,.15)}}
@media print{.toolbar{display:none}.slip{padding:10mm 30mm 14mm;box-sizing:border-box}}
</style></head><body><div class="toolbar"><h1>Qimati packing slips</h1><p>${summary}</p>${warnings}<p>A4, 100% scale, browser headers and footers off. <button type="button" onclick="window.print()">Print</button><a href="${esc(doc.backHref)}">Back to Print slips</a></p></div>
<main>${slips}</main>${doc.auto && rows.length ? '<script>(function(){var done=false;function go(){if(done)return;done=true;setTimeout(function(){window.print()},300)}window.addEventListener("load",go);setTimeout(go,15000)})()</script>' : ''}</body></html>`
}
