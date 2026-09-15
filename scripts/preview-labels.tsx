/** Local sample generation only: no credentials, Shopify or database calls. */
import React from 'react'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { renderLabelDocument } from '../src/lib/labels/print'
import { LabelsScreen } from '../src/components/labels/LabelsScreen'
const output = resolve(process.argv[2] ?? '/tmp/loupe-label-preview')
mkdirSync(output, { recursive: true })
const variants = ['White', 'Green', 'Pink'].map((title, index) => ({ id: `gid://shopify/ProductVariant/${index + 1}`, sku: `NK1333-C-${title.toUpperCase()}`, barcode: `NK1333-C-${title.toUpperCase()}`, title, inventoryQuantity: [12, 24, 60][index], product: { id: 'sample', title: 'Necklace 1333' } }))
for (const symbology of ['qr', 'code128'] as const) {
  const html = renderLabelDocument({ symbology, width: symbology === 'qr' ? 38 : 70, height: symbology === 'qr' ? 25 : 30, items: variants.map(v => ({ id: v.id, copies: 1 })) }, variants)
  writeFileSync(resolve(output, `${symbology}-sample.html`), html.replace('<h1>Ready to print</h1>', '<h1>Sample pouch labels</h1><p>Layout examples only. These values have not been checked against your Shopify store. Use the Labels screen after deployment for real stock.</p>'))
}
// Use the actual compiled styles and component, with explicitly fictional data.
const cssDirectory = resolve('.next/static/chunks')
const css = readdirSync(cssDirectory).filter(f => f.endsWith('.css')).map(f => readFileSync(resolve(cssDirectory, f), 'utf8')).join('\n')
const unsupportedNavigation = () => { throw new Error('Navigation is unavailable in the static preview.') }
const previewRouter = { back: unsupportedNavigation, forward: unsupportedNavigation, refresh: unsupportedNavigation, push: unsupportedNavigation, replace: unsupportedNavigation, prefetch: unsupportedNavigation, bfcacheId: 'static-preview' }
const screen = renderToStaticMarkup(<AppRouterContext.Provider value={previewRouter}><LabelsScreen query="NK1333" variants={variants} /></AppRouterContext.Provider>)
writeFileSync(resolve(output, 'labels-screen.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loupe Labels — sample screen</title><style>${css}</style></head><body style="background:#ededed;font-family:Arial,sans-serif"><p style="padding:16px;font-size:13px">Sample screen — real Shopify search and printing require a signed-in Loupe session.</p>${screen}</body></html>`)
console.log(`Wrote sample labels and screen to ${output}`)
