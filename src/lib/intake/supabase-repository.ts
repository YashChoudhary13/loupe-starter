import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { supabaseServer } from '@/lib/supabase/server'

import {
  type IntakeDiscoveryResult,
  type IntakeFileDiscovery,
  type IntakeRepository,
  IntakeRepositoryError,
  type SyncStateLease,
  type SystemEvent,
} from './repository'

interface DiscoverRow {
  id: string
  inserted: boolean
  status: string
  attempts: number
}

interface SyncStateRow {
  key: string
  value: string | null
  lease_token: string | null
  lease_expires_at: string | null
}

function repositoryFailure(message: string, detail: unknown): IntakeRepositoryError {
  // A database/API transport fault is safe to try again on the next bounded cron
  // invocation. SQL functions retain ownership/idempotency rules underneath.
  return new IntakeRepositoryError(message, { retryable: true, detail })
}

export class SupabaseIntakeRepository implements IntakeRepository {
  constructor(private readonly db: SupabaseClient = supabaseServer()) {}

  async discoverIntakeFile(input: IntakeFileDiscovery): Promise<IntakeDiscoveryResult> {
    const { data, error } = await this.db
      .rpc('discover_intake_file', {
        p_drive_file_id: input.driveFileId,
        p_filename: input.filename,
        p_drive_md5: input.driveMd5,
        p_bytes: input.bytes,
        p_mime_type: input.mimeType,
        p_source: input.source,
      })
      .select()
      .single<DiscoverRow>()

    if (error || !data) {
      throw repositoryFailure(
        `Could not record Drive file ${input.driveFileId} in the intake queue.`,
        error ?? data,
      )
    }

    return data
  }

  async claimSyncState(key: string, leaseSeconds: number): Promise<SyncStateLease | null> {
    const { data, error } = await this.db
      .rpc('claim_sync_state', {
        p_key: key,
        p_lease_seconds: leaseSeconds,
      })
      .select()
      .maybeSingle<SyncStateRow>()

    if (error) {
      throw repositoryFailure(`Could not claim Drive sync state "${key}".`, error)
    }
    if (!data) return null

    if (!data.lease_token || !data.lease_expires_at) {
      throw new IntakeRepositoryError(`Drive sync state "${key}" returned an invalid lease.`, {
        retryable: false,
        detail: data,
      })
    }

    return {
      key: data.key,
      value: data.value,
      leaseToken: data.lease_token,
      leaseExpiresAt: data.lease_expires_at,
    }
  }

  async completeSyncState(key: string, leaseToken: string, value: string): Promise<boolean> {
    const { data, error } = await this.db.rpc('complete_sync_state', {
      p_key: key,
      p_lease_token: leaseToken,
      p_value: value,
    })

    if (error) {
      throw repositoryFailure(`Could not complete Drive sync state "${key}".`, error)
    }
    if (typeof data !== 'boolean') {
      throw new IntakeRepositoryError(
        `Drive sync completion for "${key}" returned an invalid result.`,
        {
          retryable: false,
          detail: data,
        },
      )
    }
    return data
  }

  async releaseSyncState(key: string, leaseToken: string): Promise<boolean> {
    const { data, error } = await this.db.rpc('release_sync_state', {
      p_key: key,
      p_lease_token: leaseToken,
    })

    if (error) {
      throw repositoryFailure(`Could not release Drive sync state "${key}".`, error)
    }
    if (typeof data !== 'boolean') {
      throw new IntakeRepositoryError(
        `Drive sync release for "${key}" returned an invalid result.`,
        {
          retryable: false,
          detail: data,
        },
      )
    }
    return data
  }

  async sweepExpiredIntakeLeases(): Promise<number> {
    const { data, error } = await this.db.rpc('sweep_expired_intake_leases', {})
    if (error) {
      throw repositoryFailure('Could not sweep expired intake leases.', error)
    }
    if (typeof data !== 'number' || !Number.isInteger(data) || data < 0) {
      throw new IntakeRepositoryError('The intake lease sweep returned an invalid count.', {
        retryable: false,
        detail: data,
      })
    }
    return data
  }

  async recordSystemEvent(input: SystemEvent): Promise<void> {
    const { error } = await this.db.from('events').insert({
      entity_type: 'system',
      entity_id: null,
      event: input.event,
      detail: input.detail,
      actor: input.actor,
    })
    if (error) {
      throw repositoryFailure(`Could not record system event "${input.event}".`, error)
    }
  }
}
