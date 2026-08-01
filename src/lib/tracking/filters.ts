import type { TrackingRow, TrackingView } from './types'

export interface TrackingFilters {
  readonly view: TrackingView
  readonly status: 'any' | 'failed' | 'stalled' | 'running' | 'mismatch' | 'complete'
  readonly error: string
  readonly age: 'any' | '1h' | '24h'
  readonly search: string
}

export function filterTrackingRows(
  rows: readonly TrackingRow[],
  filters: TrackingFilters,
  now: number,
): readonly TrackingRow[] {
  const search = filters.search.trim().toLocaleLowerCase()
  const minimumAge =
    filters.age === '24h' ? 24 * 60 * 60 * 1000 : filters.age === '1h' ? 60 * 60 * 1000 : 0

  return rows.filter((row) => {
    if (filters.view === 'attention' && row.group !== 'attention') return false
    if (filters.view === 'draft' && row.group !== 'draft') return false
    if (filters.view === 'progress' && row.group !== 'progress') return false
    if (filters.status !== 'any' && row.tone !== filters.status) return false
    if (filters.error && row.errorCode !== filters.error) return false
    if (minimumAge && now - new Date(row.occurredAt).getTime() < minimumAge) return false
    if (
      search &&
      !`${row.label} ${row.reason} ${row.errorCode ?? ''}`.toLocaleLowerCase().includes(search)
    ) {
      return false
    }
    return true
  })
}
