'use client'

import type { EditorVariant } from './DraftEditor'

/** Explicit rows keep each colour's sizes independent; never manufacture a cross-product. */
export function CombinationChoices({ variants, colours, disabled, onChange }: {
  variants: readonly EditorVariant[]
  colours: readonly string[]
  disabled: boolean
  onChange: (variants: readonly EditorVariant[]) => void
}) {
  const field = 'min-w-0 w-full rounded-lg bg-surface px-3 py-2 text-[13px] outline-offset-2'
  const update = (index: number, patch: Partial<EditorVariant>) => onChange(variants.map((row, i) => i === index ? { ...row, ...patch } : row))
  return <div className="mt-4 space-y-3">
    <p className="text-[12px] leading-relaxed text-ink-soft">Add only the combinations you sell. Gold can have sizes 7 and 8 while Silver has only size 8. Each row gets its own stock and barcode.</p>
    <datalist id="combination-colours">{colours.map(name => <option key={name} value={name} />)}</datalist>
    {variants.map((row, index) => <div key={index} className="grid grid-cols-[1fr_0.7fr_0.7fr_auto] items-end gap-2">
      <label className="min-w-0 text-[10px] text-ink-soft">Colour<input aria-label={`Colour ${index + 1}`} list="combination-colours" maxLength={32} value={row.value} disabled={disabled} className={field} onChange={e => update(index, { value: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }} /></label>
      <label className="min-w-0 text-[10px] text-ink-soft">Size<input aria-label={`Size ${index + 1}`} maxLength={32} value={row.sizeValue ?? ''} disabled={disabled} className={field} onChange={e => update(index, { sizeValue: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }} /></label>
      <label className="min-w-0 text-[10px] text-ink-soft">Stock<input aria-label={`Stock ${index + 1}`} type="number" min={0} step={1} value={row.stock} disabled={disabled} className={field} onChange={e => update(index, { stock: e.target.value })} /></label>
      <button type="button" aria-label={`Remove combination ${index + 1}`} disabled={disabled} onClick={() => onChange(variants.filter((_, i) => i !== index))} className="rounded-pill px-2 py-2 text-[12px] text-ink-soft">×</button>
    </div>)}
    <button type="button" disabled={disabled || variants.length >= 100} className="rounded-pill bg-surface px-4 py-2 text-[12px] disabled:opacity-40" onClick={() => onChange([...variants, { value: variants.at(-1)?.value ?? '', sizeValue: '', stock: '0' }])}>Add colour + size</button>
  </div>
}
