import bwipjs from 'bwip-js/node'
import type { LabelVariant } from './catalogue'

export interface LabelRequest {
  readonly symbology: 'qr' | 'code128'
  readonly width: number
  readonly height: number
  readonly items: readonly { readonly id: string; readonly copies: number }[]
}

export function parseLabelRequest(form: FormData): LabelRequest {
  const symbology = form.get('symbology')
  if (symbology !== 'qr' && symbology !== 'code128') throw new Error('Choose QR or Code 128 labels.')
  const width = Number(form.get('width'))
  const height = Number(form.get('height'))
  if (!Number.isInteger(width) || width < 30 || width > 100 || !Number.isInteger(height) || height < 25 || height > 70) {
    throw new Error('Choose a label width of 30–100 mm and height of 25–70 mm.')
  }
  const items: { id: string; copies: number }[] = []
  const seen = new Set<string>()
  for (const [key, value] of form) {
    if (!key.startsWith('copies:')) continue
    const id = key.slice(7)
    const copies = Number(value)
    if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id) || typeof value !== 'string' || value.trim() === '' || !Number.isInteger(copies) || copies < 0 || copies > 500 || seen.has(id)) {
      throw new Error('Each selected variant needs a whole number of copies from 0 to 500.')
    }
    seen.add(id)
    if (copies > 0) items.push({ id, copies })
  }
  if (!items.length || items.length > 100 || items.reduce((n, v) => n + v.copies, 0) > 2000) {
    throw new Error('Select 1–100 variants and no more than 2,000 labels per print run.')
  }
  return { symbology, width, height, items }
}

export function escapeLabelText(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export function barcodeSvg(code: string, availableWidthMm: number): string {
  // Limit printable Code 128 input and forbid the library's special escape syntax.
  if (!/^[\x21-\x7e]{1,64}$/.test(code) || code.includes('^')) throw new Error('This barcode cannot be printed as a product label. Use 1–64 printable characters without spaces or ^.')
  const svg = bwipjs.toSVG({ bcid: 'code128', text: code, scale: 1, height: 9, includetext: false }).replace('<svg ', '<svg preserveAspectRatio="none" ')
  const modules = Number(/viewBox="0 0 (\d+) /.exec(svg)?.[1])
  // 3 dots/module at 300 dpi, plus ten-module quiet zones on each side.
  if (!modules || (modules + 20) * 0.254 > availableWidthMm) {
    throw new Error(`Label too narrow for ${code}. Choose a width of at least ${Math.ceil((modules + 20) * 0.254 + 4)} mm.`)
  }
  return `<div class="symbol" style="width:${(modules + 20) * 0.254}mm;padding:0 2.54mm"><img alt="Barcode ${escapeLabelText(code)}" src="data:image/svg+xml,${encodeURIComponent(svg)}"></div>`
}

export function qrSvg(code: string, width: number, height: number): string {
  if (!/^[\x21-\x7e]{1,64}$/.test(code) || code.includes('^')) throw new Error('Use a barcode of 1–64 printable characters without spaces or ^.')
  // The upstream generic type omits encoder-specific options such as eclevel.
  const options = { bcid: 'qrcode', text: code, eclevel: 'M', scale: 1 }
  const svg = bwipjs.toSVG(options)
  // BWIPP QR uses two drawing units per module at scale 1. Print modules at
  // 0.5 mm with the required four-module (2 mm) clear border on every side.
  const modules = Number(/viewBox="0 0 (\d+) /.exec(svg)?.[1]) / 2
  const size = (modules + 8) * 0.5
  if (!modules || size > height - 4 || size + 14 > width - 4) throw new Error('This code needs a larger label. Increase the width or height before printing.')
  return `<div class="qr-symbol" style="width:${size}mm;height:${size}mm;padding:2mm"><img alt="QR ${escapeLabelText(code)}" src="data:image/svg+xml,${encodeURIComponent(svg)}"></div>`
}

export function renderLabelDocument(request: LabelRequest, variants: readonly LabelVariant[]): string {
  const labels = request.items.flatMap(item => {
    const variant = variants.find(v => v.id === item.id)
    if (!variant?.barcode) throw new Error('A selected item has no saved Shopify barcode.')
    const name = `<div class="name">${escapeLabelText(variant.product.title)}</div>`
    const option = `<div class="variant">${escapeLabelText(variant.title === 'Default Title' ? 'QIMATI' : variant.title)}</div>`
    const code = `<div class="code">${escapeLabelText(variant.barcode)}</div>`
    const label = request.symbology === 'qr'
      ? `<article class="label qr-label">${qrSvg(variant.barcode, request.width, request.height)}<div class="details">${name}${option}${code}</div></article>`
      : `<article class="label">${name}${option}${barcodeSvg(variant.barcode, request.width - 4)}${code}</article>`
    return Array.from({ length: item.copies }, () => label)
  }).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Qimati product labels</title><style>
    *{box-sizing:border-box}body{margin:0;background:#ededed;color:#111;font-family:Arial,sans-serif}.toolbar{padding:20px;max-width:760px;margin:auto;font-size:14px;line-height:1.5}.toolbar button{background:#111;color:white;border:0;border-radius:999px;padding:12px 24px;cursor:pointer;font:inherit}.toolbar a{color:#111}.labels{display:flex;flex-wrap:wrap;gap:12px;padding:20px;justify-content:center}.label{width:${request.width}mm;height:${request.height}mm;padding:2mm;background:white;display:flex;flex-direction:column;align-items:center;justify-content:center;break-inside:avoid;overflow:hidden}.name,.variant{max-width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:8pt}.name{font-weight:bold}.variant{margin:1mm 0}.symbol{flex:none}.symbol img{display:block;width:100%;height:9mm}.code{font-size:8pt;white-space:nowrap;margin-top:1mm}.qr-label{flex-direction:row;gap:1mm}.qr-symbol{flex:none}.qr-symbol img{display:block;width:100%;height:100%}.details{min-width:0;flex:1}.qr-label .name,.qr-label .variant{font-size:7pt;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.qr-label .code{font-size:6pt;white-space:normal;overflow-wrap:anywhere}.label:focus{outline:2px solid #111}@page{size:${request.width}mm ${request.height}mm;margin:0}@media print{body{background:white}.toolbar{display:none}.labels{display:block;padding:0}.label{break-after:page;margin:0}.label:last-child{break-after:auto}}
    </style></head><body><div class="toolbar"><h1>Ready to print</h1><p>${request.items.reduce((n, item) => n + item.copies, 0)} labels · ${request.width} × ${request.height} mm · ${request.symbology === 'qr' ? 'QR (2D scanner or phone)' : 'Code 128'}</p><p>Choose matching label paper, 100% scale, no margins, and turn browser headers and footers off. Test one label with your scanner before printing the full batch. This layout is for individual labels on a roll.</p><button onclick="window.print()">Print / Save PDF</button> <a href="/labels">Back to labels</a></div><main class="labels">${labels}</main></body></html>`
}
