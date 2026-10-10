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
  /** Work needing a human — feeds the sidebar badge between full page loads. */
  readonly attention: number
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
  'intake.original_selected',
  'intake.reenhance_requested',
  'intake.agent_replaced',
  'intake.grouped',
  'intake.ungrouped',
  'intake.ungrouped_after_shopify_delete',
  'intake.published',
  'intake.discarded',
  'intake.console_delete_requested',
  'duplicate.reviewed',
  'draft.created',
  'draft.saved',
  'draft.deleted_after_shopify_delete',
  /**
   * Save draft answers instantly now; the Shopify DRAFT push finishes in the
   * background. These two events are how the console learns the reserved SKU
   * arrived (synced) or that the push needs a retry (failed).
   */
  'draft.shopify_synced',
  'draft.shopify_push_failed',
  'draft.labels_printed',
  'publish.failed',
  'publish.published',
])

const TRACKING_INTAKE_EVENTS = new Set([
  'intake.discovered',
  'intake.manual_uploaded',
  'intake.original_selected',
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
  'duplicate.reviewed',
])

export function shouldRefreshConsole(events: readonly LiveActivityEvent[]): boolean {
  return events.some((event) => CONSOLE_REFRESH_EVENTS.has(event.event))
}

/** D110: the Identify and Restock screens follow every matcher transition. */
export function shouldRefreshIdentify(events: readonly LiveActivityEvent[]): boolean {
  return events.some((event) => event.event.startsWith('match.') || event.event === 'intake.discovered')
}

export function shouldRefreshTracking(events: readonly LiveActivityEvent[]): boolean {
  return events.some(
    (event) =>
      TRACKING_INTAKE_EVENTS.has(event.event) ||
      event.event.startsWith('draft.') ||
      event.event.startsWith('publish.') ||
      event.event.startsWith('shopify.reconciliation_'),
  )
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm
}

/**
 * Turn a burst of low-level audit transitions into a few calm operator messages.
 * Entity ids let repeated events for one photograph become one message.
 * (D144: no queue or worker to report on; arrivals are deliveries.)
 */
export function noticesForLiveEvents(events: readonly LiveActivityEvent[]): readonly LiveNotice[] {
  const ready = new Set<string>()
  const failed = new Set<string>()
  const shopifyPushFailed = new Set<string>()

  for (const item of events) {
    const id = item.entityId ?? `event:${item.id}`
    if (
      item.event === 'intake.enhanced' ||
      item.event === 'intake.manual_uploaded' ||
      item.event === 'intake.original_selected'
    ) {
      ready.add(id)
    }
    if (item.event === 'intake.failed' || item.event === 'intake.rejected') failed.add(id)
    if (item.event === 'draft.shopify_push_failed') shopifyPushFailed.add(id)
    // A later successful sync of the same draft withdraws the warning.
    if (item.event === 'draft.shopify_synced') shopifyPushFailed.delete(id)
  }

  const notices: LiveNotice[] = []
  if (shopifyPushFailed.size > 0) {
    notices.push({
      key: `shopify-push-failed:${events.at(-1)?.id ?? 0}`,
      text: `${shopifyPushFailed.size} ${plural(shopifyPushFailed.size, 'draft')} could not reach Shopify — open to retry`,
      tone: 'attention',
      href: '/console',
    })
  }
  if (failed.size > 0) {
    notices.push({
      key: `failed:${events.at(-1)?.id ?? 0}`,
      text: `${failed.size} ${plural(failed.size, 'process', 'processes')} ${failed.size === 1 ? 'needs' : 'need'} attention`,
      tone: 'attention',
      href: '/tracking',
    })
  }
  if (ready.size > 0) {
    notices.push({
      key: `ready:${events.at(-1)?.id ?? 0}`,
      text: `${ready.size} ${plural(ready.size, 'photo')} ready in the console`,
      tone: 'ready',
      href: '/console',
    })
  }
  return notices
}
