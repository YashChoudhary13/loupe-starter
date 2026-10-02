// Offline preview of the real QC components. No .env, Shopify or database access.
// Run: node scripts/qc-preview.mjs (then open http://127.0.0.1:4178/qc).
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'

const out = resolve('build/qc-preview')
await mkdir(out, { recursive: true })
const stubs = {
  'next/link': 'import {createElement} from "react"; export default ({children,...props}) => createElement("a",props,children)',
  'next/navigation': 'export const usePathname = () => location.pathname',
  '@/components/live/LiveActivity': 'export const LiveActivity = () => null',
  '@/lib/auth/authorize': 'export const requireOperator = async () => ({id:"fixture",email:"checker@example.test",role:"operator"})',
  '@/lib/shopify/client': 'export class ShopifyClient {}',
  '@/lib/shopify/qc-orders': 'export {listQcOrders, qcShopifyError} from "./tests/fixtures/qc-preview"',
  '@/lib/qc/server': 'export {qcOrderStatuses, listRecentPasses} from "./tests/fixtures/qc-preview"',
}
await build({
  entryPoints: ['tests/fixtures/qc-preview.tsx'], outfile: `${out}/preview.js`, bundle: true,
  format: 'esm', jsx: 'automatic', sourcemap: true,
  plugins: [{ name: 'offline-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'fixture' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], resolveDir: process.cwd() }))
  } }],
})
const css = await postcss([tailwind()]).process(await readFile('src/app/globals.css', 'utf8'), { from: resolve('src/app/globals.css') })
await writeFile(`${out}/preview.css`, css.css)
const font = (await readdir('.next/static/media').catch(() => [])).find(name => name.endsWith('-s.p.woff2'))
const html = `<!doctype html><html data-face="qc"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>QC · fictional fixture</title><link rel="stylesheet" href="/preview.css"><style>${font ? '@font-face{font-family:Inter;src:url(/inter.woff2);font-weight:100 900}' : ''}:root{--font-inter:${font ? 'Inter' : 'Arial'}}</style><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>`
createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const file = path === '/inter.woff2' && font ? resolve('.next/static/media', font) : ['/preview.js', '/preview.js.map', '/preview.css'].includes(path) ? `${out}${path}` : null
  res.setHeader('Content-Type', path.endsWith('.woff2') ? 'font/woff2' : path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : 'text/html')
  res.setHeader('Content-Security-Policy', "connect-src 'self'; img-src 'self' data:; font-src 'self' data:")
  try { res.end(file ? await readFile(file) : html) } catch { res.statusCode = 404; res.end('Not found') }
}).listen(4178, '127.0.0.1', () => console.log('Fictional QC fixtures: http://127.0.0.1:4178/qc and /qc/90001'))
