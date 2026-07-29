/**
 * Live Phase 3A acceptance proof.
 *
 * This script intentionally crosses the real boundaries: Google Drive, the
 * deployed cron routes, Supabase Postgres, pg_cron, and pg_net. It creates only
 * uniquely prefixed test files, pauses the three Loupe schedules while evidence
 * is collected, and restores the schedules in a finally block.
 *
 * Test artifacts are deleted from Drive and the queue after the evidence is
 * printed. Files are never moved to Processed.
 */
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import { auth, drive, type drive_v3 } from '@googleapis/drive'

import { googleServiceAccount } from '../src/lib/google/service-account'
import { validatedCronSecret } from '../src/lib/cron/secret'
import { pgClient } from './lib/pg'

const ROUTES = [
  '/api/cron/watch',
  '/api/cron/reconcile',
  '/api/cron/sweep',
] as const

const CRON_JOB_NAMES = [
  'loupe-drive-watch',
  'loupe-drive-reconcile',
  'loupe-intake-sweep',
] as const

const BASE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

interface UploadedFile {
  readonly id: string
  readonly name: string
  readonly md5Checksum: string
  readonly size: number
  readonly mimeType: string
}

interface IntakeRow {
  readonly id: string
  readonly drive_file_id: string
  readonly filename: string
  readonly drive_md5: string | null
  readonly bytes: string | number | null
  readonly mime_type: string | null
  readonly status: string
  readonly attempts: number
  readonly last_error: string | null
  readonly last_error_detail: string | null
  readonly error_class: string | null
  readonly lease_token: string | null
  readonly lease_expires_at: string | null
  readonly next_attempt_at: string
  readonly discovered_at: string
  readonly updated_at: string
}

interface CronJobSnapshot {
  readonly jobid: string | number
  readonly jobname: string
  readonly schedule: string
  readonly command: string
}

interface EndpointResult {
  readonly status: number
  readonly body: Record<string, unknown>
}

function required(key: string): string {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`${key} is missing`)
  return value
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function stableQueueRow(row: IntakeRow): string {
  return JSON.stringify({
    id: row.id,
    driveFileId: row.drive_file_id,
    filename: row.filename,
    md5: row.drive_md5,
    bytes: Number(row.bytes),
    mimeType: row.mime_type,
    status: row.status,
    attempts: row.attempts,
    discoveredAt: row.discovered_at,
    updatedAt: row.updated_at,
  })
}

function safeBody(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : { value: String(value) }
}

async function endpoint(
  baseUrl: string,
  path: (typeof ROUTES)[number],
  secret?: string,
): Promise<EndpointResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify({ source: 'phase-3a-live-verification' }),
    signal: AbortSignal.timeout(120_000),
  })
  const raw = await response.text()
  let parsed: unknown
  try {
    parsed = raw ? JSON.parse(raw) : {}
  } catch {
    parsed = { response: raw.slice(0, 500) }
  }
  return { status: response.status, body: safeBody(parsed) }
}

function expectSuccessfulEndpoint(result: EndpointResult, path: string): Record<string, unknown> {
  invariant(
    result.status >= 200 && result.status < 300 && result.body.ok === true,
    `${path} failed with ${result.status}: ${JSON.stringify(result.body)}`,
  )
  return result.body
}

async function listRawChildren(
  api: drive_v3.Drive,
  folderId: string,
): Promise<drive_v3.Schema$File[]> {
  const files: drive_v3.Schema$File[] = []
  let pageToken: string | undefined
  do {
    const response = await api.files.list({
      q: `'${folderId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' in parents and trashed=false`,
      pageSize: 1000,
      pageToken,
      spaces: 'drive',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields: 'nextPageToken,files(id,name,md5Checksum,size,mimeType)',
    })
    files.push(...(response.data.files ?? []))
    pageToken = response.data.nextPageToken ?? undefined
  } while (pageToken)
  return files
}

function uploadedMetadata(file: drive_v3.Schema$File): UploadedFile {
  invariant(file.id, `Drive file ${file.name ?? '<unnamed>'} has no id`)
  invariant(file.name, `Drive file ${file.id} has no name`)
  invariant(file.md5Checksum, `Drive file ${file.name} has no md5Checksum`)
  invariant(file.size, `Drive file ${file.name} has no size`)
  invariant(file.mimeType, `Drive file ${file.name} has no mimeType`)
  return {
    id: file.id,
    name: file.name,
    md5Checksum: file.md5Checksum,
    size: Number(file.size),
    mimeType: file.mimeType,
  }
}

async function waitForExternalFiles(
  api: drive_v3.Drive,
  folderId: string,
  names: readonly string[],
  onObserved?: (files: readonly drive_v3.Schema$File[]) => void,
): Promise<UploadedFile[]> {
  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    const children = await listRawChildren(api, folderId)
    const matches = children.filter((file) => file.name && names.includes(file.name))
    onObserved?.(matches)
    const counts = new Map<string, number>()
    for (const match of matches) {
      const name = match.name!
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    const duplicate = [...counts.entries()].find(([, count]) => count > 1)
    invariant(!duplicate, `Drive contains duplicate live-proof filename ${duplicate?.[0]}`)

    if (names.every((name) => counts.get(name) === 1)) {
      return names.map((name) => {
        const file = matches.find((candidate) => candidate.name === name)
        invariant(file, `Drive file ${name} disappeared during discovery`)
        return uploadedMetadata(file)
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(`Timed out waiting for Drive upload(s): ${names.join(', ')}`)
}

async function waitForExternalFilesRemoved(
  api: drive_v3.Drive,
  folderId: string,
  driveIds: readonly string[],
): Promise<void> {
  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    const children = await listRawChildren(api, folderId)
    const remaining = children.filter((file) => file.id && driveIds.includes(file.id))
    if (remaining.length === 0) return
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(`Timed out waiting for ${driveIds.length} owner-uploaded Drive files to be removed`)
}

async function upload(
  api: drive_v3.Drive,
  folderId: string,
  name: string,
  mimeType: string,
  content: Buffer,
): Promise<UploadedFile> {
  const response = await api.files.create({
    requestBody: { name, mimeType, parents: [folderId] },
    media: { mimeType, body: Readable.from(content) },
    supportsAllDrives: true,
    fields: 'id,name,md5Checksum,size,mimeType,parents',
  })
  const file = response.data
  invariant(file.id, `Drive upload returned no id for ${name}`)
  invariant(file.name, `Drive upload returned no name for ${name}`)
  invariant(file.md5Checksum, `Drive upload returned no md5Checksum for ${name}`)
  invariant(file.size, `Drive upload returned no size for ${name}`)
  invariant(file.mimeType, `Drive upload returned no mimeType for ${name}`)
  return {
    id: file.id,
    name: file.name,
    md5Checksum: file.md5Checksum,
    size: Number(file.size),
    mimeType: file.mimeType,
  }
}

async function intakeRows(
  client: ReturnType<typeof pgClient>,
  driveIds: readonly string[],
): Promise<IntakeRow[]> {
  if (driveIds.length === 0) return []
  const result = await client.query<IntakeRow>(
    `select id, drive_file_id, filename, drive_md5, bytes, mime_type, status,
            attempts, last_error, last_error_detail, error_class,
            lease_token, lease_expires_at, next_attempt_at, discovered_at, updated_at
       from public.intake_files
      where drive_file_id = any($1::text[])
      order by filename`,
    [driveIds],
  )
  return result.rows
}

async function snapshotAndPauseCron(
  client: ReturnType<typeof pgClient>,
): Promise<CronJobSnapshot[]> {
  await client.query('begin')
  try {
    const result = await client.query<CronJobSnapshot>(
      `select jobid, jobname, schedule, command
         from cron.job
        where jobname = any($1::text[])
          and active
        order by jobname`,
      [[...CRON_JOB_NAMES]],
    )
    invariant(
      result.rows.length === CRON_JOB_NAMES.length,
      `Expected ${CRON_JOB_NAMES.length} active Loupe cron jobs before the live proof; found ${result.rows.length}`,
    )

    for (const job of result.rows) {
      const removed = await client.query<{ unscheduled: boolean }>(
        'select cron.unschedule($1::bigint) as unscheduled',
        [job.jobid],
      )
      invariant(removed.rows[0]?.unscheduled, `Could not pause ${job.jobname}`)
    }
    await client.query('commit')
    return result.rows
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  }
}

async function restoreCron(
  client: ReturnType<typeof pgClient>,
  jobs: readonly CronJobSnapshot[],
): Promise<void> {
  await client.query('begin')
  try {
    for (const job of jobs) {
      await client.query('select cron.schedule($1, $2, $3)', [
        job.jobname,
        job.schedule,
        job.command,
      ])
    }
    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  }
}

async function removeTestRows(
  client: ReturnType<typeof pgClient>,
  driveIds: readonly string[],
): Promise<void> {
  if (driveIds.length === 0) return
  await client.query('begin')
  try {
    const ids = await client.query<{ id: string }>(
      'select id from public.intake_files where drive_file_id = any($1::text[]) for update',
      [driveIds],
    )
    const entityIds = ids.rows.map((row) => row.id)
    if (entityIds.length > 0) {
      await client.query(
        `delete from public.events
          where entity_type = 'intake_file'
            and entity_id = any($1::uuid[])`,
        [entityIds],
      )
    }
    await client.query(
      'delete from public.intake_files where drive_file_id = any($1::text[])',
      [driveIds],
    )
    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  }
}

async function main(): Promise<void> {
  const baseUrl = new URL(required('CRON_BASE_URL')).origin
  const cronSecret = validatedCronSecret(process.env.CRON_SECRET)
  const rawFolderId = required('DRIVE_RAW_FOLDER_ID')
  const serviceAccount = googleServiceAccount()
  const authorization = new auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/drive'],
  })
  const api = drive({ version: 'v3', auth: authorization })
  const database = pgClient()
  await database.connect()

  const runId = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
  const externalPrefix = process.env.PHASE3A_EXTERNAL_PREFIX?.trim()
  const prefix = externalPrefix || `loupe-phase3a-${runId}`
  const uploaded: UploadedFile[] = []
  const observedExternalFiles = new Map<string, { readonly id: string; readonly name: string }>()
  const rememberExternalFiles = (files: readonly drive_v3.Schema$File[]): void => {
    for (const file of files) {
      if (file.id && file.name) {
        observedExternalFiles.set(file.id, { id: file.id, name: file.name })
      }
    }
  }
  let pausedJobs: CronJobSnapshot[] = []
  let evidenceComplete = false
  let cleanupComplete = true

  try {
    const initialFiles = await listRawChildren(api, rawFolderId)
    invariant(
      initialFiles.length === 0,
      `RAW folder must start empty for the exact-12 proof; found ${initialFiles.length} file(s)`,
    )

    pausedJobs = await snapshotAndPauseCron(database)
    console.log(`Automatic schedules paused: ${pausedJobs.map((job) => job.jobname).join(', ')}`)

    // Criterion 8 first: authorization must fail closed before any state work.
    const unauthenticated = await Promise.all(
      ROUTES.map(async (path) => ({ path, result: await endpoint(baseUrl, path) })),
    )
    for (const { path, result } of unauthenticated) {
      invariant(result.status === 401, `${path} without CRON_SECRET returned ${result.status}, not 401`)
    }
    console.log(
      `Criterion 8 PASS — no-secret statuses: ${unauthenticated
        .map(({ path, result }) => `${path}=${result.status}`)
        .join(', ')}`,
    )

    // Criterion 1: twelve real Drive uploads, then the incremental watcher.
    const firstNames = Array.from(
      { length: 12 },
      (_, index) => `${prefix}-${String(index + 1).padStart(2, '0')}.png`,
    )
    if (externalPrefix) {
      console.log(`WAITING FOR USER DRIVE UPLOAD — ${firstNames.length} base PNG files`)
      uploaded.push(
        ...(await waitForExternalFiles(
          api,
          rawFolderId,
          firstNames,
          rememberExternalFiles,
        )),
      )
    } else {
      for (let index = 1; index <= 12; index += 1) {
        const suffix = Buffer.from(`loupe-live-proof-${runId}-${index}`)
        const content = Buffer.concat([BASE_PNG, suffix])
        uploaded.push(
          await upload(
            api,
            rawFolderId,
            `${prefix}-${String(index).padStart(2, '0')}.png`,
            'image/png',
            content,
          ),
        )
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const firstWatch = expectSuccessfulEndpoint(
      await endpoint(baseUrl, '/api/cron/watch', cronSecret),
      '/api/cron/watch',
    )
    invariant(firstWatch.inserted === 12, `First watch inserted ${String(firstWatch.inserted)}, not 12`)

    const firstIds = uploaded.map((file) => file.id)
    const firstRows = await intakeRows(database, firstIds)
    invariant(firstRows.length === 12, `Expected 12 queue rows, found ${firstRows.length}`)
    const uploadedById = new Map(uploaded.map((file) => [file.id, file]))
    for (const row of firstRows) {
      const file = uploadedById.get(row.drive_file_id)
      invariant(file, `Unexpected Drive id ${row.drive_file_id} in the exact-12 result`)
      invariant(row.status === 'discovered', `${row.filename} is ${row.status}, not discovered`)
      invariant(row.filename === file.name, `${row.drive_file_id} filename does not match Drive`)
      invariant(row.drive_md5 === file.md5Checksum, `${row.filename} md5 does not match Drive`)
      invariant(Number(row.bytes) === file.size, `${row.filename} size does not match Drive`)
      invariant(row.mime_type === file.mimeType, `${row.filename} mimeType does not match Drive`)
    }
    console.log('Criterion 1 PASS — exactly 12 discovered rows; Drive metadata matches:')
    console.table(
      firstRows.map((row) => ({
        filename: row.filename,
        md5: row.drive_md5,
        bytes: Number(row.bytes),
        status: row.status,
      })),
    )

    // Criterion 2: unchanged cursor/queue replay.
    const beforeSecondWatch = new Map(
      firstRows.map((row) => [row.drive_file_id, stableQueueRow(row)]),
    )
    const secondWatch = expectSuccessfulEndpoint(
      await endpoint(baseUrl, '/api/cron/watch', cronSecret),
      '/api/cron/watch',
    )
    invariant(secondWatch.inserted === 0, `Second watch inserted ${String(secondWatch.inserted)}, not 0`)
    const secondRows = await intakeRows(database, firstIds)
    invariant(secondRows.length === 12, 'Second watch changed the queue row count')
    for (const row of secondRows) {
      invariant(
        beforeSecondWatch.get(row.drive_file_id) === stableQueueRow(row),
        `Second watch mutated ${row.filename}`,
      )
    }
    console.log('Criterion 2 PASS — immediate watch replay inserted 0 and mutated 0 rows')

    // Criterion 3: remove exactly three database truths, then full reconciliation.
    const deletedDriveIds = firstIds.slice(0, 3)
    const preservedDriveIds = firstIds.slice(3)
    const preservedBefore = new Map(
      secondRows
        .filter((row) => preservedDriveIds.includes(row.drive_file_id))
        .map((row) => [row.drive_file_id, stableQueueRow(row)]),
    )
    const deletedRows = secondRows.filter((row) => deletedDriveIds.includes(row.drive_file_id))
    await database.query(
      `delete from public.events
        where entity_type = 'intake_file'
          and entity_id = any($1::uuid[])`,
      [deletedRows.map((row) => row.id)],
    )
    await database.query(
      'delete from public.intake_files where drive_file_id = any($1::text[])',
      [deletedDriveIds],
    )
    const reconcileThree = expectSuccessfulEndpoint(
      await endpoint(baseUrl, '/api/cron/reconcile', cronSecret),
      '/api/cron/reconcile',
    )
    invariant(
      reconcileThree.inserted === 3,
      `Reconcile after deleting three inserted ${String(reconcileThree.inserted)}, not 3`,
    )
    const reconciledRows = await intakeRows(database, firstIds)
    invariant(reconciledRows.length === 12, `Reconcile restored ${reconciledRows.length}, not 12 rows`)
    for (const row of reconciledRows.filter((item) => preservedDriveIds.includes(item.drive_file_id))) {
      invariant(
        preservedBefore.get(row.drive_file_id) === stableQueueRow(row),
        `Reconcile mutated preserved row ${row.filename}`,
      )
    }
    console.log('Criterion 3 PASS — exactly 3 deleted rows returned; the other 9 were byte-for-byte unchanged')

    // Criterion 4: the schedules remain stopped for longer than one watch period.
    const outageName = `${prefix}-outage.png`
    let outageFile: UploadedFile
    if (externalPrefix) {
      console.log(`WAITING FOR USER DRIVE UPLOAD — ${outageName}`)
      ;[outageFile] = await waitForExternalFiles(
        api,
        rawFolderId,
        [outageName],
        rememberExternalFiles,
      )
      invariant(outageFile, `Drive upload ${outageName} was not found`)
    } else {
      const outageContent = Buffer.concat([BASE_PNG, Buffer.from(`outage-${runId}`)])
      outageFile = await upload(
        api,
        rawFolderId,
        outageName,
        'image/png',
        outageContent,
      )
    }
    uploaded.push(outageFile)
    await new Promise((resolve) => setTimeout(resolve, 70_000))
    const absentDuringOutage = await intakeRows(database, [outageFile.id])
    invariant(
      absentDuringOutage.length === 0,
      'The outage file appeared while all automatic schedules were paused',
    )
    const outageReconcile = expectSuccessfulEndpoint(
      await endpoint(baseUrl, '/api/cron/reconcile', cronSecret),
      '/api/cron/reconcile',
    )
    invariant(
      outageReconcile.inserted === 1,
      `Outage reconciliation inserted ${String(outageReconcile.inserted)}, not 1`,
    )
    const recoveredOutage = await intakeRows(database, [outageFile.id])
    invariant(
      recoveredOutage.length === 1 && recoveredOutage[0]?.status === 'discovered',
      'Reconcile did not recover the outage file as discovered',
    )
    console.log(
      'Criterion 4 PASS — schedules stopped; file stayed absent for 70s; reconcile recovered exactly 1 discovered row',
    )

    // Criterion 5: one deliberately expired lease returns once and is audited.
    const sweepTarget = reconciledRows[0]
    invariant(sweepTarget, 'No intake row available for the sweep proof')
    const eventsBefore = await database.query<{ count: string }>(
      `select count(*)::text as count
         from public.events
        where entity_type = 'intake_file'
          and entity_id = $1::uuid
          and event = 'intake.lease_expired'`,
      [sweepTarget.id],
    )
    await database.query(
      `update public.intake_files
          set status = 'enhancing',
              lease_token = gen_random_uuid(),
              lease_expires_at = now() - interval '5 minutes'
        where id = $1::uuid`,
      [sweepTarget.id],
    )
    const sweep = expectSuccessfulEndpoint(
      await endpoint(baseUrl, '/api/cron/sweep', cronSecret),
      '/api/cron/sweep',
    )
    invariant(Number(sweep.requeued) >= 1, `Sweep requeued ${String(sweep.requeued)}, expected at least 1`)
    const sweptRows = await intakeRows(database, [sweepTarget.drive_file_id])
    invariant(
      sweptRows[0]?.status === 'discovered' &&
        sweptRows[0]?.lease_token === null &&
        sweptRows[0]?.lease_expires_at === null,
      'Expired test lease did not return to discovered with cleared ownership',
    )
    const eventsAfter = await database.query<{ count: string }>(
      `select count(*)::text as count
         from public.events
        where entity_type = 'intake_file'
          and entity_id = $1::uuid
          and event = 'intake.lease_expired'`,
      [sweepTarget.id],
    )
    invariant(
      Number(eventsAfter.rows[0]?.count) === Number(eventsBefore.rows[0]?.count) + 1,
      'Sweep did not write exactly one intake.lease_expired event for the test row',
    )
    console.log(
      `Criterion 5 PASS — ${sweepTarget.filename} returned to discovered; exactly 1 intake.lease_expired event added`,
    )

    // Criterion 6: unsupported input is one completed validation attempt, no retry.
    const unsupportedName = `${prefix}-unsupported.txt`
    let unsupportedFile: UploadedFile
    if (externalPrefix) {
      console.log(`WAITING FOR USER DRIVE UPLOAD — ${unsupportedName}`)
      ;[unsupportedFile] = await waitForExternalFiles(
        api,
        rawFolderId,
        [unsupportedName],
        rememberExternalFiles,
      )
      invariant(unsupportedFile, `Drive upload ${unsupportedName} was not found`)
    } else {
      const unsupportedContent = Buffer.from(`Loupe unsupported MIME proof ${runId}\n`)
      unsupportedFile = await upload(
        api,
        rawFolderId,
        unsupportedName,
        'text/plain',
        unsupportedContent,
      )
    }
    uploaded.push(unsupportedFile)
    const unsupportedReconcile = expectSuccessfulEndpoint(
      await endpoint(baseUrl, '/api/cron/reconcile', cronSecret),
      '/api/cron/reconcile',
    )
    invariant(
      unsupportedReconcile.inserted === 1,
      `Unsupported reconcile inserted ${String(unsupportedReconcile.inserted)}, not 1`,
    )
    const unsupportedRows = await intakeRows(database, [unsupportedFile.id])
    const unsupported = unsupportedRows[0]
    invariant(unsupported, 'Unsupported Drive file has no queue row')
    invariant(unsupported.status === 'failed', `Unsupported file is ${unsupported.status}, not failed`)
    invariant(unsupported.error_class === 'permanent', 'Unsupported file is not permanent')
    invariant(unsupported.attempts === 1, `Unsupported file attempts is ${unsupported.attempts}, not 1`)
    invariant(
      unsupported.last_error?.includes('JPEG, PNG or WebP') &&
        !/\bHTTP\s+\d{3}\b/i.test(unsupported.last_error),
      `Unsupported file reason is not readable: ${unsupported.last_error ?? '<null>'}`,
    )
    invariant(unsupported.last_error_detail, 'Unsupported file has no raw error detail')
    console.log(
      `Criterion 6 PASS — status=${unsupported.status}, class=${unsupported.error_class}, attempts=${unsupported.attempts}`,
    )
    console.log(`  readable reason: ${unsupported.last_error}`)
    console.log(`  raw detail retained separately: ${unsupported.last_error_detail}`)

    evidenceComplete = true
  } finally {
    const cleanupFiles = externalPrefix ? [...observedExternalFiles.values()] : uploaded
    const driveIds = cleanupFiles.map((file) => file.id)
    let sourceCleanupVerified = true
    if (externalPrefix && cleanupFiles.length > 0) {
      console.log(
        `WAITING FOR USER DRIVE CLEANUP — move ${cleanupFiles.length} prefixed test files to trash`,
      )
      await waitForExternalFilesRemoved(api, rawFolderId, driveIds).catch((error: unknown) => {
        sourceCleanupVerified = false
        cleanupComplete = false
        console.error(`Cleanup error: owner-uploaded Drive files remain: ${String(error)}`)
      })
    } else {
      for (const file of [...uploaded].reverse()) {
        await api.files
          .delete(
            { fileId: file.id, supportsAllDrives: true },
            { timeout: 30_000 },
          )
          .catch((error: unknown) => {
            sourceCleanupVerified = false
            cleanupComplete = false
            console.error(
              `Cleanup error: could not delete test Drive file ${file.name}: ${String(error)}`,
            )
          })
      }
    }
    if (sourceCleanupVerified) {
      await removeTestRows(database, driveIds).catch((error: unknown) => {
        cleanupComplete = false
        console.error(`Cleanup error: could not delete test queue rows: ${String(error)}`)
      })
    } else {
      console.error(
        'Cleanup safety: test queue rows were retained because their Drive source cleanup was not verified.',
      )
    }
    if (pausedJobs.length > 0) {
      await restoreCron(database, pausedJobs).then(
        () => {
          console.log(`Automatic schedules restored: ${pausedJobs.map((job) => job.jobname).join(', ')}`)
        },
        (error: unknown) => {
          cleanupComplete = false
          console.error(`Cleanup error: automatic schedules were not restored: ${String(error)}`)
        },
      )
    }
    await database.end().catch((error: unknown) => {
      cleanupComplete = false
      console.error(`Cleanup error: database connection did not close cleanly: ${String(error)}`)
    })
  }

  invariant(evidenceComplete, 'Live acceptance proof did not complete')
  invariant(cleanupComplete, 'Live proof passed, but cleanup or schedule restoration was incomplete')
  console.log('Live proof cleanup PASS — only uniquely prefixed test files/rows were removed; nothing moved to Processed')
}

main().catch((error: unknown) => {
  console.error(`\nverify-drive-intake-live failed\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
