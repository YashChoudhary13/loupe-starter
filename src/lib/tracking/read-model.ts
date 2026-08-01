import 'server-only'

import { signKeys } from '@/lib/console/images'
import { startOfKolkataDayIso } from '@/lib/console/queue-view'
import { loadDuplicateCandidates } from '@/lib/duplicates/read-model'
import { supabaseServer } from '@/lib/supabase/server'

import { classifyDraft, classifyIntake } from './classify'
import { draftCoverKeys, preferredThumbKey } from './thumbs'
import type {
  ReconciliationSummary,
  TrackingEvent,
  TrackingRow,
  TrackingSnapshot,
} from './types'

interface IntakeRow {
  id: string
  drive_file_id: string
  filename: string
  status: string
  attempts: number
  last_error: string | null
  last_error_code: string | null
  last_error_detail: string | null
  error_class: string | null
  lease_expires_at: string | null
  discovered_at: string
  updated_at: string
  product_draft_id: string | null
  description_cost_usd: string | number | null
}

interface DraftRow {
  id: string
  status: string
  updated_at: string
  reserved_sku: string | null
  error: string | null
  publish_lease_expires_at: string | null
}

interface EventRow {
  id: number
  entity_id: string | null
  event: string
  detail: unknown
  actor: string | null
  created_at: string
}

interface VersionRow {
  intake_file_id: string
  version_no: number
  is_selected: boolean
  thumb_key: string | null
  /** Set once retention has deleted the R2 object. The key still reads. */
  purged_at: string | null
  /** numeric(12,6) arrives from PostgREST as a string. */
  cost_usd: string | number | null
}

/** A draft's cover photograph, via the operator's own image order. */
interface DraftImageRow {
  product_draft_id: string
  position: number
  image_versions: { thumb_key: string | null; purged_at: string | null } | null
}

interface ReconciliationRunRow {
  id: string
  status: 'running' | 'completed' | 'failed'
  started_at: string
  completed_at: string | null
  total_products: number
  matched_products: number
  issue_count: number
  error: string | null
}

interface ReconciliationIssueRow {
  id: number
  run_id: string
  product_draft_id: string
  shopify_product_id: string | null
  code: string
  field: string
  expected: unknown
  actual: unknown
  message: string
  created_at: string
}

function safeDetail(value: unknown, maxLength = 2_000): string {
  const blocked = /^(access_?token|authorization|secret|api_?key|signed_?url)$/i
  let text: string
  try {
    text = JSON.stringify(value, (key, item) => (blocked.test(key) ? '[redacted]' : item), 2)
  } catch {
    text = String(value)
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

function eventMap(rows: readonly EventRow[]): Map<string, TrackingEvent[]> {
  const map = new Map<string, TrackingEvent[]>()
  for (const row of rows) {
    if (!row.entity_id) continue
    const list = map.get(row.entity_id) ?? []
    list.push({
      id: row.id,
      event: row.event,
      createdAt: row.created_at,
      actor: row.actor,
      detail: safeDetail(row.detail, 1_200),
    })
    map.set(row.entity_id, list)
  }
  return map
}

function preferredThumb(rows: readonly VersionRow[]): string | null {
  return preferredThumbKey(
    rows.map((row) => ({
      versionNo: row.version_no,
      isSelected: row.is_selected,
      thumbKey: row.thumb_key,
      purgedAt: row.purged_at,
    })),
  )
}

function reconciliationSummary(row: ReconciliationRunRow | undefined): ReconciliationSummary | null {
  return row
    ? {
        id: row.id,
        status: row.status,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        totalProducts: row.total_products,
        matchedProducts: row.matched_products,
        issueCount: row.issue_count,
        error: row.error,
      }
    : null
}

export async function loadTracking(): Promise<TrackingSnapshot> {
  const db = supabaseServer()
  const now = Date.now()
  const startOfToday = startOfKolkataDayIso(new Date(now))

  const [
    intakesResult,
    draftsResult,
    runsResult,
    uploadedResult,
    listedResult,
    ungroupedResult,
    openDraftsResult,
    duplicateCandidates,
  ] = await Promise.all([
    db
      .from('intake_files')
      .select(
        'id, drive_file_id, filename, status, attempts, last_error, last_error_code, last_error_detail, error_class, lease_expires_at, discovered_at, updated_at, product_draft_id, description_cost_usd',
      )
      .order('updated_at', { ascending: false })
      .limit(500),
    db
      .from('product_drafts')
      .select('id, status, updated_at, reserved_sku, error, publish_lease_expires_at')
      .in('status', ['assembling', 'publishing', 'failed'])
      .order('updated_at', { ascending: false })
      .limit(300),
    db
      .from('shopify_reconciliation_runs')
      .select(
        'id, status, started_at, completed_at, total_products, matched_products, issue_count, error',
      )
      .order('started_at', { ascending: false })
      .limit(10),
    db
      .from('intake_files')
      .select('id', { count: 'exact', head: true })
      .gte('discovered_at', startOfToday),
    db
      .from('product_drafts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'published')
      .gte('published_at', startOfToday),
    db
      .from('intake_files')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'enhanced')
      .is('product_draft_id', null),
    db
      .from('product_drafts')
      .select('id', { count: 'exact', head: true })
      .in('status', ['assembling', 'publishing', 'failed']),
    loadDuplicateCandidates(),
  ])

  for (const [label, error] of [
    ['tracking intake', intakesResult.error],
    ['tracking drafts', draftsResult.error],
    ['reconciliation runs', runsResult.error],
    ['uploaded count', uploadedResult.error],
    ['listed count', listedResult.error],
    ['ungrouped count', ungroupedResult.error],
    ['open draft count', openDraftsResult.error],
  ] as const) {
    if (error) throw new Error(`${label}: ${error.message}`)
  }

  const intakes = (intakesResult.data ?? []) as IntakeRow[]
  const drafts = (draftsResult.data ?? []) as DraftRow[]
  const runs = (runsResult.data ?? []) as ReconciliationRunRow[]
  const latestRun = runs[0]
  const duplicateByIntake = new Map(
    duplicateCandidates.map((candidate) => [candidate.intakeFileId, candidate]),
  )

  const latestIssuesResult = latestRun
    ? await db
        .from('shopify_reconciliation_issues')
        .select(
          'id, run_id, product_draft_id, shopify_product_id, code, field, expected, actual, message, created_at',
        )
        .eq('run_id', latestRun.id)
        .order('product_draft_id', { ascending: true })
        .order('field', { ascending: true })
        .limit(500)
    : { data: [], error: null }
  if (latestIssuesResult.error) {
    throw new Error(`reconciliation issues: ${latestIssuesResult.error.message}`)
  }
  const issues = (latestIssuesResult.data ?? []) as ReconciliationIssueRow[]

  const entityIds = [
    ...intakes.map((row) => row.id),
    ...drafts.map((row) => row.id),
    ...runs.map((row) => row.id),
  ]
  // Drafts on screen, plus the drafts a Shopify mismatch points at — those are
  // published, so they are not in the draft query above.
  const draftIdsNeedingCover = [
    ...new Set([...drafts.map((row) => row.id), ...issues.map((issue) => issue.product_draft_id)]),
  ]
  const [eventsResult, versionsResult, draftImagesResult] = await Promise.all([
    entityIds.length
      ? db
          .from('events')
          .select('id, entity_id, event, detail, actor, created_at')
          .in('entity_id', entityIds)
          .order('created_at', { ascending: false })
          .limit(2_000)
      : Promise.resolve({ data: [], error: null }),
    intakes.length
      ? db
          .from('image_versions')
          .select('intake_file_id, version_no, is_selected, thumb_key, purged_at, cost_usd')
          .in('intake_file_id', intakes.map((row) => row.id))
      : Promise.resolve({ data: [], error: null }),
    draftIdsNeedingCover.length
      ? db
          .from('product_draft_images')
          .select('product_draft_id, position, image_versions ( thumb_key, purged_at )')
          .in('product_draft_id', draftIdsNeedingCover)
          .order('position', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
  ])
  if (eventsResult.error) throw new Error(`tracking events: ${eventsResult.error.message}`)
  if (versionsResult.error) throw new Error(`tracking thumbnails: ${versionsResult.error.message}`)
  if (draftImagesResult.error) {
    throw new Error(`tracking draft covers: ${draftImagesResult.error.message}`)
  }

  const events = eventMap((eventsResult.data ?? []) as EventRow[])
  const versionsByIntake = new Map<string, VersionRow[]>()
  for (const row of (versionsResult.data ?? []) as VersionRow[]) {
    const list = versionsByIntake.get(row.intake_file_id) ?? []
    list.push(row)
    versionsByIntake.set(row.intake_file_id, list)
  }
  const thumbKeyByIntake = new Map(
    intakes.map((intake) => [
      intake.id,
      preferredThumb(versionsByIntake.get(intake.id) ?? []),
    ]),
  )

  const thumbKeyByDraft = draftCoverKeys(
    ((draftImagesResult.data ?? []) as unknown as DraftImageRow[]).map((row) => ({
      draftId: row.product_draft_id,
      position: row.position,
      thumbKey: row.image_versions?.thumb_key ?? null,
      purgedAt: row.image_versions?.purged_at ?? null,
    })),
  )

  const signed = await signKeys([...thumbKeyByIntake.values(), ...thumbKeyByDraft.values()])

  /**
   * PostgREST returns numeric(12,6) as a string to avoid float rounding. Parse
   * defensively: an unreadable figure must not silently become 0, which would
   * under-report spend against the ~₹5,000/month budget.
   */
  function usd(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined) return null
    const parsed = typeof value === 'string' ? Number(value) : value
    return Number.isFinite(parsed) ? parsed : null
  }

  /** Description + every generated image for this photograph, redos included. */
  function totalCostFor(intake: IntakeRow): number | null {
    const parts = [
      usd(intake.description_cost_usd),
      ...(versionsByIntake.get(intake.id) ?? []).map((version) => usd(version.cost_usd)),
    ].filter((part): part is number => part !== null)
    if (parts.length === 0) return null
    // Sum in micro-dollars: numeric(12,6) is exact to 6dp, and adding floats
    // gives 0.07362399999999999 in the operator's face.
    return parts.reduce((total, part) => total + Math.round(part * 1_000_000), 0) / 1_000_000
  }

  /**
   * A photograph that belongs to a product draft is NOT listed separately.
   * The draft already represents it, and listing both showed the same piece of
   * work twice — once as "Draft" (the photograph, grouped) and again as
   * "Draft" (the product). One unit of work, one row.
   */
  const intakeRows: TrackingRow[] = intakes
    .filter((row) => row.product_draft_id === null)
    .map((row) => {
    const duplicate = duplicateByIntake.get(row.id)
    const classification = classifyIntake(
      {
        status: row.status,
        discoveredAt: row.discovered_at,
        productDraftId: row.product_draft_id,
        lastError: row.last_error,
        errorClass: row.error_class,
        leaseExpiresAt: row.lease_expires_at,
      },
      now,
      duplicate?.matchFilename,
    )
    const thumbKey = thumbKeyByIntake.get(row.id)
    return {
      rowId: `intake:${row.id}`,
      kind: 'intake',
      entityId: row.id,
      label: row.filename,
      statusLabel: classification.statusLabel,
      tone: classification.tone,
      group: classification.group,
      occurredAt: row.updated_at,
      reason: classification.reason,
      errorCode: row.last_error_code,
      errorClass: row.error_class,
      rawDetail: row.last_error_detail?.slice(0, 2_000) ?? null,
      thumb: (thumbKey ? signed.get(thumbKey) : null) ?? null,
      events: events.get(row.id) ?? [],
      canRetry: row.status === 'failed' && row.error_class === 'retryable',
      // Held work is the operator's to pick back up or throw away. Both are
      // refused in SQL for anything grouped, published or in flight.
      canResume: row.status === 'skipped',
      canDiscard: row.status === 'skipped' && row.product_draft_id === null,
      canSkip:
        row.product_draft_id === null &&
        !['enhancing', 'grouped', 'published', 'duplicate', 'skipped'].includes(row.status),
      consoleHref: row.product_draft_id
        ? `/console/drafts/${row.product_draft_id}`
        : row.status === 'enhanced'
          ? '/console'
          : null,
      costUsd: totalCostFor(row),
      driveHref: `https://drive.google.com/open?id=${encodeURIComponent(row.drive_file_id)}`,
      duplicate: duplicate
        ? {
            matchIntakeFileId: duplicate.matchIntakeFileId,
            matchFilename: duplicate.matchFilename,
            distance: duplicate.distance,
            canMarkDuplicate:
              row.product_draft_id === null && ['enhanced', 'failed'].includes(row.status),
          }
        : null,
    }
  })

  const draftRows: TrackingRow[] = drafts.map((row) => {
    const classification = classifyDraft(
      {
        status: row.status,
        updatedAt: row.updated_at,
        error: row.error,
        publishLeaseExpiresAt: row.publish_lease_expires_at,
      },
      now,
    )
    return {
      rowId: `draft:${row.id}`,
      kind: 'draft',
      entityId: row.id,
      label: row.reserved_sku ?? 'Product draft',
      statusLabel: classification.statusLabel,
      tone: classification.tone,
      group: classification.group,
      occurredAt: row.updated_at,
      reason: classification.reason,
      errorCode: row.status === 'failed' ? 'publish_failed' : null,
      errorClass: row.status === 'failed' ? 'operator' : null,
      rawDetail: row.error?.slice(0, 2_000) ?? null,
      thumb: signed.get(thumbKeyByDraft.get(row.id) ?? '') ?? null,
      events: events.get(row.id) ?? [],
      canRetry: false,
      canSkip: false,
      canResume: false,
      canDiscard: false,
      consoleHref: `/console/drafts/${row.id}`,
      driveHref: null,
      duplicate: null,
      // Not a billed photograph — cost is recorded per source photograph.
      costUsd: null,
    }
  })

  const issueRows: TrackingRow[] = issues.map((issue) => ({
    rowId: `reconciliation:${issue.id}`,
    kind: 'reconciliation',
    entityId: issue.run_id,
    label: issue.shopify_product_id ?? `Draft ${issue.product_draft_id.slice(0, 8)}`,
    statusLabel: 'Shopify mismatch',
    tone: 'mismatch',
    group: 'attention',
    occurredAt: issue.created_at,
    reason: issue.message,
    errorCode: issue.code,
    errorClass: 'reconciliation',
    rawDetail: safeDetail({ field: issue.field, expected: issue.expected, actual: issue.actual }),
    // Published seven days or more ago and the R2 objects are gone (D5) — the
    // row keeps its audit trail and the square stays blank.
    thumb: signed.get(thumbKeyByDraft.get(issue.product_draft_id) ?? '') ?? null,
    events: events.get(issue.run_id) ?? [],
    canRetry: false,
    canSkip: false,
    canResume: false,
    canDiscard: false,
    consoleHref: `/console/drafts/${issue.product_draft_id}`,
    driveHref: null,
    duplicate: null,
    costUsd: null,
  }))

  if (latestRun?.status === 'failed' && issues.length === 0) {
    issueRows.unshift({
      rowId: `reconciliation-run:${latestRun.id}`,
      kind: 'reconciliation',
      entityId: latestRun.id,
      label: 'Shopify reconciliation',
      statusLabel: 'Check failed',
      tone: 'failed',
      group: 'attention',
      occurredAt: latestRun.completed_at ?? latestRun.started_at,
      reason: latestRun.error ?? 'The Shopify read-back did not complete.',
      errorCode: 'reconciliation_failed',
      errorClass: 'reconciliation',
      rawDetail: latestRun.error,
      thumb: null,
      events: events.get(latestRun.id) ?? [],
      canRetry: false,
      canSkip: false,
      canResume: false,
      canDiscard: false,
      consoleHref: null,
      driveHref: null,
      duplicate: null,
      costUsd: null,
    })
  }

  const rows = [...issueRows, ...draftRows, ...intakeRows].sort((a, b) => {
    const groupRank = { attention: 0, draft: 1, progress: 2, complete: 3 } as const
    return (
      groupRank[a.group] - groupRank[b.group] ||
      b.occurredAt.localeCompare(a.occurredAt)
    )
  })
  const expiries = rows
    .map((row) => row.thumb?.expiresAt)
    .filter((value): value is number => typeof value === 'number')

  return {
    uploadedToday: uploadedResult.count ?? 0,
    listedToday: listedResult.count ?? 0,
    attentionCount: rows.filter((row) => row.group === 'attention').length,
    inQueueCount: (ungroupedResult.count ?? 0) + (openDraftsResult.count ?? 0),
    rows,
    latestReconciliation: reconciliationSummary(latestRun),
    generatedAt: new Date(now).toISOString(),
    signedUntil: expiries.length ? Math.min(...expiries) : now + 15 * 60 * 1000,
  }
}

export async function loadTrackingAttentionCount(): Promise<number> {
  return (await loadTracking()).attentionCount
}
