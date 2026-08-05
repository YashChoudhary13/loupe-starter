export const LIVE_ACTIVITY_EVENT = 'loupe:live-activity'

export interface LiveActivityEvent {
  readonly id: number
  readonly entityType: string
  readonly entityId: string | null
  readonly event: string
  readonly occurredAt: string
}

export interface LiveActivitySnapshot {
  /** Highest audit-event id observed by this browser. */
  readonly revision: number | null
  /** Waiting for an enhancement worker, including bounded retry backoff. */
  readonly queued: number
  /** Currently leased by an enhancement worker. */
  readonly enhancing: number
  /** Audit transitions since the caller's previous revision. */
  readonly events: readonly LiveActivityEvent[]
  readonly generatedAt: string
}

export interface LiveActivityUpdate {
  /** True only for a new tab with no prior session cursor. */
  readonly initial: boolean
  readonly snapshot: LiveActivitySnapshot
}

export type LiveNoticeTone = 'progress' | 'ready' | 'attention'

export interface LiveNotice {
  readonly key: string
  readonly text: string
  readonly tone: LiveNoticeTone
  readonly href: '/console' | '/tracking'
}

const CONSOLE_REFRESH_EVENTS = new Set([
  'intake.enhanced',
  'intake.manual_uploaded',
  'intake.grouped',
  'intake.ungrouped',
  'intake.ungrouped_after_shopify_delete',
  'intake.published',
  'intake.discarded',
  'intake.console_delete_requested',
  'duplicate.reviewed',
  'image.redo_completed',
  'draft.created',
  'draft.saved',
  'draft.deleted_after_shopify_delete',
  'publish.failed',
  'publish.published',
])

const TRACKING_INTAKE_EVENTS = new Set([
  'intake.discovered',
  'intake.manual_uploaded',
  'intake.claimed',
  'intake.retry_scheduled',
  'description.retry_scheduled',
  'intake.enhanced',
  'intake.failed',
  'intake.rejected',
  'intake.skipped',
  'intake.resumed',
  'intake.retry_requested',
  'intake.discarded',
  'intake.grouped',
  'intake.ungrouped',
  'intake.ungrouped_after_shopify_delete',
  'intake.published',
  'intake.lease_expired',
  'intake.lease_invalidated',
  'intake.paused_provider_quota',
  'intake.provider_quota_resumed',
  'duplicate.reviewed',
])

export function shouldRefreshConsole(events: readonly LiveActivityEvent[]): boolean {
  return events.some((event) => CONSOLE_REFRESH_EVENTS.has(event.event))
}

export function shouldRefreshTracking(events: readonly LiveActivityEvent[]): boolean {
  return events.some(
    (event) =>
      TRACKING_INTAKE_EVENTS.has(event.event) ||
      event.event.startsWith('draft.') ||
      event.event.startsWith('publish.') ||
      event.event.startsWith('shopify.reconciliation_') ||
      event.event === 'image.redo_completed' ||
      event.event === 'image.redo_failed' ||
      event.event === 'image.redo_cost_ceiling_failed',
  )
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm
}

/**
 * Turn a burst of low-level audit transitions into a few calm operator messages.
 * Entity ids let a fast discover -> claim -> finish cycle become one useful
 * message instead of three notifications for the same photograph.
 */
export function noticesForLiveEvents(events: readonly LiveActivityEvent[]): readonly LiveNotice[] {
  const discovered = new Set<string>()
  const claimed = new Set<string>()
  const ready = new Set<string>()
  const failed = new Set<string>()
  const providerPaused = new Set<string>()
  let redoReady = 0
  let redoFailed = 0

  for (const item of events) {
    const id = item.entityId ?? `event:${item.id}`
    if (item.event === 'intake.discovered') discovered.add(id)
    if (item.event === 'intake.claimed') claimed.add(id)
    if (item.event === 'intake.enhanced' || item.event === 'intake.manual_uploaded') ready.add(id)
    if (item.event === 'intake.failed' || item.event === 'intake.rejected') failed.add(id)
    if (item.event === 'intake.paused_provider_quota') providerPaused.add(id)
    if (item.event === 'image.redo_completed') redoReady += 1
    if (item.event === 'image.redo_failed' || item.event === 'image.redo_cost_ceiling_failed') {
      redoFailed += 1
    }
  }

  const notices: LiveNotice[] = []
  if (providerPaused.size > 0) {
    notices.push({
      key: `provider-paused:${events.at(-1)?.id ?? 0}`,
      text: `${providerPaused.size} ${plural(providerPaused.size, 'photo')} paused — provider credits required`,
      tone: 'attention',
      href: '/tracking',
    })
  }
  const failedCount = failed.size + redoFailed
  if (failedCount > 0) {
    notices.push({
      key: `failed:${events.at(-1)?.id ?? 0}`,
      text: `${failedCount} ${plural(failedCount, 'process', 'processes')} ${
        failedCount === 1 ? 'needs' : 'need'
      } attention`,
      tone: 'attention',
      href: '/tracking',
    })
  }

  const newlyReady = [...ready].filter((id) => discovered.has(id)).length
  const readyCount = ready.size - newlyReady + redoReady
  if (newlyReady > 0) {
    notices.push({
      key: `new-ready:${events.at(-1)?.id ?? 0}`,
      text: `${newlyReady} new ${plural(newlyReady, 'photo')} enhanced and ready`,
      tone: 'ready',
      href: '/console',
    })
  }
  if (readyCount > 0) {
    notices.push({
      key: `ready:${events.at(-1)?.id ?? 0}`,
      text: `${readyCount} ${plural(readyCount, 'photo')} enhanced and ready`,
      tone: 'ready',
      href: '/console',
    })
  }

  const newInProgress = [...discovered].filter(
    (id) => !ready.has(id) && !failed.has(id) && claimed.has(id),
  ).length
  const receivedOnly = [...discovered].filter(
    (id) => !ready.has(id) && !failed.has(id) && !claimed.has(id),
  ).length
  const claimedOnly = [...claimed].filter(
    (id) => !discovered.has(id) && !ready.has(id) && !failed.has(id),
  ).length

  if (newInProgress > 0) {
    notices.push({
      key: `new-processing:${events.at(-1)?.id ?? 0}`,
      text: `${newInProgress} new ${plural(newInProgress, 'photo')} received — enhancing now`,
      tone: 'progress',
      href: '/tracking',
    })
  }
  if (receivedOnly > 0) {
    notices.push({
      key: `received:${events.at(-1)?.id ?? 0}`,
      text: `${receivedOnly} new ${plural(receivedOnly, 'photo')} added to the queue`,
      tone: 'progress',
      href: '/tracking',
    })
  }
  if (claimedOnly > 0) {
    notices.push({
      key: `processing:${events.at(-1)?.id ?? 0}`,
      text: `Enhancing ${claimedOnly} ${plural(claimedOnly, 'photo')}`,
      tone: 'progress',
      href: '/tracking',
    })
  }

  return notices
}
