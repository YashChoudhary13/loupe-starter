'use client'

import Link from 'next/link'
import { useCallback, useRef, useState } from 'react'

import { Card, Notice, SectionLabel } from '@/components/console/primitives'
import { photoThumb, shrinkPhoto } from '@/components/enhance/shrink-photo'
import { putUploadedObject } from '@/components/upload/put-object'
import { photoSrc, type BeginParcel, type ParcelLists, type ParcelRow } from '@/lib/find/query'
import { cn } from '@/lib/utils'

/**
 * Find (D173): the packing desk adds the day's parcel photographs here. Each is read as it lands; the ones whose
 * order number could not be read and confirmed wait under "To check" until a person types the number on the slip.
 */

/** What the reader works from, and what the support desk sees: sharp enough for the slip's small print, under 1 MB. */
const PARCEL_EDGE = 2576
const AT_ONCE = 3
const big = 'h-12 w-full rounded-pill text-[14px] font-medium transition-colors disabled:opacity-45'
const small = 'h-10 rounded-pill px-4 text-[13px] font-medium transition-colors disabled:opacity-45'

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch('/api/find', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
  const answer = await response.json().catch(() => null) as { error?: { message?: string } } | null
  if (!response.ok) throw new Error(answer?.error?.message ?? (response.status === 401 ? 'You are signed out. Reload the page and sign in.' : 'That did not work. Try again.'))
  return answer as T
}

const orderText = (orders: readonly number[]) => orders.join(', ')
const names = (orders: readonly number[]) => orders.map(order => `Qimati${order}`).join(' + ')
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })

interface Run { total: number; done: number; matched: number; review: number; twice: number; failed: { file: File; why: string }[] }

export function ParcelsScreen({ initial }: { initial: ParcelLists }) {
  const [review, setReview] = useState(initial.review)
  const [recent, setRecent] = useState(initial.recent)
  const [run, setRun] = useState<Run | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  /** A row changed: it belongs in exactly one of the two lists. */
  const place = useCallback((row: ParcelRow) => {
    setReview(rows => (row.status === 'review' ? [...rows.filter(item => item.id !== row.id), row] : rows.filter(item => item.id !== row.id)))
    setRecent(rows => (row.status === 'review' ? rows.filter(item => item.id !== row.id) : [row, ...rows.filter(item => item.id !== row.id)]))
  }, [])

  const upload = useCallback(async (files: readonly File[]) => {
    if (!files.length) return
    setBusy(true)
    setRun({ total: files.length, done: 0, matched: 0, review: 0, twice: 0, failed: [] })
    const queue = [...files]
    const one = async (file: File) => {
      try {
        const photo = await shrinkPhoto(file, PARCEL_EDGE, 0)
        const begun = await post<BeginParcel>({ op: 'begin', filename: file.name, mimeType: photo.type, bytes: photo.size })
        if (begun.duplicate) { setRun(now => now && { ...now, done: now.done + 1, twice: now.twice + 1 }); return }
        const thumb = await photoThumb(photo)
        await Promise.all([
          putUploadedObject(begun.uploadUrl, photo, begun.contentType, () => undefined),
          // The small picture is a nicety for the lists; the photograph counts without it.
          thumb ? putUploadedObject(begun.thumbUploadUrl, new File([thumb], 'thumb.jpg', { type: 'image/jpeg' }), 'image/jpeg', () => undefined).catch(() => undefined) : undefined,
        ])
        const row = await post<ParcelRow>({ op: 'finish', id: begun.id })
        place(row)
        setRun(now => now && { ...now, done: now.done + 1, matched: now.matched + (row.status === 'matched' ? 1 : 0), review: now.review + (row.status === 'review' ? 1 : 0) })
      } catch (cause) {
        setRun(now => now && { ...now, done: now.done + 1, failed: [...now.failed, { file, why: cause instanceof Error ? cause.message : 'That did not work.' }] })
      }
    }
    const worker = async () => { for (let file = queue.shift(); file; file = queue.shift()) await one(file) }
    await Promise.all(Array.from({ length: AT_ONCE }, worker))
    setBusy(false)
  }, [place])

  const finished = run && run.done === run.total
  return (
    <section className="h-full overflow-auto px-3 py-4 md:px-8 md:py-6">
      <div className="mx-auto flex w-full max-w-[620px] flex-col gap-3.5">
        <div>
          <div className="flex items-end justify-between gap-3">
            <h1 className="text-[26px] font-medium tracking-[-0.025em]">Parcel photos</h1>
            <Link href="/find" className={cn(small, 'inline-flex h-9 items-center bg-surface text-ink-soft hover:bg-[#f6f6f6]')}>Find</Link>
          </div>
          <p className="mt-1 text-[13px] text-ink-soft">Photograph every packed parcel with its slip and courier sticker showing, then add the day&apos;s photos here. Support finds them by order number.</p>
        </div>

        <Card className="p-4 md:p-5">
          <SectionLabel>Add photos</SectionLabel>
          {/* The FileList is live: resetting the input empties it, so the files are copied out first. */}
          <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" multiple className="hidden"
            onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void upload(files) }} />
          <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} className={cn(big, 'mt-2.5 bg-ink text-white')}>
            {busy && run ? `Reading ${Math.min(run.done + 1, run.total)} of ${run.total}` : run ? 'Add more photos' : 'Add photos'}
          </button>
          {run && (
            <p className="mt-2.5 text-[12.5px] text-ink-soft" role="status">
              {run.done} of {run.total} done: {run.matched} matched to an order
              {run.review > 0 && `, ${run.review} to check below`}{run.twice > 0 && `, ${run.twice} already here`}{run.failed.length > 0 && `, ${run.failed.length} failed`}.
            </p>
          )}
          {finished && run.failed.length > 0 && (
            <div className="mt-2.5">
              <Notice tone="attention" title={`${run.failed.length} photo${run.failed.length === 1 ? '' : 's'} did not upload.`} detail={run.failed.map(item => `${item.file.name}: ${item.why}`).join('\n')}>
                <button type="button" onClick={() => void upload(run.failed.map(item => item.file))} className="underline underline-offset-2">Try {run.failed.length === 1 ? 'it' : 'them'} again</button>
              </Notice>
            </div>
          )}
        </Card>

        {review.length > 0 && (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2 px-1">
              <span className="size-1.5 rounded-full bg-amber" aria-hidden />
              <h2 className="text-[13px] font-medium">To check · {review.length}</h2>
              <span className="text-[12px] text-ink-soft">Type the order number printed on the slip.</span>
            </div>
            {review.map(row => <CheckCard key={row.id} row={row} onSaved={place} />)}
          </div>
        )}

        {recent.length > 0 && (
          <Card className="p-4 md:p-5">
            <SectionLabel>Latest</SectionLabel>
            <ul className="mt-2 flex flex-col">
              {recent.map(row => (
                <li key={row.id} className="flex items-center gap-3 border-t border-[#f0f0f0] py-2 first:border-t-0">
                  {/* eslint-disable-next-line @next/next/no-img-element -- short-lived private R2 URL. */}
                  {row.thumbUrl ? <img src={row.thumbUrl} alt="" loading="lazy" className="h-11 w-16 shrink-0 rounded-[10px] bg-chip object-cover" /> : <span className="h-11 w-16 shrink-0 rounded-[10px] bg-chip" />}
                  <div className="min-w-0 flex-1">
                    <div className={cn('truncate text-[13.5px] font-medium', row.status === 'dismissed' && 'text-ink-soft')}>{row.status === 'dismissed' ? 'Set aside' : names(row.orders)}</div>
                    <div className="truncate text-[12px] text-ink-soft">{row.status === 'dismissed' ? 'Not shown in Find' : row.confirmedBy ? `Confirmed by ${row.confirmedBy.split('@')[0]}` : 'Read automatically'} · {when(row.at)}</div>
                  </div>
                  <button type="button" onClick={() => place({ ...row, status: 'review', problem: row.status === 'dismissed' ? 'Set aside earlier. Type its order number to show it in Find.' : 'Change the order number, then save.' })}
                    className="h-8 shrink-0 rounded-pill bg-chip px-3 text-[12px] font-medium text-ink-soft hover:bg-[#ebebeb]">Change</button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </section>
  )
}

/** One photograph a person must place: the picture large enough to read the slip, the reading as a suggestion, one field. */
function CheckCard({ row, onSaved }: { row: ParcelRow; onSaved: (row: ParcelRow) => void }) {
  const [orders, setOrders] = useState(orderText(row.orders))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const send = async (body: Record<string, unknown>) => {
    setBusy(true); setError(null)
    try { onSaved(await post<ParcelRow>({ ...body, id: row.id })) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'That did not work. Try again.'); setBusy(false) }
  }
  return (
    <Card className="p-3.5">
      <a href={photoSrc('parcel', row.id)} target="_blank" rel="noopener noreferrer" title="Open the photo full size" className="block overflow-hidden rounded-tile bg-chip leading-[0]">
        {/* eslint-disable-next-line @next/next/no-img-element -- served by /api/find/photo to a signed-in operator. */}
        <img src={photoSrc('parcel', row.id)} alt={`Parcel photo ${row.filename}`} loading="lazy" className="max-h-[60vh] w-full object-contain" />
      </a>
      {row.problem && <p className="mx-1 mt-2.5 text-[12.5px] text-ink-soft">{row.problem}</p>}
      <form className="mt-2.5 flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void send({ op: 'confirm', orders }) }}>
        <input value={orders} onChange={event => setOrders(event.target.value)} inputMode="numeric" autoComplete="off" placeholder="Order number, for example 8524" aria-label={`Order number for ${row.filename}`}
          className="h-10 min-w-0 flex-1 basis-[180px] rounded-field bg-chip px-3.5 text-[14px] text-ink placeholder:text-[#6E6E73] focus:outline-2 focus:outline-ink" />
        <button type="submit" disabled={busy || !/\d/.test(orders)} className={cn(small, 'bg-ink text-white')}>Save</button>
        <button type="button" disabled={busy} onClick={() => void send({ op: 'dismiss' })} className={cn(small, 'bg-chip text-ink-soft hover:bg-[#ebebeb]')}>Not a parcel</button>
      </form>
      <p className="mx-1 mt-1.5 text-[11.5px] text-ink-soft">Two orders in one parcel: type both, the slip&apos;s own first (8626, 8501).</p>
      {error && <p role="alert" className="mx-1 mt-1.5 text-[12.5px] font-medium text-ink">{error}</p>}
    </Card>
  )
}
