import 'server-only'

import { signKeys } from '@/lib/console/images'
import { startOfKolkataDayIso } from '@/lib/console/queue-view'
import { loadDuplicateCandidates } from '@/lib/duplicates/read-model'
import { supabaseServer } from '@/lib/supabase/server'

import { classifyDraft, classifyIntake } from './classify'
import { sumUsd, usd } from './cost'
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
  provider_paused_at: string | null
  provider_pause_code: string | null
  provider_pause_message: string | null
  provider_pause_detail: string | null
  discovered_at: string
  updated_at: string
  enhanced_at: string | null
  described_at: string | null
  product_draft_id: string | null
  description_cost_usd: string | number | null
}

interface RedoJobRow {
  id: string
  intake_file_id: string
  status: string
  version_no: number
  model: string
  created_at: string
  updated_at: string
  generation_started_at: string | null
  intake_files: { filename: string; product_draft_id: string | null } | null
}

/** Draft membership fetched independently of the intake recency window. */
interface DraftIntakeRow {
  id: string
  product_draft_id: string
  description_cost_usd: string | number | null
}

interface DraftRow {
  id: string
  status: string
  updated_at: string
  reserved_sku: string | null
  error: string | null
  publish_lease_expires_at: string | null
  shopify_product_id: string | null
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

/**
 * The identity of one reconciliation FINDING, stable across runs.
 *
 * `JSON.stringify` is safe as a key here because both sides come from the same
 * jsonb column via the same client, so key order is Postgres's and matches.
 */
function reconciliationKey(
  draftId: string,
  code: string,
  field: string,
  actual: unknown,
): string {
  return `${draftId}\u0000${code}\u0000${field}\u0000${JSON.stringify(actual ?? null)}`
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
    redoJobsResult,
    duplicateCandidates,
  ] = await Promise.all([
    db
      .from('intake_files')
      .select(
        'id, drive_file_id, filename, status, attempts, last_error, last_error_code, last_error_detail, error_class, lease_expires_at, provider_paused_at, provider_pause_code, provider_pause_message, provider_pause_detail, discovered_at, updated_at, enhanced_at, described_at, product_draft_id, description_cost_usd',
      )
      .order('updated_at', { ascending: false })
      .limit(500),
    db
      .from('product_drafts')
      .select('id, status, updated_at, reserved_sku, error, publish_lease_expires_at, shopify_product_id')
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
    db
      .from('image_redo_jobs')
      .select(
        'id, intake_file_id, status, version_no, model, created_at, updated_at, generation_started_at, intake_files(filename, product_draft_id)',
      )
      .in('status', ['queued', 'processing'])
      .order('created_at', { ascending: false })
      .limit(100),
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
    ['redo jobs', redoJobsResult.error],
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
  const allIssues = (latestIssuesResult.data ?? []) as ReconciliationIssueRow[]

  /**
   * Findings the operator has already judged acceptable.
   *
   * Keyed on (draft, code, field, actual) rather than on the issue row id,
   * because issue rows are recreated from scratch by every run — deleting one
   * would clear Tracking until 03:00 and then the same finding would reappear.
   * `actual` is in the key on purpose: dismissing "AK089 carries RS229" accepts
   * that value, not the subject, so a different value later is new drift and
   * surfaces again. See D93.
   */
  const dismissalsResult = allIssues.length
    ? await db
        .from('shopify_reconciliation_dismissals')
        .select('product_draft_id, code, field, actual')
        .in('product_draft_id', [...new Set(allIssues.map((row) => row.product_draft_id))])
    : { data: [], error: null }
  if (dismissalsResult.error) {
    throw new Error(`reconciliation dismissals: ${dismissalsResult.error.message}`)
  }
  const dismissedKeys = new Set(
    (dismissalsResult.data ?? []).map((row) =>
      reconciliationKey(
        row.product_draft_id as string,
        row.code as string,
        row.field as string,
        row.actual,
      ),
    ),
  )
  const issues = allIssues.filter(
    (row) =>
      !dismissedKeys.has(reconciliationKey(row.product_draft_id, row.code, row.field, row.actual)),
  )

  const redoJobs = (redoJobsResult.data ?? []) as unknown as RedoJobRow[]

  const entityIds = [
    ...intakes.map((row) => row.id),
    ...drafts.map((row) => row.id),
    ...runs.map((row) => row.id),
    ...redoJobs.map((row) => row.id),
  ]
  // Drafts on screen, plus the drafts a Shopify mismatch points at — those are
  // published, so they are not in the draft query above.
  const draftIdsNeedingCover = [
    ...new Set([...drafts.map((row) => row.id), ...issues.map((issue) => issue.product_draft_id)]),
  ]
  const [eventsResult, versionsResult, draftImagesResult, draftIntakesResult] = await Promise.all([
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
    /**
     * Draft membership, independent of the 500-row recency window above. A draft
     * that has been sitting for a while can own photographs that fell out of
     * that window, and summing only what happened to be in it would under-report
     * the draft's spend without saying so.
     */
    draftIdsNeedingCover.length
      ? db
          .from('intake_files')
          .select('id, product_draft_id, description_cost_usd')
          .in('product_draft_id', draftIdsNeedingCover)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (eventsResult.error) throw new Error(`tracking events: ${eventsResult.error.message}`)
  if (versionsResult.error) throw new Error(`tracking thumbnails: ${versionsResult.error.message}`)
  if (draftImagesResult.error) {
    throw new Error(`tracking draft covers: ${draftImagesResult.error.message}`)
  }
  if (draftIntakesResult.error) {
    throw new Error(`tracking draft costs: ${draftIntakesResult.error.message}`)
  }

  const events = eventMap((eventsResult.data ?? []) as EventRow[])
  const draftIntakes = (draftIntakesResult.data ?? []) as DraftIntakeRow[]

  const versionsByIntake = new Map<string, VersionRow[]>()
  for (const row of (versionsResult.data ?? []) as VersionRow[]) {
    const list = versionsByIntake.get(row.intake_file_id) ?? []
    list.push(row)
    versionsByIntake.set(row.intake_file_id, list)
  }

  // Top-up: versions for draft photographs the recency window missed. Usually
  // empty, because active drafts are recent — but a draft's total must be the
  // whole total or nothing, never a quiet partial sum.
  const missingVersionIntakeIds = draftIntakes
    .map((row) => row.id)
    .filter((id) => !versionsByIntake.has(id))
  if (missingVersionIntakeIds.length > 0) {
    const extra = await db
      .from('image_versions')
      .select('intake_file_id, version_no, is_selected, thumb_key, purged_at, cost_usd')
      .in('intake_file_id', missingVersionIntakeIds)
    if (extra.error) throw new Error(`tracking draft costs: ${extra.error.message}`)
    for (const row of (extra.data ?? []) as VersionRow[]) {
      const list = versionsByIntake.get(row.intake_file_id) ?? []
      list.push(row)
      versionsByIntake.set(row.intake_file_id, list)
    }
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

  /** Description + every generated image for this photograph, redos included. */
  function totalCostFor(intake: Pick<IntakeRow, 'id' | 'description_cost_usd'>): number | null {
    return sumUsd([
      usd(intake.description_cost_usd),
      ...(versionsByIntake.get(intake.id) ?? []).map((version) => usd(version.cost_usd)),
    ])
  }

  /**
   * What a product has cost so far: every grouped photograph's description plus
   * every generated image, redos included. A draft is not itself billed — this
   * is the sum of the source photographs the operator grouped into it, which is
   * the figure that answers "what did this product cost to make".
   *
   * Null when no photograph in the draft has been billed yet, matching the
   * per-photograph rule that 0 would falsely claim a paid call returned free.
   */
  const draftIntakesByDraft = new Map<string, DraftIntakeRow[]>()
  for (const row of draftIntakes) {
    const list = draftIntakesByDraft.get(row.product_draft_id) ?? []
    list.push(row)
    draftIntakesByDraft.set(row.product_draft_id, list)
  }

  function draftCostFor(draftId: string): number | null {
    return sumUsd((draftIntakesByDraft.get(draftId) ?? []).map((member) => totalCostFor(member)))
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
        providerPausedAt: row.provider_paused_at,
        providerPauseCode: row.provider_pause_code,
        providerPauseMessage: row.provider_pause_message,
        describedAt: row.described_at,
        enhancedAt: row.enhanced_at,
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
      occurredAt: row.provider_paused_at ?? row.updated_at,
      reason: classification.reason,
      errorCode: row.provider_pause_code ?? row.last_error_code,
      errorClass: row.provider_paused_at ? 'provider' : row.error_class,
      rawDetail:
        row.provider_pause_detail?.slice(0, 2_000) ??
        row.last_error_detail?.slice(0, 2_000) ??
        null,
      thumb: (thumbKey ? signed.get(thumbKey) : null) ?? null,
      events: events.get(row.id) ?? [],
      canRetry: row.status === 'failed' && row.error_class === 'retryable',
      // Held work is the operator's to pick back up or throw away. Both are
      // refused in SQL for anything grouped, published or in flight.
      canResume: row.status === 'skipped',
      canResumeEnhancement: row.provider_paused_at !== null,
      canDiscard: row.status === 'skipped' && row.product_draft_id === null,
      canSkip:
        row.product_draft_id === null &&
        row.provider_paused_at === null &&
        !['enhancing', 'grouped', 'published', 'duplicate', 'skipped'].includes(row.status),
      consoleHref: row.product_draft_id
        ? `/console/drafts/${row.product_draft_id}`
        : row.status === 'enhanced'
          ? '/console'
          : null,
      costUsd: totalCostFor(row),
      driveHref: `https://drive.google.com/open?id=${encodeURIComponent(row.drive_file_id)}`,
      canDismiss: false,
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
        shopifyProductId: row.shopify_product_id,
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
      canResumeEnhancement: false,
      canDiscard: false,
      consoleHref: `/console/drafts/${row.id}`,
      driveHref: null,
      duplicate: null,
      canDismiss: false,
      // A draft is not billed itself; this is what its grouped photographs cost.
      costUsd: draftCostFor(row.id),
    }
  })

  /**
   * A redo is paid pipeline work the operator kicked off; before this it was
   * invisible here — the only sign was a badge inside the draft editor.
   */
  const redoRows: TrackingRow[] = redoJobs.map((job) => {
    const generating = job.status === 'processing' && job.generation_started_at !== null
    return {
      rowId: `redo:${job.id}`,
      kind: 'redo' as const,
      entityId: job.id,
      label: job.intake_files?.filename ?? `Redo v${job.version_no}`,
      statusLabel:
        job.status === 'queued'
          ? 'Redo queued'
          : generating
            ? 'Image model working'
            : 'Redo starting',
      tone: 'running' as const,
      group: 'progress' as const,
      occurredAt: job.updated_at,
      reason:
        job.status === 'queued'
          ? `Waiting to regenerate version ${job.version_no} on ${job.model}.`
          : `Regenerating version ${job.version_no} on ${job.model}.`,
      errorCode: null,
      errorClass: null,
      rawDetail: null,
      thumb: signed.get(thumbKeyByIntake.get(job.intake_file_id) ?? '') ?? null,
      events: events.get(job.id) ?? [],
      canRetry: false,
      canSkip: false,
      canResume: false,
      canResumeEnhancement: false,
      canDiscard: false,
      consoleHref: job.intake_files?.product_draft_id
        ? `/console/drafts/${job.intake_files.product_draft_id}`
        : '/console',
      driveHref: null,
      duplicate: null,
      canDismiss: false,
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
    canResumeEnhancement: false,
    canDiscard: false,
    consoleHref: `/console/drafts/${issue.product_draft_id}`,
    driveHref: null,
    duplicate: null,
    // The one row kind an operator can judge and silence. `entityId` is the run
    // id for the event trail, so the issue id travels in `rowId`.
    canDismiss: true,
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
      canResumeEnhancement: false,
      canDiscard: false,
      consoleHref: null,
      driveHref: null,
      duplicate: null,
      // A failed CHECK is not a finding to accept — it means Loupe never looked.
      canDismiss: false,
      costUsd: null,
    })
  }

  /**
   * Rows the page actually shows. `hidden` is healthy work already visible in
   * the console (enhanced-and-pending photographs); `draft` rows are the
   * console's working set and Tracking stopped duplicating them — only their
   * attention/progress classifications surface here.
   */
  const rows = [...issueRows, ...redoRows, ...draftRows, ...intakeRows]
    .filter((row) => row.group === 'attention' || row.group === 'progress')
    .sort((a, b) => {
      const groupRank = { attention: 0, draft: 1, progress: 2, complete: 3, hidden: 4 } as const
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
