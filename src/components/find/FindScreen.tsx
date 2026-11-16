'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { Notice } from '@/components/console/primitives'
import { day, parseQuery, photoSrc, stickerDiffers, viewOf, type FindResult, type OrderLive, type ParcelHit, type RawHit, type Tracking } from '@/lib/find/query'
import { cn } from '@/lib/utils'

/**
 * Find (D173): the support desk's look-up. One field: an order number shows the photograph of the packed parcel with
 * the order and its tracking number in a strip on top; a product code shows the phone photograph the listing was made
 * from. Built for many chats at once: the answer follows the typing, Enter copies the picture, Esc clears.
 */

const TYPING_PAUSE_MS = 140
/** Shopify is asked a little later than the database, so a number still being typed does not ask about every prefix. */
const TRACKING_PAUSE_MS = 260
const KEEP_MS = 60_000
const COPY_EDGE = 1600
const RECENT_KEY = 'find.recent'
const pill = 'inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-pill px-4 text-[13px] font-medium transition-colors disabled:opacity-45'

async function ask<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } })
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
  if (!response.ok) throw new Error(body?.error?.message ?? (response.status === 401 ? 'You are signed out. Reload the page and sign in.' : 'That did not work. Try again.'))
  return body as T
}

/** The picture as it should reach the buyer: a parcel photograph carries the order and its tracking number in a strip on top. */
async function pictureBlob(image: HTMLImageElement, strip: { left: string; right: string } | null): Promise<Blob> {
  if (!image.complete || !image.naturalWidth) await image.decode()
  const scale = Math.min(1, COPY_EDGE / Math.max(image.naturalWidth, image.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(image.naturalWidth * scale)
  canvas.height = Math.round(image.naturalHeight * scale)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser cannot draw the picture.')
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  if (strip) {
    const height = Math.max(44, Math.round(canvas.height * 0.09)), pad = Math.round(height * 0.35)
    let size = Math.round(height * 0.46)
    const font = () => { context.font = `600 ${size}px Inter, system-ui, sans-serif` }
    font()
    // A long tracking number on a narrow (portrait) photograph: smaller letters, never clipped ones.
    while (size > 10 && context.measureText(strip.left).width + context.measureText(strip.right).width + pad * 3 > canvas.width) { size -= 1; font() }
    context.fillStyle = 'rgba(10,10,10,.82)'
    context.fillRect(0, 0, canvas.width, height)
    context.fillStyle = '#fff'
    context.textBaseline = 'middle'
    context.fillText(strip.left, pad, height / 2)
    context.textAlign = 'right'
    context.fillText(strip.right, canvas.width - pad, height / 2)
  }
  return new Promise((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('The picture could not be made.'))), 'image/png'))
}

type Live = { number: number; data?: OrderLive; error?: string }

/**
 * This tab's memory of answers: going back to a chat's order shows it at once. An answer older than a minute is still
 * shown, and asked again in the background, so a look-up never blinks back to empty.
 */
function keeper<K, V>() {
  const kept = new Map<K, { at: number; value: V }>()
  return {
    get: (key: K) => kept.get(key)?.value,
    fresh: (key: K) => { const item = kept.get(key); return !!item && Date.now() - item.at < KEEP_MS },
    drop: (key: K) => { kept.delete(key) },
    keep(key: K, value: V) { kept.delete(key); kept.set(key, { at: Date.now(), value }); if (kept.size > 300) kept.delete(kept.keys().next().value as K) },
  }
}
const results = keeper<string, FindResult>()
const lives = keeper<number, OrderLive>()

/**
 * The picture to copy. A parcel's carries its tracking number, so when Enter comes before Shopify has answered the
 * picture waits for that answer rather than going out with the order number alone.
 */
async function pictureToCopy(image: HTMLImageElement, order: number | null): Promise<Blob> {
  if (order === null) return pictureBlob(image, null)
  let data = lives.get(order)
  if (!data) {
    try { data = await ask<OrderLive>(`/api/find?order=${order}`, AbortSignal.timeout(8000)); lives.keep(order, data) }
    catch { /* Shopify did not answer: the picture still names the order, and the card says the tracking was not checked. */ }
  }
  const tracking = data?.tracking[0]
  return pictureBlob(image, { left: `Qimati${order}`, right: tracking ? `${tracking.carrier}  ${tracking.number}` : '' })
}

/** Recent look-ups live in this browser only; a second Find tab sees them too. */
const recentListeners = new Set<() => void>()
const recentStore = {
  subscribe(run: () => void) { recentListeners.add(run); window.addEventListener('storage', run); return () => { recentListeners.delete(run); window.removeEventListener('storage', run) } },
  read() { try { return localStorage.getItem(RECENT_KEY) ?? '[]' } catch { return '[]' } },
  write(next: readonly string[]) { try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)) } catch { /* private window: no recent list */ } for (const run of recentListeners) run() },
}
function recentFrom(raw: string): string[] {
  try { const kept: unknown = JSON.parse(raw); return Array.isArray(kept) ? kept.filter((item): item is string => typeof item === 'string').slice(0, 8) : [] } catch { return [] }
}

export function FindScreen({ initialQuery }: { initialQuery: string }) {
  const [text, setText] = useState(initialQuery)
  const query = useMemo(() => parseQuery(text), [text])
  const key = query ? `${query.kind}:${query.key}` : ''
  // Every answer is kept with the look-up it belongs to, so an answer for an earlier look-up is never drawn as this one's.
  const [found, setFound] = useState<{ key: string; result: FindResult } | null>(null)
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null)
  const [searchTurn, setSearchTurn] = useState(0)
  const [liveAnswer, setLiveAnswer] = useState<Live | null>(null)
  const [liveTurn, setLiveTurn] = useState(0)
  const [picked, setPicked] = useState<{ card: string; at: number } | null>(null)
  const [said, setSaid] = useState<{ card: string | null; act: string; text: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const pictureRef = useRef<HTMLImageElement>(null)
  const saidTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // The photographs: from this tab's memory when the same look-up was made in the last minute, else from the server.
  const remembered = key ? results.get(key) : undefined
  useEffect(() => {
    if (!query || results.fresh(key)) return
    const control = new AbortController()
    const timer = setTimeout(() => {
      ask<FindResult>(`/api/find?q=${encodeURIComponent(query.key)}`, control.signal)
        .then(result => { results.keep(key, result); setFound({ key, result }); setFailed(now => (now?.key === key ? null : now)) })
        .catch((cause: unknown) => { if (!control.signal.aborted) setFailed({ key, message: cause instanceof Error ? cause.message : 'That did not work. Try again.' }) })
    }, TYPING_PAUSE_MS)
    return () => { clearTimeout(timer); control.abort() }
    // `query` is derived from `key`; depending on it too would run this twice for one keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, searchTurn])

  const failure = failed && failed.key === key ? failed.message : null
  const current = remembered ?? (found && found.key === key ? found.result : null)
  // While the next answer is on its way the last list stays, dimmed, so the screen does not blink between keystrokes.
  // Never the last card: a card, and so what Enter and Copy picture act on, always belongs to the look-up in the field.
  const lastView = useMemo(() => (found ? viewOf(found.result) : null), [found])
  const view = useMemo(() => (!key ? null : current ? viewOf(current) : lastView?.type === 'list' ? lastView : null), [key, current, lastView])
  const orderNumber = view?.type === 'order' ? view.number : null
  const cardKey = view?.type === 'order' ? String(view.number) : view?.type === 'product' ? view.code : null
  const photoAt = picked && picked.card === cardKey ? picked.at : 0
  const setPhotoAt = useCallback((at: number) => { if (cardKey) setPicked({ card: cardKey, at }) }, [cardKey])

  // The order's tracking number, from Shopify now. A photograph can carry an old sticker; this is the parcel's real one.
  const rememberedLive = orderNumber === null ? undefined : lives.get(orderNumber)
  useEffect(() => {
    if (orderNumber === null || lives.fresh(orderNumber)) return
    const control = new AbortController()
    const timer = setTimeout(() => {
      ask<OrderLive>(`/api/find?order=${orderNumber}`, control.signal)
        .then(data => { lives.keep(orderNumber, data); setLiveAnswer({ number: orderNumber, data }) })
        .catch((cause: unknown) => { if (!control.signal.aborted) setLiveAnswer({ number: orderNumber, error: cause instanceof Error ? cause.message : 'Shopify did not answer.' }) })
    }, TRACKING_PAUSE_MS)
    return () => { clearTimeout(timer); control.abort() }
  }, [orderNumber, liveTurn])
  const live: Live | null = orderNumber === null ? null
    : rememberedLive ? { number: orderNumber, data: rememberedLive }
    : liveAnswer?.number === orderNumber ? liveAnswer : { number: orderNumber }

  // Recent look-ups: one tap back to a chat's order while other chats are open.
  const recentRaw = useSyncExternalStore(recentStore.subscribe, recentStore.read, () => '[]')
  const recent = useMemo(() => recentFrom(recentRaw), [recentRaw])
  const remember = useCallback((value: string) => {
    recentStore.write([value, ...recentFrom(recentStore.read()).filter(item => item !== value)].slice(0, 8))
  }, [])
  // A card that stays up was the one wanted; a card that flashes past while a longer number is typed was not.
  useEffect(() => {
    if (!cardKey || !current) return
    const timer = setTimeout(() => remember(cardKey), 1200)
    return () => clearTimeout(timer)
  }, [cardKey, current, remember])

  // A link can open straight on a result (?q=8613), and the address follows the look-up so it can be shared.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (text.trim()) url.searchParams.set('q', text.trim()); else url.searchParams.delete('q')
    window.history.replaceState(null, '', url)
  }, [text])

  // The field holds its own text (not a controlled value): what a person types in the instant before this script is
  // ready stays in it, and is searched as soon as the field is adopted. A controlled field would be wiped to empty there.
  const adopt = useCallback((node: HTMLInputElement | null) => { inputRef.current = node; if (node) setText(node.value) }, [])
  const go = useCallback((value: string) => { if (inputRef.current) { inputRef.current.value = value; inputRef.current.focus() } setText(value) }, [])

  const tracking: Tracking | null = live?.data?.tracking[0] ?? null
  const photo = view?.type === 'order' || view?.type === 'product' ? view.photos[Math.min(photoAt, view.photos.length - 1)] ?? null : null

  const act = useCallback(async (name: 'picture' | 'number' | 'link') => {
    let message = 'Copied'
    try {
      if (name === 'picture') {
        const image = pictureRef.current
        if (!image) return
        // The promise goes to the clipboard as it is: Safari only allows the copy inside the tap that asked for it.
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pictureToCopy(image, orderNumber) })])
      } else if (tracking) {
        await navigator.clipboard.writeText(name === 'number' ? tracking.number : tracking.url ?? '')
      }
      if (cardKey) remember(cardKey)
    } catch {
      message = name !== 'picture' ? 'Could not copy' : orderNumber === null ? 'Could not copy. Use Download.' : 'Could not copy. Long-press the picture.'
    }
    setSaid({ card: cardKey, act: name, text: message })
    // One timer: the timer of an earlier copy must not wipe the word of this one.
    clearTimeout(saidTimer.current)
    saidTimer.current = setTimeout(() => setSaid(null), 1400)
  }, [cardKey, orderNumber, remember, tracking])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && event.target !== inputRef.current && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA' || event.target.isContentEditable)
      if (typing) return
      if (event.key === 'Escape') go('')
      else if (event.key === 'Enter' && photo && !(event.target instanceof HTMLButtonElement) && !(event.target instanceof HTMLAnchorElement)) { event.preventDefault(); void act('picture') }
      // A letter or digit typed anywhere goes to the field. Space does not: it presses the button that has the focus.
      else if (document.activeElement !== inputRef.current && event.key.length === 1 && event.key !== ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) inputRef.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [act, go, photo])

  const label = (name: string, normal: string) => (said && said.card === cardKey && said.act === name ? said.text : normal)
  const stale = !!query && !current

  return (
    <section className="h-full overflow-auto px-3 py-4 md:px-8 md:py-6">
      <div className="mx-auto flex w-full max-w-[880px] flex-col">
        <div className="flex items-end justify-between gap-3">
          <h1 className="text-[26px] font-medium tracking-[-0.025em]">Find</h1>
          <Link href="/find/parcels" className={cn(pill, 'h-9 bg-surface text-ink-soft hover:bg-[#f6f6f6]')}>Parcel photos</Link>
        </div>

        <div className="sticky top-0 z-10 -mx-1 bg-bg px-1 pb-2.5 pt-3">
          <input ref={adopt} type="search" inputMode="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} autoFocus
            defaultValue={initialQuery} onChange={event => setText(event.target.value)}
            placeholder="Order number or product code: 8613, RS514" aria-label="Order number or product code"
            className="h-[52px] w-full rounded-pill bg-surface px-[22px] text-[18px] font-medium text-ink placeholder:font-normal placeholder:text-[#6E6E73] focus:outline-2 focus:outline-ink" />
          {recent.length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5" aria-label="Recent look-ups">
              <span className="loupe-label mr-1 !text-ink-soft">Recent</span>
              {recent.map(item => (
                <button key={item} type="button" onClick={() => go(item)} className="h-8 rounded-pill bg-surface px-3 text-[12.5px] font-medium text-ink hover:bg-[#f6f6f6]">{item}</button>
              ))}
            </div>
          )}
        </div>

        <div aria-live="polite" className={cn('transition-opacity', stale && 'opacity-60')}>
          {failure && (
            <Notice tone="attention" title={failure}>
              <button type="button" onClick={() => setSearchTurn(turn => turn + 1)} className="underline underline-offset-2">Try again</button>
            </Notice>
          )}

          {!failure && view?.type === 'list' && (
            <div className="flex flex-col gap-1.5">
              {view.rows.map(row => (
                <button key={row.go} type="button" onClick={() => go(row.go)} className="flex w-full items-center gap-3 rounded-panel bg-surface py-2 pl-2 pr-3.5 text-left hover:bg-[#f6f6f6]">
                  {/* eslint-disable-next-line @next/next/no-img-element -- short-lived private R2 URL. */}
                  {row.thumbUrl ? <img src={row.thumbUrl} alt="" loading="lazy" className="h-11 w-16 shrink-0 rounded-[10px] bg-chip object-cover" /> : <span className="h-11 w-16 shrink-0 rounded-[10px] bg-chip" />}
                  <b className="min-w-[92px] text-[14px] font-semibold">{row.title}</b>
                  <span className="min-w-0 truncate text-[13px] text-ink-soft">{row.note}</span>
                </button>
              ))}
            </div>
          )}

          {!failure && view?.type === 'none' && (
            <Empty title={view.kind === 'order' ? `No parcel photo for an order starting with ${view.key}.` : `No raw photo kept for ${view.key}.`}>
              {view.kind === 'order' ? 'Type the whole order number to see its tracking number.' : 'Raw photos exist for products photographed through Loupe Enhance. Send the listing picture instead.'}
            </Empty>
          )}

          {!failure && view?.type === 'product' && photo && (
            <article className="rounded-card bg-surface p-3.5">
              <div className="mx-1 mb-2.5 flex flex-wrap items-baseline justify-between gap-2.5">
                <b className="text-[15px] font-semibold">{view.code}</b>
                <span className="text-[13px] text-ink-soft">Raw photo · taken {day(photo.at)}</span>
              </div>
              <div className="flex flex-wrap gap-1.5 px-0.5 pb-3">
                <button type="button" onClick={() => void act('picture')} className={cn(pill, 'bg-ink text-white')}>{label('picture', 'Copy picture')}</button>
                <a href={photoSrc((photo as RawHit).kind, photo.photoId, `${view.code}-raw`)} className={cn(pill, 'bg-chip text-ink hover:bg-[#ebebeb]')}>Download</a>
              </div>
              <Shot key={photo.photoId} ref={pictureRef} src={photoSrc((photo as RawHit).kind, photo.photoId)} thumbUrl={photo.thumbUrl} alt={`Raw photo of ${view.code}`} />
              <Thumbs photos={view.photos} at={photoAt} onPick={setPhotoAt} />
            </article>
          )}

          {!failure && view?.type === 'order' && (
            <OrderCard number={view.number} photos={view.photos} photo={photo as ParcelHit | null} photoAt={photoAt} onPick={setPhotoAt} live={live}
              pictureRef={pictureRef} label={label} act={act} retry={() => { lives.drop(view.number); setLiveAnswer(null); setLiveTurn(turn => turn + 1) }} />
          )}
        </div>

        <p className="mt-7 text-[11px] text-ink-soft">Enter copies the picture. Esc clears. Parcel photos are kept from 16 Nov 2026.</p>
      </div>
    </section>
  )
}

function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="px-1.5 py-[18px] text-[13px] text-ink-soft"><b className="mb-1 block text-[15px] font-semibold text-ink">{title}</b>{children}</div>
}

function OrderCard({ number, photos, photo, photoAt, onPick, live, pictureRef, label, act, retry }: {
  number: number; photos: ParcelHit[]; photo: ParcelHit | null; photoAt: number; onPick: (index: number) => void; live: Live | null
  pictureRef: React.RefObject<HTMLImageElement | null>; label: (name: string, normal: string) => string; act: (name: 'picture' | 'number' | 'link') => Promise<void>; retry: () => void
}) {
  const data = live?.data, tracking = data?.tracking[0] ?? null, waiting = !data && !live?.error
  // Shopify has no such order and there is no photograph: nothing to show but that.
  if (data && !data.found && !photo) return <Empty title={`No order Qimati${number} in Shopify.`}>Check the number in the chat. Shopify may not list an order older than 60 days.</Empty>
  const status = waiting ? 'Checking tracking…' : live?.error ? 'Tracking not checked' : !data?.found ? 'Not in Shopify' : data.cancelled ? 'Cancelled' : tracking ? `${data.shippedAt ? `Shipped ${day(data.shippedAt)} · ` : ''}${tracking.carrier}` : 'Not shipped yet'
  const others = data?.tracking.slice(1) ?? []
  const inside = photo && photo.orders[0] !== number ? photo.orders[0] : null
  const withIt = photo && !inside ? photo.orders.filter(other => other !== number) : []
  // Amber is used once: the first of these that is true is the one thing a person must know before sending the picture.
  const warning = live?.error ? null
    : data?.cancelled ? { title: `Qimati${number} is cancelled in Shopify.`, body: 'Check the order before sending anything to the buyer.' }
    : photo && data && stickerDiffers(photo.sticker, data.tracking.map(item => item.number)) ? { title: `The sticker in the photo (${photo.sticker}) is not this order's tracking number.`, body: `Check that the slip in the photo says Qimati${number} before sending it. The number in the strip on top is from Shopify.` }
    : null
  return (
    <article className="rounded-card bg-surface p-3.5">
      <div className="mx-1 mb-2.5 flex flex-wrap items-baseline justify-between gap-2.5">
        <b className="text-[15px] font-semibold">Qimati{number}</b>
        <span className="text-[13px] text-ink-soft">{status}</span>
      </div>
      <div className="flex flex-wrap gap-1.5 px-0.5 pb-3">
        {photo && <button type="button" onClick={() => void act('picture')} className={cn(pill, 'bg-ink text-white')}>{label('picture', 'Copy picture')}</button>}
        <button type="button" disabled={!tracking} onClick={() => void act('number')} className={cn(pill, photo ? 'bg-chip text-ink hover:bg-[#ebebeb]' : 'bg-ink text-white')}>{label('number', 'Copy tracking number')}</button>
        {tracking?.url && <button type="button" onClick={() => void act('link')} className={cn(pill, 'bg-chip text-ink hover:bg-[#ebebeb]')}>{label('link', 'Copy tracking link')}</button>}
        {tracking?.url && <a href={tracking.url} target="_blank" rel="noopener noreferrer" className={cn(pill, 'bg-chip text-ink hover:bg-[#ebebeb]')}>Open tracking ↗</a>}
      </div>
      <div className="mx-0.5 mb-3 flex flex-col gap-2 empty:hidden">
        {live?.error && (
          <Notice tone="plain" title={live.error}>
            <button type="button" onClick={retry} className="underline underline-offset-2">Ask Shopify again</button>
          </Notice>
        )}
        {warning && <Notice tone="attention" title={warning.title}>{warning.body}</Notice>}
        {inside && <Notice tone="plain" title={`Packed inside the parcel of Qimati${inside}.`} />}
        {withIt.length > 0 && <Notice tone="plain" title={`This parcel also holds ${withIt.map(other => `Qimati${other}`).join(', ')}.`} />}
        {others.length > 0 && <Notice tone="plain" title={`This order has ${others.length + 1} tracking numbers.`}><span className="font-mono">{others.map(other => `${other.carrier} ${other.number}`).join(' · ')}</span></Notice>}
        {!photo && <Notice tone="plain" title="No parcel photo for this order.">Photos are kept from 16 Nov 2026, once the packing desk has added the day&apos;s photos.</Notice>}
      </div>
      {photo && (
        <Shot key={photo.photoId} ref={pictureRef} src={photoSrc('parcel', photo.photoId)} thumbUrl={photo.thumbUrl} alt={`Parcel of order Qimati${number}`}>
          <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-2.5 whitespace-nowrap bg-[rgba(10,10,10,.82)] px-[.85em] py-[.6em] text-[clamp(12px,3.5vw,17px)] font-semibold leading-tight text-white">
            <span>Qimati{number}</span>
            {tracking && <span className="font-mono"><small className="mr-2 text-[.65em] font-medium uppercase tracking-[.08em] opacity-75">{tracking.carrier}</small>{tracking.number}</span>}
          </div>
        </Shot>
      )}
      <Thumbs photos={photos} at={photoAt} onPick={onPick} />
    </article>
  )
}

/** The small picture is on screen at once (15 KB, already in the search answer); the full one fades in over it. */
function Shot({ src, thumbUrl, alt, children, ref }: { src: string; thumbUrl: string | null; alt: string; children?: React.ReactNode; ref: React.RefObject<HTMLImageElement | null> }) {
  const [sharp, setSharp] = useState(false)
  return (
    <div className="relative overflow-hidden rounded-tile bg-chip leading-[0]">
      {/* eslint-disable-next-line @next/next/no-img-element -- short-lived private R2 URL. */}
      {thumbUrl && <img src={thumbUrl} alt="" aria-hidden className="block max-h-[72vh] w-full object-contain" />}
      {/* eslint-disable-next-line @next/next/no-img-element -- served by /api/find/photo to a signed-in operator. */}
      <img ref={ref} src={src} alt={alt} onLoad={() => setSharp(true)} className={cn('max-h-[72vh] w-full object-contain transition-opacity duration-150', thumbUrl ? 'absolute inset-0 h-full' : 'block', thumbUrl && !sharp && 'opacity-0')} />
      {children}
    </div>
  )
}

function Thumbs({ photos, at, onPick }: { photos: readonly { photoId: string; thumbUrl: string | null }[]; at: number; onPick: (index: number) => void }) {
  if (photos.length < 2) return null
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {photos.map((item, index) => (
        <button key={item.photoId} type="button" onClick={() => onPick(index)} aria-pressed={index === at} aria-label={`Photo ${index + 1} of ${photos.length}`}
          className={cn('overflow-hidden rounded-[12px] border-2 bg-chip', index === at ? 'border-ink' : 'border-transparent')}>
          {/* eslint-disable-next-line @next/next/no-img-element -- short-lived private R2 URL. */}
          {item.thumbUrl ? <img src={item.thumbUrl} alt="" className="block h-12 w-[72px] object-cover" /> : <span className="grid h-12 w-[72px] place-items-center text-[11px] text-ink-soft">{index + 1}</span>}
        </button>
      ))}
    </div>
  )
}
