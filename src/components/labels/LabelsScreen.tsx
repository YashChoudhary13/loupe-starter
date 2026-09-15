import { PrepareCodes } from './PrepareCodes'
import type { LabelVariant } from '@/lib/labels/catalogue'

const field = 'rounded-pill bg-chip px-4 py-2.5 text-[13px] text-ink focus:outline-2 focus:outline-ink'

export function LabelsScreen({ query, variants, error }: { query: string; variants: readonly LabelVariant[]; error?: string }) {
  return <section className="h-full overflow-auto px-4 py-6 md:px-8">
    <h1 className="text-[26px] font-medium tracking-[-0.025em]">Labels</h1>
    <p className="mt-2 text-[13px] text-ink-soft">Find a product, choose copies for each colour or size, then print its saved Shopify barcode.</p>
    <form action="/labels" className="my-6 flex flex-wrap items-end gap-3">
      <label className="grid gap-2 text-[12px]">Product or variant SKU<input name="q" defaultValue={query} placeholder="NK1333" maxLength={64} required className={field} /></label>
      <button className="rounded-pill bg-ink px-6 py-2.5 text-[13px] text-white">Find product</button>
    </form>
    {error && <p role="alert" className="mb-4 text-[13px] text-amber">{error}</p>}
    {query && !error && variants.length === 0 && <p>No matching variants. Check the SKU and try again.</p>}
    {[...new Map(variants.map(v => [v.product.id, v.product])).values()].map(product => <PrepareCodes key={product.id} productId={product.id} title={product.title} />)}
    {variants.length > 0 && <form action="/api/labels/print" method="post" target="_blank" className="rounded-card bg-surface p-5">
      <div className="overflow-x-auto"><table className="w-full text-left text-[13px]"><thead><tr className="border-b border-chip text-[10px] uppercase tracking-[0.11em] text-muted-foreground"><th className="py-3">Product / option</th><th>SKU / barcode</th><th>Stock</th><th>Copies</th></tr></thead><tbody>
        {variants.map(variant => <tr key={variant.id} className="border-b border-chip"><td className="py-4 pr-3"><div>{variant.product.title}</div><div className="mt-1 text-ink-soft">{variant.title === 'Default Title' ? 'One option' : variant.title}</div></td><td className="py-4 pr-3 font-mono text-[12px]"><div>{variant.sku || 'No SKU'}</div><div className={variant.barcode ? 'text-ink-soft' : 'text-amber'}>{variant.barcode || 'Barcode missing — use Prepare codes'}</div></td><td className="pr-3">{variant.inventoryQuantity ?? '—'}</td><td><input name={`copies:${variant.id}`} aria-label={`Copies of ${variant.product.title} ${variant.title}`} type="number" min={0} max={500} step={1} defaultValue={0} disabled={!variant.barcode} required className={`${field} w-24`} /></td></tr>)}
      </tbody></table></div>
      <div className="mt-5 flex flex-wrap items-end gap-4">
        <label className="grid gap-2 text-[12px]">Code type<select name="symbology" defaultValue="qr" className={field}><option value="qr">QR — small pouches</option><option value="code128">Code 128 — wider labels</option></select></label>
        <label className="grid gap-2 text-[12px]">Width (mm)<input name="width" type="number" min={30} max={100} defaultValue={38} required className={`${field} w-28`} /></label>
        <label className="grid gap-2 text-[12px]">Height (mm)<input name="height" type="number" min={25} max={70} defaultValue={25} required className={`${field} w-28`} /></label>
        <button className="rounded-pill bg-ink px-6 py-2.5 text-[13px] text-white">Preview labels</button>
      </div>
      <p className="mt-4 text-[12px] leading-relaxed text-ink-soft">Default paper: 38 × 25 mm. Leave copies at 0 to skip a variant. QR needs a 2D scanner or phone. Code 128 usually needs a wider label (try 70 × 30 mm). Sizes are for individual roll labels; match your printer paper. Preview checks saved codes for duplicates before printing.</p>
    </form>}
  </section>
}
