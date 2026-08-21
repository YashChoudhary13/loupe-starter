'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  newSkuFromRestockAction,
  refreshRestockAction,
  reopenIdentificationAction,
  restockExistingAction,
} from '@/app/(shell)/restock/actions'
import { Notice } from '@/components/console/primitives'
import { LIVE_ACTIVITY_EVENT, shouldRefreshIdentify, type LiveActivityUpdate } from '@/lib/live/types'
import type { RestockItem, RestockSnapshot } from '@/lib/match/restock-read-model'
import { PROMPT_CATEGORY_CORES, settingsForCategory } from '@/lib/prompts/matrix'
import type { ProductStock } from '@/lib/shopify/inventory'
import { cn } from '@/lib/utils'

/**
 * Restock (D112). A photograph arrives here only after an operator said in
 * Identify that it shows an existing SKU. The operator confirms once more, then
 * chooses: set the stock on the existing product, or make a new SKU and archive
 * the old one at publish. Nothing here happens without a click.
 */

export function RestockScreen({ initialSnapshot }: { initialSnapshot: RestockSnapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ title: string; detail: string | null } | null>(null)
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const result = await refreshRestockAction()
      if (result.ok) setSnapshot(result.data)
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    const onLive = (event: Event) => {
      const update = (event as CustomEvent<LiveActivityUpdate>).detail
      if (update?.snapshot && shouldRefreshIdentify(update.snapshot.events)) void refresh()
    }
    window.addEventListener(LIVE_ACTIVITY_EVENT, onLive)
    return () => window.removeEventListener(LIVE_ACTIVITY_EVENT, onLive)
  }, [refresh])

  const run = useCallback(async (key: string, action: () => Promise<{ ok: true; data: RestockSnapshot } | { ok: false; error: string; detail: string | null }>) => {
    setBusy(key)
    setNotice(null)
    try {
      const result = await action()
      if (result.ok) setSnapshot(result.data)
      else setNotice({ title: result.error, detail: result.detail })
    } finally {
      setBusy(null)
    }
  }, [])

  return (
    <main className="loupe-scroll flex min-h-0 min-w-0 flex-col gap-3.5 overflow-y-auto pr-1">
      <div>
        <h1 className="text-[26px] font-medium tracking-[-0.025em]">Restock</h1>
        <div className="text-[12px] text-muted-foreground">
          Photographs confirmed as existing products. Set the stock, or make a new SKU and retire the old one.
        </div>
      </div>

      {notice ? <Notice tone="attention" title={notice.title} detail={notice.detail} /> : null}

      {snapshot.items.length === 0 ? (
        <div className="rounded-panel bg-surface px-5 py-8 text-center text-[12.5px] text-muted-foreground">
          Nothing to restock. A photograph lands here when Identify marks it as a restock.
        </div>
      ) : null}

      {snapshot.items.map((item) => (
        <RestockCard
          key={item.decisionId}
          item={item}
          busy={busy === item.decisionId}
          onRestock={(productId, quantities) =>
            void run(item.decisionId, () => restockExistingAction({ intakeFileId: item.intakeFileId, productId, quantities }))
          }
          onNewSku={(productId, wantsNewImage, categorySlug, settingSlug) =>
            void run(item.decisionId, () =>
              newSkuFromRestockAction({ intakeFileId: item.intakeFileId, productId, wantsNewImage, categorySlug, settingSlug }),
            )
          }
          onReopen={() => void run(item.decisionId, () => reopenIdentificationAction({ intakeFileId: item.intakeFileId }))}
        />
      ))}
    </main>
  )
}

function RestockCard({
  item,
  busy,
  onRestock,
  onNewSku,
  onReopen,
}: {
  item: RestockItem
  busy: boolean
  onRestock: (productId: string, quantities: { inventoryItemId: string; label: string; before: number; after: number }[]) => void
  onNewSku: (productId: string | null, wantsNewImage: boolean, categorySlug: string | null, settingSlug: string | null) => void
  onReopen: () => void
}) {
  const product: ProductStock | null = item.stock?.[0] ?? null
  const [totals, setTotals] = useState<Record<string, string>>({})
  const [path, setPath] = useState<'existing' | 'new' | null>(null)
  const [wantsImage, setWantsImage] = useState(true)
  const [categorySlug, setCategorySlug] = useState('')
  const [settingSlug, setSettingSlug] = useState('')
  const chosen = item.candidates.find((c) => c.sku === item.sku)

  const quantities = (product?.variants ?? []).map((v) => ({
    inventoryItemId: v.inventoryItemId,
    label: v.label,
    before: v.quantity,
    after: Number.parseInt(totals[v.inventoryItemId] ?? String(v.quantity), 10),
  }))
  const quantitiesValid = quantities.length > 0 && quantities.every((q) => Number.isInteger(q.after) && q.after >= 0)

  return (
    <section className="rounded-[24px] bg-surface p-4">
      <div className="flex gap-4">
        <div className="size-[132px] shrink-0 overflow-hidden rounded-[16px] bg-chip">
          {item.thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.thumb.url} alt="" className="size-full object-cover" />
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate font-mono text-[12px]">{item.filename}</span>
            <span className="rounded-pill bg-chip px-2 py-0.5 text-[10px] text-ink-soft">{item.surface === 'drive' ? 'Drive' : 'Upload'}</span>
            {item.decisionStatus === 'failed' ? (
              <span className="rounded-pill bg-[#faf4e9] px-2 py-0.5 text-[10px] text-amber">last attempt failed</span>
            ) : null}
          </div>

          <div className="mt-3 flex items-center gap-3 rounded-panel bg-ink px-[17px] py-[13px] text-white">
            <div className="size-12 shrink-0 overflow-hidden rounded-[10px] bg-white/10">
              {chosen?.thumbUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={chosen.thumbUrl} alt="" className="size-full object-cover" />
              ) : null}
            </div>
            <div className="min-w-0">
              <div className="loupe-label text-white/45">Confirmed as</div>
              <div className="text-[17px] font-semibold tracking-[-0.01em]">{item.sku}</div>
              <div className="truncate font-mono text-[11px] text-white/60">
                {product ? `${product.title} · ${product.handle} · ${product.status}` : chosen?.title ?? chosen?.handle ?? ''}
              </div>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={onReopen}
              className="ml-auto rounded-pill bg-white/10 px-3 py-1.5 text-[11px] text-white hover:bg-white/20 disabled:opacity-50"
            >
              Not this one — back to Identify
            </button>
          </div>

          {item.lastError ? <Notice tone="attention" title="The last attempt did not go through." detail={item.lastError} /> : null}

          {item.stockError ? (
            <div className="mt-2 text-[11.5px] text-amber">Shopify could not be read: {item.stockError}</div>
          ) : !product ? (
            <div className="mt-2 text-[11.5px] text-muted-foreground">No Shopify product carries {item.sku}; only a new SKU is possible.</div>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !product}
              onClick={() => setPath(path === 'existing' ? null : 'existing')}
              className={cn('rounded-pill px-4 py-2 text-[12px] font-medium', path === 'existing' ? 'bg-ink text-white' : 'bg-chip text-ink hover:bg-[#e7e7e7]', 'disabled:opacity-50')}
            >
              Restock {item.sku}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setPath(path === 'new' ? null : 'new')}
              className={cn('rounded-pill px-4 py-2 text-[12px] font-medium', path === 'new' ? 'bg-ink text-white' : 'bg-chip text-ink hover:bg-[#e7e7e7]', 'disabled:opacity-50')}
            >
              Create a new SKU, archive {item.sku}
            </button>
          </div>

          {path === 'existing' && product ? (
            <div className="mt-3 rounded-panel bg-chip p-3">
              <div className="loupe-label mb-2">New stock totals</div>
              <div className="flex flex-wrap gap-3">
                {product.variants.map((v) => (
                  <label key={v.inventoryItemId} className="flex items-center gap-2 text-[12px]">
                    <span className="w-24 truncate">{v.label}</span>
                    <span className="text-muted-foreground">{v.quantity} →</span>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={totals[v.inventoryItemId] ?? String(v.quantity)}
                      onChange={(e) => setTotals({ ...totals, [v.inventoryItemId]: e.target.value })}
                      className="w-20 rounded-pill bg-surface px-3 py-1.5 text-[12px] outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset]"
                    />
                  </label>
                ))}
              </div>
              <button
                type="button"
                disabled={busy || !quantitiesValid}
                onClick={() => onRestock(product.productId, quantities)}
                className="mt-3 rounded-pill bg-ink px-4 py-2 text-[12px] font-medium text-white hover:bg-[#242428] disabled:opacity-50"
              >
                {busy ? 'Applying…' : `Set stock in Shopify and keep the photograph as a reference`}
              </button>
            </div>
          ) : null}

          {path === 'new' ? (
            <div className="mt-3 rounded-panel bg-chip p-3">
              <div className="loupe-label mb-2">New generated image?</div>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => setWantsImage(true)} className={cn('rounded-pill px-3 py-1.5 text-[11.5px]', wantsImage ? 'bg-ink text-white' : 'bg-surface')}>
                  Yes — generate with prompts
                </button>
                <button type="button" onClick={() => setWantsImage(false)} className={cn('rounded-pill px-3 py-1.5 text-[11.5px]', !wantsImage ? 'bg-ink text-white' : 'bg-surface')}>
                  No — use the photograph as it is
                </button>
                {wantsImage ? (
                  <>
                    <select value={categorySlug} onChange={(e) => { setCategorySlug(e.target.value); setSettingSlug('') }} aria-label="Category prompt" className="rounded-pill bg-surface px-3 py-1.5 text-[11.5px]">
                      <option value="">Current default prompts</option>
                      {PROMPT_CATEGORY_CORES.map((core) => (
                        <option key={core.slug} value={core.slug}>{core.label}</option>
                      ))}
                    </select>
                    {categorySlug ? (
                      <select value={settingSlug} onChange={(e) => setSettingSlug(e.target.value)} aria-label="Setting prompt" className="rounded-pill bg-surface px-3 py-1.5 text-[11.5px]">
                        <option value="">Choose a setting</option>
                        {settingsForCategory(categorySlug).map((s) => (
                          <option key={s.slug} value={s.slug}>{s.label}</option>
                        ))}
                      </select>
                    ) : null}
                  </>
                ) : null}
              </div>
              <div className="mt-2 text-[11.5px] text-muted-foreground">
                The photograph goes to the console as a new product. When it publishes, {item.sku} is archived and its stock set to 0.
              </div>
              <button
                type="button"
                disabled={busy || (wantsImage && Boolean(categorySlug) && !settingSlug)}
                onClick={() => onNewSku(product?.productId ?? null, wantsImage, categorySlug || null, settingSlug || null)}
                className="mt-3 rounded-pill bg-ink px-4 py-2 text-[12px] font-medium text-white hover:bg-[#242428] disabled:opacity-50"
              >
                {busy ? 'Working…' : 'Create the new SKU'}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
