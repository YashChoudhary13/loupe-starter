import 'server-only'

import { randomUUID } from 'node:crypto'

import { thumbKeyFor } from '@/lib/agent-jobs/server'
import { actorFor, type Operator } from '@/lib/auth/authorize'
import { consoleObjectStore, signKeys } from '@/lib/console/images'
import { ConsoleError } from '@/lib/console/mutations'
import { serverEnv } from '@/lib/env'
import { ShopifyClient } from '@/lib/shopify/client'
import { supabaseServer } from '@/lib/supabase/server'

import { judgeRead, trackingUrl, type BeginParcel, type FindQuery, type FindResult, type OrderFacts, type OrderLive, type ParcelLists, type ParcelRow, type ParcelStatus, type PhotoKind, type SlipRead, type Tracking, type Verdict } from './query'
import { READER_MIME, readParcelPhoto, type ReaderMime } from './reader'

/** Find (D173): the server half. Search answers from the database alone; Shopify is asked only for one order's tracking. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EXTENSIONS: Record<ReaderMime, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
const MIME_OF: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic' }
const mimeOfKey = (key: string) => MIME_OF[key.slice(key.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream'
/** The browser shrinks a parcel photograph to 2576 px before it leaves (under 1 MB); this only stops a file that was not shrunk. */
const PARCEL_MAX_BYTES = 15 * 1024 * 1024
/** The Claude API takes an image of up to 5 MB once encoded; a larger photograph goes straight to a person. */
const READER_MAX_BYTES = 3_500_000
const PUT_TTL_SECONDS = 900
const MAX_ORDERS_PER_PARCEL = 6

// --- search -------------------------------------------------------------------------------------------------------

interface ParcelFound { order_number: number; photo_id: string; thumb_key: string | null; order_numbers: number[]; sticker: string | null; created_at: string }
interface RawFound { code: string; kind: 'phone' | 'original'; photo_id: string; thumb_key: string | null; taken_at: string }

export async function searchFind(query: FindQuery): Promise<FindResult> {
  const db = supabaseServer()
  if (query.kind === 'order') {
    const { data, error } = await db.rpc('find_parcels', { p_prefix: query.key, p_limit: 30 })
    if (error) throw new ConsoleError('Parcel photos could not be searched.', error.message, true)
    const rows = (data ?? []) as ParcelFound[], signed = await signKeys(rows.map(row => row.thumb_key))
    return { kind: 'order', key: query.key, parcels: rows.map(row => ({ order: row.order_number, photoId: row.photo_id, thumbUrl: row.thumb_key ? signed.get(row.thumb_key)?.url ?? null : null, orders: row.order_numbers, sticker: row.sticker, at: row.created_at })) }
  }
  const { data, error } = await db.rpc('find_raw_photos', { p_prefix: query.key, p_limit: 30 })
  if (error) throw new ConsoleError('Raw photos could not be searched.', error.message, true)
  const rows = (data ?? []) as RawFound[], signed = await signKeys(rows.map(row => row.thumb_key))
  return { kind: 'product', key: query.key, photos: rows.map(row => ({ code: row.code, kind: row.kind, photoId: row.photo_id, thumbUrl: row.thumb_key ? signed.get(row.thumb_key)?.url ?? null : null, at: row.taken_at })) }
}

// --- Shopify: one order by its number -----------------------------------------------------------------------------

interface RawOrder { name: string; cancelledAt: string | null; shippingAddress: { zip: string | null } | null; fulfillments: { status: string; createdAt: string; trackingInfo: { company: string | null; number: string | null; url: string | null }[] }[] }
const ORDER_QUERY = `query LoupeFindOrder($query: String!) {
  orders(first: 5, query: $query) { nodes { name cancelledAt shippingAddress { zip } fulfillments(first: 20) { status createdAt trackingInfo { company number url } } } }
}`
const digits = (name: string) => Number(name.replace(/\D/g, ''))

/** Null when Shopify has no such order. The store's order names carry a prefix ("Qimati8524"), so the answer is matched on the number. */
async function readOrder(client: ShopifyClient, number: number): Promise<RawOrder | null> {
  const data = await client.graphql<{ orders: { nodes: RawOrder[] } }>(ORDER_QUERY, { query: `name:Qimati${number} OR name:#${number} OR name:${number}` })
  return data.orders.nodes.find(order => digits(order.name) === number) ?? null
}

const trackingOf = (order: RawOrder) => order.fulfillments.filter(item => item.status !== 'CANCELLED').flatMap(item => item.trackingInfo)

async function orderFacts(numbers: readonly number[]): Promise<OrderFacts[]> {
  const client = new ShopifyClient()
  return Promise.all(numbers.map(async number => {
    const order = await readOrder(client, number)
    return { number, found: !!order, zip: order?.shippingAddress?.zip ?? null, tracking: order ? trackingOf(order).flatMap(info => (info.number?.trim() ? [info.number.trim()] : [])) : [] }
  }))
}

/** The tracking Shopify holds now. The sticker in a photograph can be out of date (a parcel booked again with another courier); this cannot. */
export async function orderLive(number: number): Promise<OrderLive> {
  let order: RawOrder | null
  try { order = await readOrder(new ShopifyClient(), number) }
  catch (cause) { throw new ConsoleError('Shopify did not answer, so the tracking number is not shown. Try again.', cause instanceof Error ? cause.message : null, true) }
  if (!order) return { number, found: false, cancelled: false, tracking: [], shippedAt: null }
  const active = order.fulfillments.filter(item => item.status !== 'CANCELLED')
  const seen = new Set<string>(), tracking: Tracking[] = []
  for (const info of trackingOf(order)) {
    const value = (info.number ?? '').trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    const carrier = (info.company ?? '').trim() || 'Courier'
    tracking.push({ carrier, number: value, url: trackingUrl(carrier, value, info.url) })
  }
  const shippedAt = active.map(item => item.createdAt).sort().at(-1) ?? null
  return { number, found: true, cancelled: !!order.cancelledAt, tracking, shippedAt }
}

// --- parcel photographs: upload, read, confirm --------------------------------------------------------------------

interface ParcelDb { id: string; storage_key: string; thumb_key: string | null; filename: string; status: ParcelStatus; order_numbers: number[]; sticker: string | null; problem: string | null; uploaded_by: string; confirmed_by: string | null; created_at: string }
const COLUMNS = 'id, storage_key, thumb_key, filename, status, order_numbers, sticker, problem, uploaded_by, confirmed_by, created_at'

async function views(rows: readonly ParcelDb[]): Promise<ParcelRow[]> {
  const signed = await signKeys(rows.map(row => row.thumb_key))
  return rows.map(row => ({ id: row.id, status: row.status, orders: row.order_numbers, sticker: row.sticker, problem: row.problem, filename: row.filename, thumbUrl: row.thumb_key ? signed.get(row.thumb_key)?.url ?? null : null, by: row.uploaded_by, confirmedBy: row.confirmed_by, at: row.created_at }))
}

async function parcel(id: string): Promise<ParcelDb> {
  if (!UUID.test(id)) throw new ConsoleError('That photo was not found.', null, false)
  const { data, error } = await supabaseServer().from('parcel_photos').select(COLUMNS).eq('id', id).maybeSingle<ParcelDb>()
  if (error || !data) throw new ConsoleError('That photo was not found.', error?.message ?? null, false)
  return data
}

/** Whose parcel a photograph is decides which buyer's address is shown under an order, so every change of it is on the audit trail. */
async function record(event: 'parcel.read' | 'parcel.confirmed' | 'parcel.dismissed', row: ParcelDb, actor: string): Promise<void> {
  const { error } = await supabaseServer().from('events').insert({ entity_type: 'parcel_photo', entity_id: row.id, event, detail: { status: row.status, orders: row.order_numbers, sticker: row.sticker, problem: row.problem }, actor })
  if (error) console.error('find: an event was not recorded:', error.message)
}

export async function beginParcelUpload(operator: Operator, input: { filename: string; mimeType: string; bytes: number }): Promise<BeginParcel> {
  const filename = String(input.filename ?? '').trim()
  if (!filename || filename.length > 255 || /[/\\\u0000-\u001f\u007f]/u.test(filename)) throw new ConsoleError('That filename cannot be used.', null, false)
  if (!Object.hasOwn(READER_MIME, input.mimeType)) throw new ConsoleError('Parcel photos must be JPEG, PNG or WebP.', `Received ${input.mimeType || '(missing)'}`, false)
  const mime = input.mimeType as ReaderMime
  if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0 || input.bytes > PARCEL_MAX_BYTES) throw new ConsoleError('That photo is empty or larger than 15 MB.', null, false)
  const db = supabaseServer()
  // The same photograph picked twice (the day's folder uploaded again) is not a second parcel.
  const { data: twins, error: twinError } = await db.from('parcel_photos').select('id, storage_key, status').eq('filename', filename).eq('bytes', input.bytes).in('status', ['pending', 'review', 'matched']).order('created_at', { ascending: false }).limit(20)
  if (twinError) throw new ConsoleError('The photo upload could not be started.', twinError.message, true)
  if (twins?.some(row => row.status !== 'pending')) return { duplicate: true }
  // An upload that broke off, or whose answer never came back, left its row waiting: the next try finishes that row
  // instead of starting a second one, so one photograph never becomes two.
  const waiting = twins?.find(row => row.storage_key.endsWith(`.${EXTENSIONS[mime]}`))
  const id = waiting?.id ?? randomUUID(), key = waiting?.storage_key ?? `parcels/${new Date().toISOString().slice(0, 10)}/${id}.${EXTENSIONS[mime]}`
  if (!waiting) {
    const { error } = await db.from('parcel_photos').insert({ id, storage_key: key, filename, bytes: input.bytes, uploaded_by: actorFor(operator) })
    if (error) throw new ConsoleError('The photo upload could not be started.', error.message, true)
  }
  const store = consoleObjectStore()
  const [uploadUrl, thumbUploadUrl] = await Promise.all([store.presignPut(key, mime, PUT_TTL_SECONDS), store.presignPut(thumbKeyFor(key), 'image/jpeg', PUT_TTL_SECONDS)])
  return { duplicate: false, id, uploadUrl, contentType: mime, thumbUploadUrl }
}

/** Reads the photograph and checks the reading against Shopify. Any failure on the way leaves the photograph for a person; it never guesses. */
async function readAndJudge(key: string, bytes: number): Promise<{ verdict: Verdict; sticker: string | null }> {
  if (bytes > READER_MAX_BYTES) return { verdict: { status: 'review', orders: [], problem: 'This photo is too large to be read automatically.' }, sticker: null }
  let read: SlipRead
  try {
    const image = await consoleObjectStore().get(key)
    read = await readParcelPhoto({ apiKey: serverEnv.homeClaudeApiKey, workspaceId: process.env.HOME_CLAUDE_WORKSPACE_ID?.trim() || undefined, image, mime: mimeOfKey(key) as ReaderMime })
  } catch (cause) {
    console.error('find: a parcel photo was not read:', cause instanceof Error ? cause.message : String(cause))
    return { verdict: { status: 'review', orders: [], problem: 'This photo could not be read automatically.' }, sticker: null }
  }
  const orders = read.orders.slice(0, MAX_ORDERS_PER_PARCEL)
  try {
    return { verdict: judgeRead({ ...read, orders }, await orderFacts(orders)), sticker: read.sticker }
  } catch (cause) {
    console.error('find: Shopify did not confirm a parcel reading:', cause instanceof Error ? cause.message : String(cause))
    return { verdict: { status: 'review', orders, problem: 'Shopify did not answer, so the order number is not confirmed.' }, sticker: read.sticker }
  }
}

/** The browser's PUT landed: read the photograph and record whose parcel it is, or that a person must say. Safe to call twice. */
export async function finishParcelUpload(operator: Operator, id: string): Promise<ParcelRow> {
  const row = await parcel(id)
  if (row.status !== 'pending') return (await views([row]))[0]
  const store = consoleObjectStore()
  const stored = await store.head(row.storage_key)
  if (!stored) throw new ConsoleError('The photo never reached storage. Try it again.', row.storage_key, true)
  // The upload link does not limit the size. A file past the limit stays unfinished: never read, never shown, never
  // loaded into this server's memory.
  if (stored.bytes > PARCEL_MAX_BYTES) throw new ConsoleError('That photo is larger than 15 MB.', `${stored.bytes} bytes`, false)
  const thumbKey = thumbKeyFor(row.storage_key), hasThumb = await store.head(thumbKey).catch(() => null)
  const { verdict, sticker } = await readAndJudge(row.storage_key, stored.bytes)
  const { data, error } = await supabaseServer().from('parcel_photos')
    .update({ status: verdict.status, order_numbers: verdict.orders, sticker, problem: verdict.problem, thumb_key: hasThumb ? thumbKey : null, confirmed_at: verdict.status === 'matched' ? new Date().toISOString() : null })
    .eq('id', id).eq('status', 'pending').select(COLUMNS).maybeSingle<ParcelDb>()
  if (error) throw new ConsoleError('The photo could not be recorded.', error.message, true)
  if (data) await record('parcel.read', data, actorFor(operator))
  return (await views([data ?? await parcel(id)]))[0]
}

/** A person says whose parcel this is. Each number must be a Shopify order: a typing slip must not put one buyer's address under another buyer's order. */
export async function confirmParcel(operator: Operator, id: string, numbers: readonly number[]): Promise<ParcelRow> {
  const orders = [...new Set(numbers)].filter(n => Number.isSafeInteger(n) && n > 0 && n < 100_000_000)
  if (!orders.length) throw new ConsoleError('Type the order number on the slip, for example 8524.', null, false)
  if (orders.length > MAX_ORDERS_PER_PARCEL) throw new ConsoleError(`A parcel holds at most ${MAX_ORDERS_PER_PARCEL} orders here.`, null, false)
  const row = await parcel(id)
  if (row.status === 'pending') throw new ConsoleError('That photo is still uploading.', null, true)
  let facts: OrderFacts[]
  try { facts = await orderFacts(orders) }
  catch (cause) { throw new ConsoleError('Shopify did not answer, so the order number could not be checked. Try again.', cause instanceof Error ? cause.message : null, true) }
  const missing = facts.find(fact => !fact.found)
  if (missing) throw new ConsoleError(`Qimati${missing.number} is not an order in Shopify. Check the number on the slip.`, null, false)
  const { data, error } = await supabaseServer().from('parcel_photos')
    .update({ status: 'matched', order_numbers: orders, problem: null, confirmed_by: actorFor(operator), confirmed_at: new Date().toISOString() })
    .eq('id', id).select(COLUMNS).single<ParcelDb>()
  if (error) throw new ConsoleError('The order number could not be saved.', error.message, true)
  await record('parcel.confirmed', data, actorFor(operator))
  return (await views([data]))[0]
}

/** Not a parcel, or a second copy: Find stops showing it. The file stays in storage. */
export async function dismissParcel(operator: Operator, id: string): Promise<ParcelRow> {
  const row = await parcel(id)
  if (row.status === 'pending') throw new ConsoleError('That photo is still uploading.', null, true)
  const { data, error } = await supabaseServer().from('parcel_photos')
    .update({ status: 'dismissed', confirmed_by: actorFor(operator), confirmed_at: new Date().toISOString() })
    .eq('id', id).select(COLUMNS).single<ParcelDb>()
  if (error) throw new ConsoleError('The photo could not be set aside.', error.message, true)
  await record('parcel.dismissed', data, actorFor(operator))
  return (await views([data]))[0]
}

export async function listParcels(): Promise<ParcelLists> {
  const db = supabaseServer()
  const [review, recent] = await Promise.all([
    db.from('parcel_photos').select(COLUMNS).eq('status', 'review').order('created_at', { ascending: true }).limit(200),
    db.from('parcel_photos').select(COLUMNS).in('status', ['matched', 'dismissed']).order('created_at', { ascending: false }).limit(60),
  ])
  if (review.error || recent.error) throw new ConsoleError('Parcel photos could not be listed.', (review.error ?? recent.error)?.message ?? null, true)
  const [reviewRows, recentRows] = await Promise.all([views((review.data ?? []) as ParcelDb[]), views((recent.data ?? []) as ParcelDb[])])
  return { review: reviewRows, recent: recentRows }
}

// --- one full photograph, by row id (never by storage key) --------------------------------------------------------

export async function photoObject(kind: PhotoKind, id: string): Promise<{ bytes: Buffer; contentType: string; extension: string }> {
  if (!UUID.test(id)) throw new ConsoleError('That photo was not found.', null, false)
  const db = supabaseServer()
  const found = kind === 'parcel' ? await db.from('parcel_photos').select('storage_key').eq('id', id).neq('status', 'pending').maybeSingle<{ storage_key: string }>()
    : kind === 'phone' ? await db.from('agent_job_photos').select('storage_key').eq('id', id).eq('status', 'uploaded').maybeSingle<{ storage_key: string }>()
    : await db.from('image_versions').select('storage_key').eq('id', id).eq('kind', 'original').maybeSingle<{ storage_key: string }>()
  if (found.error || !found.data) throw new ConsoleError('That photo was not found.', found.error?.message ?? null, false)
  const key = found.data.storage_key
  try { return { bytes: await consoleObjectStore().get(key), contentType: mimeOfKey(key), extension: key.slice(key.lastIndexOf('.') + 1).toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg' } }
  catch (cause) { throw new ConsoleError('That photo could not be loaded from storage.', cause instanceof Error ? cause.message : null, true) }
}
