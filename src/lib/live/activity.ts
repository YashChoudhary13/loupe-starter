import 'server-only'

import { supabaseServer } from '@/lib/supabase/server'

import type { LiveActivityEvent, LiveActivitySnapshot } from './types'

interface EventRow {
  id: number
  entity_type: string
  entity_id: string | null
  event: string
  created_at: string
}

const EVENT_BATCH_LIMIT = 100

/**
 * Small, image-free heartbeat for every signed-in screen.
 *
 * The audit id is monotonic, so this cannot miss a fast start-and-finish cycle
 * the way polling only the current queue totals can. Full queue/tracking reads
 * happen only when one of these transitions materially changes that screen.
 */
export async function loadLiveActivity(
  afterEventId: number | null,
): Promise<LiveActivitySnapshot> {
  const db = supabaseServer()
  const hasCursor = afterEventId !== null

  const eventsQuery = hasCursor
    ? db
        .from('events')
        .select('id, entity_type, entity_id, event, created_at')
        .gt('id', afterEventId)
        .order('id', { ascending: true })
        .limit(EVENT_BATCH_LIMIT)
    : db
        .from('events')
        .select('id, entity_type, entity_id, event, created_at')
        .order('id', { ascending: false })
        .limit(1)

  const [eventsResult, queuedResult, enhancingResult] = await Promise.all([
    eventsQuery,
    db.from('intake_files').select('id', { count: 'exact', head: true }).eq('status', 'discovered'),
    db.from('intake_files').select('id', { count: 'exact', head: true }).eq('status', 'enhancing'),
  ])

  if (eventsResult.error) throw new Error(`live events: ${eventsResult.error.message}`)
  if (queuedResult.error) throw new Error(`live queued count: ${queuedResult.error.message}`)
  if (enhancingResult.error) throw new Error(`live enhancing count: ${enhancingResult.error.message}`)

  const rows = (eventsResult.data ?? []) as EventRow[]
  const events: LiveActivityEvent[] = hasCursor
    ? rows.map((row) => ({
        id: row.id,
        entityType: row.entity_type,
        entityId: row.entity_id,
        event: row.event,
        occurredAt: row.created_at,
      }))
    : []
  const newest = rows.reduce<number | null>(
    (highest, row) => (highest === null || row.id > highest ? row.id : highest),
    afterEventId,
  )

  return {
    revision: newest,
    queued: queuedResult.count ?? 0,
    enhancing: enhancingResult.count ?? 0,
    events,
    generatedAt: new Date().toISOString(),
  }
}
