import { describe, expect, it } from 'vitest'

import { isProtectedKey } from '@/lib/retention/protected-keys'
import { runRetentionPurge, type PurgeDeps } from '@/lib/retention/purge'

/**
 * Retention must never delete a real photograph (D109). The database refuses
 * originals twice (`retention_candidates` never returns one, `mark_versions_purged`
 * never marks one); this proves the TypeScript side refuses as well, so a stale
 * deploy of either half cannot delete an original on its own.
 */

function fakeDeps(candidates: Record<string, unknown>[]) {
  const deleted: string[] = []
  const marked: string[][] = []
  const deps: PurgeDeps = {
    db: {
      rpc: (async (fn: string, args: Record<string, unknown>) => {
        if (fn === 'retention_candidates') return { data: candidates, error: null }
        if (fn === 'mark_versions_purged') {
          marked.push(args.p_image_version_ids as string[])
          return { data: (args.p_image_version_ids as string[]).length, error: null }
        }
        throw new Error(`unexpected rpc ${fn}`)
      }) as unknown as PurgeDeps['db']['rpc'],
    },
    store: {
      async delete(key: string) {
        deleted.push(key)
      },
    },
  }
  return { deps, deleted, marked }
}

describe('protected keys', () => {
  it('protects every prefix that holds a real photograph', () => {
    expect(isProtectedKey('originals/8f1e.jpg')).toBe(true)
    expect(isProtectedKey('manual/8f1e/original.png')).toBe(true)
    expect(isProtectedKey('references/NK845/8f1e.jpg')).toBe(true)
    expect(isProtectedKey('identify/8f1e.jpg')).toBe(true)
  })

  it('leaves generated versions and thumbnails purgeable', () => {
    expect(isProtectedKey('versions/8f1e/v1.png')).toBe(false)
    expect(isProtectedKey('versions/8f1e/v1_thumb.webp')).toBe(false)
    expect(isProtectedKey('manual-ready/thumb.webp')).toBe(false)
  })
})

describe('runRetentionPurge', () => {
  it('deletes and marks a generated version', async () => {
    const { deps, deleted, marked } = fakeDeps([
      {
        image_version_id: 'gen-1',
        intake_file_id: 'file-1',
        storage_key: 'versions/file-1/v1.png',
        thumb_key: 'versions/file-1/v1_thumb.webp',
      },
    ])
    const result = await runRetentionPurge({}, deps)
    expect(deleted).toEqual(['versions/file-1/v1.png', 'versions/file-1/v1_thumb.webp'])
    expect(marked).toEqual([['gen-1']])
    expect(result).toMatchObject({ candidates: 1, objectsDeleted: 2, versionsPurged: 1, protectedKept: 0 })
  })

  it('refuses to delete or mark an original even if the database offers it', async () => {
    const { deps, deleted, marked } = fakeDeps([
      {
        image_version_id: 'orig-1',
        intake_file_id: 'file-1',
        storage_key: 'originals/file-1.jpg',
        thumb_key: null,
      },
      {
        image_version_id: 'gen-1',
        intake_file_id: 'file-1',
        storage_key: 'versions/file-1/v1.png',
        thumb_key: null,
      },
    ])
    const result = await runRetentionPurge({}, deps)
    expect(deleted).toEqual(['versions/file-1/v1.png'])
    expect(marked).toEqual([['gen-1']])
    expect(result.protectedKept).toBe(1)
    expect(result.versionsPurged).toBe(1)
  })

  it('does not mark a version whose object failed to delete', async () => {
    const { deps, marked } = fakeDeps([
      {
        image_version_id: 'gen-1',
        intake_file_id: 'file-1',
        storage_key: 'versions/file-1/v1.png',
        thumb_key: 'versions/file-1/v1_thumb.webp',
      },
    ])
    deps.store.delete = async (key: string) => {
      if (key.endsWith('_thumb.webp')) throw new Error('503 from R2')
    }
    const result = await runRetentionPurge({}, deps)
    expect(marked).toEqual([[]])
    expect(result.failures).toHaveLength(1)
    expect(result.objectsDeleted).toBe(1)
  })
})
