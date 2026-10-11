'use client'

import { useState } from 'react'

import { ImageLightbox, type LightboxImage } from '@/components/console/ImageLightbox'
import type { RestockCandidateItem, RestockDecision } from '@/lib/agent-intake/restock'
import { formatPaise } from '@/lib/console/money'
import { cn } from '@/lib/utils'

/**
 * D148: what Claude believes is a restock, waiting for the owner. The phone photograph sits beside
 * the old listing (or listings: one design is sometimes sold under several SKUs, latest first), and
 * nothing reaches Pending until one of the three buttons is pressed.
 */
export function RestockCandidateCard({
  item,
  busy,
  onDecide,
}: {
  item: RestockCandidateItem
  busy: boolean
  onDecide: (choice: RestockDecision, sku: string | null) => void
}) {
  const [sku, setSku] = useState(item.candidates[0]?.sku ?? null)
  const [lightbox, setLightbox] = useState<number | null>(null)
  const chosen = item.candidates.find((c) => c.sku === sku) ?? null
  const sure = item.kind === 'old'

  const images: LightboxImage[] = [
    ...(item.photo ? [{ url: item.photo.url, thumbUrl: item.thumb?.url ?? null, alt: `Phone photograph ${item.filename}`, caption: `${item.filename} · phone photograph` }] : []),
    ...item.candidates.flatMap((c) => (c.imageUrl ? [{ url: c.imageUrl, thumbUrl: null, alt: `Listing image of ${c.sku}`, caption: `${c.sku} · ${c.title ?? c.handle}` }] : [])),
  ]
  const indexOf = (url: string | null | undefined) => (url ? images.findIndex((image) => image.url === url) : -1)
  const open = (url: string | null | undefined) => { const i = indexOf(url); if (i >= 0) setLightbox(i) }

  return (
    <section className="rounded-[24px] bg-surface p-4" aria-label={`Restock candidate ${item.filename}`}>
      <ImageLightbox images={images} index={lightbox} onClose={() => setLightbox(null)} onIndexChange={setLightbox} />
      <div className="flex flex-col gap-4 md:flex-row">
        <figure className="w-full shrink-0 md:w-[220px]">
          <button type="button" onClick={() => open(item.photo?.url)} title="View full size" className="block aspect-square w-full cursor-zoom-in overflow-hidden rounded-[16px] bg-chip">
            {item.photo ? (
              // The small copy when there is one; a HEIC or a failed thumbnail falls back to the photograph itself.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.thumb?.url ?? item.photo.url} alt={`Phone photograph ${item.filename}`} loading="lazy" className="size-full object-cover"
                onError={(event) => { if (item.photo && event.currentTarget.src !== item.photo.url) event.currentTarget.src = item.photo.url }} />
            ) : null}
          </button>
          <figcaption className="mt-1.5 text-[11px] text-muted-foreground">
            <span className="font-medium text-ink-soft">New phone photo</span> · <span className="font-mono">{item.filename}</span>
          </figcaption>
        </figure>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className={cn('rounded-pill px-2.5 py-1 text-[11px] font-semibold', sure ? 'bg-ink text-white' : 'bg-[#faf4e9] text-amber')}>
              {sure ? `Restock of ${item.candidates.map((c) => c.sku).join(' / ')}` : 'Not sure it is a restock'}
            </span>
            <span className="truncate text-[11px] text-muted-foreground">batch {item.batch}</span>
          </div>
          {item.note ? <p className="mt-2 text-[12px] leading-relaxed text-ink-soft">{item.note}</p> : null}

          {item.candidates.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-3" role="radiogroup" aria-label="Which listing it is">
              {item.candidates.map((c, i) => {
                const selected = c.sku === sku
                const inStock = (c.available ?? 0) > 0
                return (
                  <div key={c.sku} className={cn('w-[220px] rounded-[16px] p-2 transition-shadow', selected ? 'bg-chip shadow-[0_0_0_2px_var(--ink)_inset]' : 'bg-chip')}>
                    <button type="button" onClick={() => open(c.imageUrl)} title="View full size" className="block aspect-square w-full cursor-zoom-in overflow-hidden rounded-[10px] bg-surface">
                      {c.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={`${c.imageUrl}${c.imageUrl.includes('?') ? '&' : '?'}width=400`} alt={`Listing image of ${c.sku}`} loading="lazy" className="size-full object-cover" />
                      ) : <span className="grid size-full place-items-center text-[11px] text-muted-foreground">no image</span>}
                    </button>
                    <button type="button" role="radio" aria-checked={selected} disabled={busy} onClick={() => setSku(c.sku)} className="mt-2 block w-full text-left disabled:opacity-50">
                      <span className="flex items-baseline gap-1.5">
                        <span className="text-[15px] font-semibold tracking-[-0.01em]">{c.sku}</span>
                        {c.status ? <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{c.status.toLowerCase()}</span> : null}
                        {sure && i === 0 && item.candidates.length > 1 ? <span className="text-[10px] text-muted-foreground">· latest</span> : null}
                      </span>
                      <span className="block truncate text-[11px] text-ink-soft">{c.title ?? c.handle}</span>
                      <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {c.available !== null ? (
                          <span className={cn('rounded-pill px-2 py-0.5 text-[11px]', inStock ? 'bg-amber font-semibold text-white' : 'bg-surface text-muted-foreground')}>
                            {inStock ? `${c.available} in stock` : 'sold out'}
                          </span>
                        ) : null}
                        {c.pricePaise !== null ? <span className="text-[11px] text-ink-soft">{formatPaise(c.pricePaise)}</span> : null}
                      </span>
                    </button>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="mt-3 text-[11.5px] text-muted-foreground">Claude named no listing for this photograph.</p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !chosen?.imageUrl}
              onClick={() => onDecide('use_old', sku)}
              title={chosen ? `Send ${chosen.sku}'s listing image to Pending as a restock. No new image is made.` : 'Pick a listing first'}
              className="rounded-pill bg-ink px-4 py-2 text-[12px] font-medium text-white hover:bg-[#242428] disabled:opacity-50"
            >
              {busy ? 'Working…' : chosen ? `Use old image of ${chosen.sku}` : 'Use old image'}
            </button>
            <button
              type="button"
              disabled={busy || !chosen}
              onClick={() => onDecide('generate', sku)}
              title="It is this piece, but Claude should make a new image of it. It lands in Pending as a restock in a few minutes."
              className="rounded-pill bg-chip px-4 py-2 text-[12px] font-medium text-ink hover:bg-[#e7e7e7] disabled:opacity-50"
            >
              Generate new image
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onDecide('wrong', null)}
              title="It is a different piece. Claude renders it as a new product."
              className="rounded-pill bg-chip px-4 py-2 text-[12px] font-medium text-ink hover:bg-[#e7e7e7] disabled:opacity-50"
            >
              Wrong restock
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
