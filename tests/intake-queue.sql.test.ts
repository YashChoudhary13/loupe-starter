/**
 * Phase 3A queue state-machine integration proof.
 *
 * This talks to the deployed Postgres functions over one direct transaction.
 * Everything rolls back, including events and the temporary isolation changes,
 * so the test proves SQL behaviour without leaving queue debris behind.
 */
import { randomUUID } from 'node:crypto'

import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { pgClient, pgPool } from '../scripts/lib/pg'

interface Discovery {
  id: string
  inserted: boolean
  status: string
  attempts: number
}

interface QueueState {
  id: string
  status: string
  attempts: number
  next_attempt_at: Date
}

interface SyncClaim {
  key: string
  value: string | null
  lease_token: string
  lease_expires_at: Date
}

describe('Phase 3A intake queue SQL state machine', () => {
  let db: Client

  beforeAll(async () => {
    db = pgClient()
    await db.connect()
    await db.query('begin')
    await db.query(`set local statement_timeout = '30s'`)

    // claim_intake_file() intentionally has no test-only filter. Keep deployed
    // rows out of this transaction's ready/expired sets, then roll everything
    // back. This prevents the proof from claiming somebody else's real work.
    await db.query(`
      update public.intake_files
         set next_attempt_at = now() + interval '1 day'
       where status = 'discovered'
    `)
    await db.query(`
      update public.intake_files
         set lease_expires_at = now() + interval '1 day'
       where status = 'enhancing'
         and lease_expires_at <= now()
    `)
  })

  afterAll(async () => {
    if (!db) return
    await db.query('rollback').catch(() => {})
    await db.end()
  })

  it('is idempotent, bounded, crash-safe and resistant to stale cursor completion', async () => {
    const source = 'phase3a-sql-integration'
    const driveId = `queue-${randomUUID()}`

    const first = await db.query<Discovery>(
      `select * from public.discover_intake_file($1, $2, $3, $4, $5, $6)`,
      [driveId, 'ring.jpg', 'md5-original', 1024, 'image/jpeg', source],
    )
    expect(first.rows).toEqual([
      expect.objectContaining({ inserted: true, status: 'discovered', attempts: 0 }),
    ])
    const intakeId = first.rows[0]!.id

    const replay = await db.query<Discovery>(
      `select * from public.discover_intake_file($1, $2, $3, $4, $5, $6)`,
      [driveId, 'renamed.png', 'md5-changed', 2048, 'image/png', source],
    )
    expect(replay.rows).toEqual([
      { id: intakeId, inserted: false, status: 'discovered', attempts: 0 },
    ])

    const unchanged = await db.query<{
      filename: string
      drive_md5: string
      bytes: string
      mime_type: string
    }>(
      `select filename, drive_md5, bytes, mime_type
         from public.intake_files where id = $1`,
      [intakeId],
    )
    expect(unchanged.rows[0]).toEqual({
      filename: 'ring.jpg',
      drive_md5: 'md5-original',
      bytes: '1024',
      mime_type: 'image/jpeg',
    })

    const discoveredEvents = await db.query<{ count: string }>(
      `select count(*)::text
         from public.events
        where entity_id = $1 and event = 'intake.discovered'`,
      [intakeId],
    )
    expect(discoveredEvents.rows[0]?.count).toBe('1')

    const unsupportedDriveId = `unsupported-${randomUUID()}`
    const unsupported = await db.query<Discovery>(
      `select * from public.discover_intake_file($1, $2, null, $3, $4, $5)`,
      [unsupportedDriveId, 'catalog.pdf', 512, 'application/pdf', source],
    )
    expect(unsupported.rows[0]).toEqual(
      expect.objectContaining({ inserted: true, status: 'failed', attempts: 1 }),
    )

    const rejected = await db.query<{
      last_error: string
      last_error_code: string
      last_error_detail: string
      error_class: string
    }>(
      `select last_error, last_error_code, last_error_detail, error_class
         from public.intake_files where id = $1`,
      [unsupported.rows[0]!.id],
    )
    expect(rejected.rows[0]).toEqual({
      last_error:
        'The file format is application/pdf. Loupe can enhance JPEG, PNG or WebP images. Export it in one of those formats and try again.',
      last_error_code: 'unsupported_mime_type',
      last_error_detail: expect.stringContaining('application/pdf'),
      error_class: 'permanent',
    })

    const boundary = await db.query<Discovery>(
      `select * from public.discover_intake_file($1, $2, null, $3, $4, $5)`,
      [`boundary-${randomUUID()}`, 'exactly-50mb.webp', 50_000_000, 'image/webp', source],
    )
    expect(boundary.rows[0]).toEqual(
      expect.objectContaining({ inserted: true, status: 'discovered', attempts: 0 }),
    )
    await db.query(
      `delete from public.events
        where entity_type = 'intake_file' and entity_id = $1`,
      [boundary.rows[0]!.id],
    )
    await db.query('delete from public.intake_files where id = $1', [boundary.rows[0]!.id])

    const oversized = await db.query<Discovery>(
      `select * from public.discover_intake_file($1, $2, null, $3, $4, $5)`,
      [`oversized-${randomUUID()}`, 'large.webp', 50_000_001, 'image/webp', source],
    )
    expect(oversized.rows[0]).toEqual(
      expect.objectContaining({ inserted: true, status: 'failed', attempts: 1 }),
    )
    const oversizedReason = await db.query<{
      last_error: string
      last_error_detail: string
    }>(
      `select last_error, last_error_detail
         from public.intake_files where id = $1`,
      [oversized.rows[0]!.id],
    )
    expect(oversizedReason.rows[0]).toEqual({
      last_error: expect.stringContaining('50 MB limit is 50000000 bytes'),
      last_error_detail: expect.stringContaining('"max_bytes": 50000000'),
    })

    // Discovery is the zero-delay first attempt. Claiming changes status/lease
    // but attempts still means "zero completed attempts".
    const claimed = await db.query<{
      id: string
      status: string
      attempts: number
      lease_token: string
      lease_expires_at: Date
    }>(`select * from public.claim_intake_file(60)`)
    expect(claimed.rows[0]).toEqual(
      expect.objectContaining({ id: intakeId, status: 'enhancing', attempts: 0 }),
    )
    let activeLeaseToken = claimed.rows[0]!.lease_token

    const delaysSeconds = [60, 300, 1200, 3600]
    for (let completedAttempt = 1; completedAttempt <= 5; completedAttempt += 1) {
      const failure = await db.query<QueueState>(
        `select * from public.record_intake_failure(
           $1, $2, $3, $4, 'retryable'::public.error_class, $5, $6
         )`,
        [
          intakeId,
          activeLeaseToken,
          `retryable attempt ${completedAttempt}`,
          'provider_unavailable',
          '{"status":503}',
          source,
        ],
      )
      const row = failure.rows[0]!
      expect(row.attempts).toBe(completedAttempt)

      if (completedAttempt === 5) {
        expect(row.status).toBe('failed')
        break
      }

      expect(row.status).toBe('discovered')
      const delay = await db.query<{ seconds: string }>(
        `select extract(epoch from (next_attempt_at - now()))::text as seconds
           from public.intake_files where id = $1`,
        [intakeId],
      )
      expect(Number(delay.rows[0]!.seconds)).toBe(delaysSeconds[completedAttempt - 1])

      // Advance only the test row to due; the transaction-stable now() makes the
      // expected schedule exact instead of timing-sensitive.
      await db.query(
        `update public.intake_files set next_attempt_at = now() where id = $1`,
        [intakeId],
      )
      const retryClaim = await db.query<{
        id: string
        status: string
        attempts: number
        lease_token: string
      }>(
        `select id, status, attempts, lease_token from public.claim_intake_file(60)`,
      )
      expect(retryClaim.rows[0]).toEqual(
        expect.objectContaining({
          id: intakeId,
          status: 'enhancing',
          attempts: completedAttempt,
        }),
      )
      activeLeaseToken = retryClaim.rows[0]!.lease_token
    }

    const terminal = await db.query<{ status: string; attempts: number; error_class: string }>(
      `select status, attempts, error_class
         from public.intake_files where id = $1`,
      [intakeId],
    )
    expect(terminal.rows[0]).toEqual({
      status: 'failed',
      attempts: 5,
      error_class: 'retryable',
    })

    // A crashed claim is rediscovered without manufacturing a completed attempt.
    const sweepDriveId = `sweep-${randomUUID()}`
    const sweepDiscovery = await db.query<Discovery>(
      `select * from public.discover_intake_file($1, $2, null, $3, $4, $5)`,
      [sweepDriveId, 'sweep.png', 2048, 'image/png', source],
    )
    const sweepId = sweepDiscovery.rows[0]!.id
    const sweepClaim = await db.query<{ id: string; attempts: number; lease_token: string }>(
      `select id, attempts, lease_token from public.claim_intake_file(60)`,
    )
    expect(sweepClaim.rows[0]).toEqual(
      expect.objectContaining({ id: sweepId, attempts: 0 }),
    )
    const staleIntakeToken = sweepClaim.rows[0]!.lease_token

    await db.query(
      `update public.intake_files
          set lease_expires_at = now() - interval '1 second'
        where id = $1`,
      [sweepId],
    )
    const swept = await db.query<{ sweep_expired_intake_leases: number }>(
      `select public.sweep_expired_intake_leases($1)`,
      [source],
    )
    expect(swept.rows[0]?.sweep_expired_intake_leases).toBe(1)

    const rediscovered = await db.query<{
      status: string
      attempts: number
      lease_token: string | null
      lease_expires_at: Date | null
      due: boolean
    }>(
      `select status, attempts, lease_token, lease_expires_at,
              next_attempt_at <= now() as due
         from public.intake_files where id = $1`,
      [sweepId],
    )
    expect(rediscovered.rows[0]).toEqual({
      status: 'discovered',
      attempts: 0,
      lease_token: null,
      lease_expires_at: null,
      due: true,
    })

    const sweepEvents = await db.query<{ count: string }>(
      `select count(*)::text
         from public.events
        where entity_id = $1 and event = 'intake.lease_expired'`,
      [sweepId],
    )
    expect(sweepEvents.rows[0]?.count).toBe('1')

    // A worker that wakes after its lease was swept cannot overwrite the worker
    // that reclaimed the row. The UUID is the claim ownership, not the deadline.
    const replacementIntake = await db.query<{
      id: string
      lease_token: string
      lease_expires_at: Date
    }>(
      `select id, lease_token, lease_expires_at
         from public.claim_intake_file(60)`,
    )
    expect(replacementIntake.rows[0]?.id).toBe(sweepId)
    expect(replacementIntake.rows[0]?.lease_token).not.toBe(staleIntakeToken)

    await db.query('savepoint stale_intake_worker')
    let staleWorkerCode: string | undefined
    try {
      await db.query(
        `select * from public.record_intake_failure(
          $1, $2, $3, $4, 'retryable'::public.error_class, $5, $6
        )`,
        [
          sweepId,
          staleIntakeToken,
          'late worker result',
          'stale_worker',
          '{"worker":"old"}',
          source,
        ],
      )
    } catch (error) {
      staleWorkerCode = (error as { code?: string }).code
      await db.query('rollback to savepoint stale_intake_worker')
    }
    expect(staleWorkerCode).toBe('55000')

    const replacementStillOwns = await db.query<{
      status: string
      attempts: number
      lease_token: string
      lease_expires_at: Date
    }>(
      `select status, attempts, lease_token, lease_expires_at
         from public.intake_files where id = $1`,
      [sweepId],
    )
    expect(replacementStillOwns.rows[0]).toEqual({
      status: 'enhancing',
      attempts: 0,
      lease_token: replacementIntake.rows[0]!.lease_token,
      lease_expires_at: replacementIntake.rows[0]!.lease_expires_at,
    })

    // Cursor leases are compare-and-swap. Once an expired claim is replaced,
    // its token cannot rewind the value or release the replacement claim.
    const syncKey = `drive:${randomUUID()}`
    const firstSync = await db.query<SyncClaim>(
      `select * from public.claim_sync_state($1, 300)`,
      [syncKey],
    )
    expect(firstSync.rows[0]).toEqual(
      expect.objectContaining({ key: syncKey, value: null }),
    )
    const staleToken = firstSync.rows[0]!.lease_token

    const busy = await db.query<SyncClaim>(
      `select * from public.claim_sync_state($1, 300)`,
      [syncKey],
    )
    expect(busy.rows).toEqual([])

    await db.query(
      `update public.sync_state
          set lease_expires_at = now() - interval '1 second'
        where key = $1`,
      [syncKey],
    )
    const replacement = await db.query<SyncClaim>(
      `select * from public.claim_sync_state($1, 300)`,
      [syncKey],
    )
    const currentToken = replacement.rows[0]!.lease_token
    expect(currentToken).not.toBe(staleToken)

    const staleComplete = await db.query<{ complete_sync_state: boolean }>(
      `select public.complete_sync_state($1, $2, $3)`,
      [syncKey, staleToken, 'old-token'],
    )
    expect(staleComplete.rows[0]?.complete_sync_state).toBe(false)

    const completed = await db.query<{ complete_sync_state: boolean }>(
      `select public.complete_sync_state($1, $2, $3)`,
      [syncKey, currentToken, 'new-token'],
    )
    expect(completed.rows[0]?.complete_sync_state).toBe(true)

    const afterComplete = await db.query<{
      value: string
      lease_token: string | null
      lease_expires_at: Date | null
    }>(
      `select value, lease_token, lease_expires_at
         from public.sync_state where key = $1`,
      [syncKey],
    )
    expect(afterComplete.rows[0]).toEqual({
      value: 'new-token',
      lease_token: null,
      lease_expires_at: null,
    })

    const finalClaim = await db.query<SyncClaim>(
      `select * from public.claim_sync_state($1, 300)`,
      [syncKey],
    )
    expect(finalClaim.rows[0]?.value).toBe('new-token')

    const staleRelease = await db.query<{ release_sync_state: boolean }>(
      `select public.release_sync_state($1, $2)`,
      [syncKey, staleToken],
    )
    expect(staleRelease.rows[0]?.release_sync_state).toBe(false)

    const currentRelease = await db.query<{ release_sync_state: boolean }>(
      `select public.release_sync_state($1, $2)`,
      [syncKey, finalClaim.rows[0]!.lease_token],
    )
    expect(currentRelease.rows[0]?.release_sync_state).toBe(true)
  })

  it('gives parallel SKIP LOCKED claimers distinct rows without waiting', async () => {
    const claimCount = 4
    const source = 'phase3a-concurrent-claim'
    const pool = pgPool(claimCount + 1)
    const ids: string[] = []

    try {
      // These rows commit so independent claim transactions can see them. Put
      // them far ahead of any real queue work, then delete them and their events.
      for (let i = 0; i < claimCount; i += 1) {
        const discovered = await pool.query<Discovery>(
          `select * from public.discover_intake_file($1, $2, null, $3, $4, $5)`,
          [
            `parallel-${randomUUID()}`,
            `parallel-${i}.jpg`,
            1024 + i,
            'image/jpeg',
            source,
          ],
        )
        ids.push(discovered.rows[0]!.id)
      }

      await pool.query(
        `update public.intake_files
            set next_attempt_at = timestamptz '2000-01-01 00:00:00+00',
                discovered_at = timestamptz '2000-01-01 00:00:00+00'
          where id = any($1::uuid[])`,
        [ids],
      )

      const clients = await Promise.all(
        Array.from({ length: claimCount }, async () => pool.connect()),
      )

      try {
        await Promise.all(clients.map((client) => client.query('begin')))
        await Promise.all(
          clients.map((client) => client.query(`set local statement_timeout = '5s'`)),
        )

        // Transactions remain open after the function returns, so every claimed
        // row stays locked until all four calls have completed. Without
        // SKIP LOCKED, the second call waits and hits statement_timeout.
        const claims = await Promise.all(
          clients.map((client) =>
            client.query<{ id: string; status: string; attempts: number }>(
              `select id, status, attempts from public.claim_intake_file(60)`,
            ),
          ),
        )

        const claimedIds = claims.map((result) => result.rows[0]!.id)
        expect(new Set(claimedIds).size).toBe(claimCount)
        expect([...claimedIds].sort()).toEqual([...ids].sort())
        expect(claims.every((result) => result.rows[0]?.status === 'enhancing')).toBe(true)
        expect(claims.every((result) => result.rows[0]?.attempts === 0)).toBe(true)

        await Promise.all(clients.map((client) => client.query('commit')))
      } catch (error) {
        await Promise.all(clients.map((client) => client.query('rollback').catch(() => {})))
        throw error
      } finally {
        clients.forEach((client) => client.release())
      }
    } finally {
      if (ids.length > 0) {
        await pool.query(`delete from public.events where entity_id = any($1::uuid[])`, [ids])
        await pool.query(`delete from public.intake_files where id = any($1::uuid[])`, [ids])
      }
      await pool.end()
    }
  })
})
