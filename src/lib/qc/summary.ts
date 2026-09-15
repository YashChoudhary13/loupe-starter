import type { QcEvent, QcSession } from './types'

export interface QcMissing {
  lineId: string
  title: string
  variantTitle: string | null
  required: number
  checked: number
  remaining: number
}

export interface QcExtra {
  eventId: string
  code: string | null
  variantId: string | null
  title: string
  kind: 'extra' | 'wrong'
  removed: boolean
}

function extraTitle(session: QcSession, event: QcEvent): string {
  const line = session.snapshot.lines.find(item => item.id === event.line_id || (event.variant_id != null && item.variantId === event.variant_id))
  if (line) return line.variantTitle ? `${line.title} · ${line.variantTitle}` : line.title
  return event.code || 'Unlabelled extra item'
}

/** Missing ordered units and extras that still need a removed tick. */
export function summarizeQc(session: QcSession, events: QcEvent[]): { missing: QcMissing[]; extras: QcExtra[]; openExtras: QcExtra[]; canPass: boolean } {
  const missing = session.snapshot.lines.flatMap(line => {
    const checked = session.counts[line.id] ?? 0
    if (checked >= line.required) return []
    return [{ lineId: line.id, title: line.title, variantTitle: line.variantTitle, required: line.required, checked, remaining: line.required - checked }]
  })
  const removed = new Set(events.filter(event => event.action === 'clear_extra' && event.outcome === 'removed' && event.undo_of).map(event => event.undo_of))
  const extras = events.filter(event => event.generation === session.generation && (event.outcome === 'extra' || event.outcome === 'wrong')).map(event => ({
    eventId: event.id,
    code: event.code,
    variantId: event.variant_id,
    title: extraTitle(session, event),
    kind: event.outcome as 'extra' | 'wrong',
    removed: removed.has(event.id),
  }))
  const openExtras = extras.filter(item => !item.removed)
  return { missing, extras, openExtras, canPass: missing.length === 0 && openExtras.length === 0 && session.snapshot.lines.length > 0 }
}
