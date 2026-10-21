import type { LabelVariant } from './catalogue'

/**
 * D157: product labels as TSPL2, the TSC TE244's own language, so the office label printer prints them exactly as
 * written with no driver, paper size or scaling in between. One block per variant; copies ride on PRINT 1,n.
 * 38 x 25 mm label at 203 dpi = 304 x 200 dots, 3 mm (24 dot) margins so a millimetre of feed drift never clips anything:
 * QR on the left (cell 4 = 0.5 mm modules, the size the browser sheet uses), product, option and code on the right.
 */
export const LABEL_MM = { width: 38, height: 25 } as const
/** Gap between labels on the roll: the usual 3 mm for 38 x 25 rolls (2 mm printed 1 mm high on 2026-10-21). ponytail: constant; make it a setting if a different roll ever misaligns. */
const GAP_MM = 3
/** The code in the largest built-in font that fits the right column (144 dots): font 3 is 16 dots wide, 2 is 12, 1 is 8. */
function codeLines(code: string): string[] {
  if (code.length <= 9) return [`TEXT 136,112,"3",0,1,1,"${code}"`]
  if (code.length <= 12) return [`TEXT 136,112,"2",0,1,1,"${code}"`]
  return [`TEXT 136,112,"1",0,1,1,"${code.slice(0, 18)}"`, ...(code.length > 18 ? [`TEXT 136,126,"1",0,1,1,"${code.slice(18)}"`] : [])]
}

/** TSPL strings sit in double quotes and the printer's fonts are ASCII: drop quotes, backslashes, control and non-ASCII characters. */
export function tsplText(value: string, max: number): string {
  return value.replace(/["\\]/g, '').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim().slice(0, max)
}

export interface LabelCopies { readonly id: string; readonly copies: number }

export function renderLabelTspl(items: readonly LabelCopies[], variants: readonly LabelVariant[]): { tspl: string; labels: number } {
  const blocks: string[] = []
  let labels = 0
  for (const item of items) {
    if (item.copies < 1) continue
    const variant = variants.find(v => v.id === item.id)
    if (!variant?.barcode) throw new Error('A selected item has no saved Shopify barcode.')
    const code = tsplText(variant.barcode, 24)
    if (!/^[\x21-\x7e]{1,24}$/.test(code)) throw new Error(`${variant.barcode} cannot go on a label: use 1–24 printable characters without spaces.`)
    const option = variant.title === 'Default Title' ? 'QIMATI' : variant.title
    blocks.push([
      'CLS',
      `QRCODE 24,56,M,4,A,0,"${code}"`,
      `TEXT 136,56,"1",0,1,1,"${tsplText(variant.product.title.toUpperCase(), 18)}"`,
      `TEXT 136,78,"2",0,1,1,"${tsplText(option, 12)}"`,
      ...codeLines(code),
      `PRINT 1,${Math.min(500, Math.trunc(item.copies))}`,
    ].join('\n'))
    labels += Math.min(500, Math.trunc(item.copies))
  }
  if (!blocks.length) throw new Error('No labels selected.')
  const head = [`SIZE ${LABEL_MM.width} mm,${LABEL_MM.height} mm`, `GAP ${GAP_MM} mm,0 mm`, 'DIRECTION 1,0', 'REFERENCE 0,0', 'DENSITY 8', 'SPEED 3', 'SET TEAR ON']
  return { tspl: [...head, ...blocks].join('\n') + '\n', labels }
}
