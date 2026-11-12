import 'server-only'

import { supabaseServer } from '@/lib/supabase/server'
import { ShopifyClient } from '@/lib/shopify/client'
import { listClubOrders } from '@/lib/shopify/club-orders'
import { customers, name as customerName, num, paid } from '@/lib/slips/plan'
import type { SlipOrder } from '@/lib/slips/types'
import { loadQcView, resolveQcCode } from './server'
import { orderGid } from './validation'
import type { ClubView, QcCommand, QcLine } from './types'

/**
 * Club QC (D168). A club is the same customer's open paid orders, by the packing-list rules Print slips uses
 * (`customers` in slips/plan.ts), so the pill here and the CLUB mark on the slip can never disagree.
 * Every order keeps its own checklist (`qc_sessions`); the club is only a way to look at them and scan into them together.
 */
export interface Club { ids: string[]; numbers: number[]; customer: string }

/** Order id → its club (oldest order first), for the orders that have one. Pure. */
export function clubsOf(open: readonly SlipOrder[]): Map<string, Club> {
  const orders = open.filter(paid)
  const { group } = customers(orders)
  const clubs = new Map<string, Club>()
  for (const order of orders) {
    const same = group.get(order.id)!
    if (same.length < 2) continue
    const sorted = [...same].sort((a, b) => num(a.name) - num(b.name))
    clubs.set(order.id, { ids: sorted.map(o => o.id), numbers: sorted.map(o => num(o.name)), customer: customerName(sorted[0]) })
  }
  return clubs
}

const CLUBS_TTL_MS = 5 * 60_000
let cache: { clubs: Map<string, Club>; at: number } | null = null
export function clearClubCache(): void { cache = null }

/** Every club among the open orders. A scan reuses a read up to five minutes old; a page load reads fresh. */
export async function loadClubs(fresh = true, now = Date.now()): Promise<Map<string, Club>> {
  if (!fresh && cache && now - cache.at < CLUBS_TTL_MS) return cache.clubs
  cache = { clubs: clubsOf(await listClubOrders(new ShopifyClient())), at: now }
  return cache.clubs
}

export interface ClubSession { id: string; order_id: string; status: string; generation: number; counts: Record<string, number>; snapshot: { lines?: QcLine[] } }

/**
 * Which order a scanned unit counts in: the oldest unfinished order that still needs this variant; otherwise an
 * unfinished order (the checklist records it as an extra to remove); a finished order only when nothing is unfinished.
 * `sessions` come oldest order first. Pure.
 */
export function pickScanTarget(sessions: readonly ClubSession[], variantId: string | null): ClubSession | undefined {
  const lines = (s: ClubSession) => s.snapshot.lines ?? []
  const has = (s: ClubSession) => lines(s).some(line => line.variantId === variantId)
  const needs = (s: ClubSession) => lines(s).some(line => line.variantId === variantId && (s.counts[line.id] ?? 0) < line.required)
  const unfinished = sessions.filter(s => s.status === 'checking')
  return (variantId ? unfinished.find(needs) ?? unfinished.find(has) : undefined) ?? unfinished[0]
    ?? (variantId ? sessions.find(s => s.status === 'passed' && has(s)) : undefined) ?? sessions[0]
}

/** The club of `orderId` with every member's checklist freshly synced, or null when the order is not clubbed. */
export async function loadClubView(orderId: string, operator: { readonly id: string }): Promise<ClubView | null> {
  const club = (await loadClubs()).get(orderGid(orderId))
  if (!club) return null
  const members = await Promise.all(club.ids.map(id => loadQcView(id, operator)))
  return { anchorId: orderGid(orderId), customer: club.customer, members, operatorId: operator.id }
}

/** One scan into the club: the server picks the order, so two members carrying the same variant fill oldest first. */
export async function clubScan(orderId: string, operator: { readonly id: string }, command: QcCommand) {
  const club = (await loadClubs(false)).get(orderGid(orderId))
  if (!club) throw new Error('This order is no longer clubbed. Go back to the order list and open it again.')
  const client = new ShopifyClient()
  const db = supabaseServer()
  const read = async (): Promise<ClubSession[]> => {
    const { data, error } = await db.from('qc_sessions').select('id,order_id,status,generation,counts,snapshot').eq('shop_domain', client.config.storeDomain).in('order_id', club.ids)
    if (error) throw new Error('QC could not read the club. Retry the same request.')
    const rows = (data ?? []) as ClubSession[]
    return club.ids.flatMap(id => rows.filter(row => row.order_id === id))
  }
  let sessions = await read()
  // A member nobody has opened yet has no checklist: create it before choosing.
  const unseen = club.ids.filter(id => !sessions.some(s => s.order_id === id))
  if (unseen.length) { await Promise.all(unseen.map(id => loadQcView(id, operator))); sessions = await read() }
  // A retry of a request whose answer was lost must land on the order it counted in the first time (dedupe is per checklist).
  const prior = await db.from('qc_events').select('session_id').eq('request_id', command.requestId).in('session_id', sessions.map(s => s.id)).limit(1)
  if (prior.error) throw new Error('QC could not read the club. Retry the same request.')
  const replayOf = sessions.find(s => s.id === prior.data?.[0]?.session_id)
  const target = replayOf ?? pickScanTarget(sessions, (await resolveQcCode(client, command.code!)).variantId)
  if (!target) throw new Error('This club has no checklist to scan into. Reload the page.')
  return loadQcView(target.order_id, operator, { ...command, expectedGeneration: target.generation })
}
