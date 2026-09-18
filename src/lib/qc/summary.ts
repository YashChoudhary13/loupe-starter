import type { QcEvent, QcSession, QcShortage } from './types'

export interface QcMissing {
  lineId: string
  title: string
  variantTitle: string | null
  required: number
  checked: number
  /** Units already accepted as short on this line. */
  short: number
  /** Units neither scanned nor marked short. */
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

/** Missing ordered units, accepted shortages, and extras that still need a removed tick. */
export function summarizeQc(session: QcSession, events: QcEvent[], shortages: readonly QcShortage[] = []): { missing: QcMissing[]; extras: QcExtra[]; openExtras: QcExtra[]; shortByLine: Record<string, number>; canPass: boolean } {
  const shortByLine: Record<string, number> = {}
  for (const shortage of shortages) {
    if (shortage.generation === session.generation && shortage.resolved_at === null) shortByLine[shortage.line_id] = (shortByLine[shortage.line_id] ?? 0) + shortage.quantity
  }
  const missing = session.snapshot.lines.flatMap(line => {
    const checked = session.counts[line.id] ?? 0
    const short = shortByLine[line.id] ?? 0
    if (checked + short >= line.required) return []
    return [{ lineId: line.id, title: line.title, variantTitle: line.variantTitle, required: line.required, checked, short, remaining: line.required - checked - short }]
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
  return { missing, extras, openExtras, shortByLine, canPass: missing.length === 0 && openExtras.length === 0 && session.snapshot.lines.length > 0 }
}
