import type { drive_v3 } from '@googleapis/drive'
import { describe, expect, it } from 'vitest'

import {
  CHANGE_FIELDS,
  type DriveApiExecutor,
  GoogleDriveClient,
  RAW_FILE_FIELDS,
} from '@/lib/google/drive-client'
import { classifyDriveError, DriveError } from '@/lib/google/drive-errors'
import { DRIVE_SCOPE } from '@/lib/google/drive-types'

describe('GoogleDriveClient', () => {
  it('lists RAW with the exact parent query, metadata fields and pagination', async () => {
    const requests: drive_v3.Params$Resource$Files$List[] = []
    const api: DriveApiExecutor = {
      getStartPageToken: async () => ({ startPageToken: 'unused' }),
      listChanges: async () => ({ changes: [] }),
      listFiles: async (params) => {
        requests.push(params)
        return {
          nextPageToken: 'PAGE-2',
          files: [
            {
              id: 'file-1',
              name: 'one.jpg',
              md5Checksum: 'abc',
              size: '123',
              mimeType: 'image/jpeg',
              parents: ['RAW'],
              trashed: false,
            },
          ],
        }
      },
    }

    const page = await new GoogleDriveClient(api).listRawFolderPage('RAW', 'PAGE-1')

    expect(requests).toEqual([
      {
        q: "'RAW' in parents and trashed=false",
        pageSize: 1000,
        fields: RAW_FILE_FIELDS,
        spaces: 'drive',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        pageToken: 'PAGE-1',
      },
    ])
    expect(requests[0]?.q).not.toContain('modifiedTime')
    expect(page).toEqual({
      nextPageToken: 'PAGE-2',
      files: [
        {
          id: 'file-1',
          name: 'one.jpg',
          md5Checksum: 'abc',
          size: '123',
          mimeType: 'image/jpeg',
          parents: ['RAW'],
          trashed: false,
        },
      ],
    })
  })

  it('requests parents and all-drive removals on every change page', async () => {
    const requests: drive_v3.Params$Resource$Changes$List[] = []
    const api: DriveApiExecutor = {
      getStartPageToken: async () => ({ startPageToken: 'unused' }),
      listFiles: async () => ({ files: [] }),
      listChanges: async (params) => {
        requests.push(params)
        return {
          changes: [
            {
              fileId: 'file-2',
              removed: false,
              file: {
                id: 'file-2',
                name: 'two.png',
                parents: ['RAW'],
                mimeType: 'image/png',
                trashed: false,
              },
            },
          ],
          nextPageToken: 'NEXT',
        }
      },
    }

    const page = await new GoogleDriveClient(api).listChangesPage('CURSOR')

    expect(requests).toEqual([
      {
        pageToken: 'CURSOR',
        pageSize: 1000,
        fields: CHANGE_FIELDS,
        spaces: 'drive',
        includeRemoved: true,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      },
    ])
    expect(CHANGE_FIELDS).toContain('parents')
    expect(page.changes[0]?.file?.parents).toEqual(['RAW'])
    expect(page.nextPageToken).toBe('NEXT')
  })

  it('uses Drive v3 with the one exact OAuth scope required by the worker', () => {
    expect(DRIVE_SCOPE).toBe('https://www.googleapis.com/auth/drive')
  })
})

describe('Drive error classification', () => {
  it.each(['rateLimitExceeded', 'userRateLimitExceeded'])(
    'treats HTTP 403 reason %s as retryable throttling',
    (reason) => {
      const raw = {
        response: {
          status: 403,
          data: { error: { errors: [{ reason, message: 'raw upstream detail' }] } },
        },
      }

      const error = classifyDriveError(raw, 'listing changes')
      expect(error).toMatchObject({
        kind: 'rate_limited',
        retryable: true,
        status: 403,
      })
      expect(error.message).not.toContain('raw upstream detail')
      expect(error.detail).toBe(raw)
    },
  )

  it('treats an insufficient-permission 403 and a 404 as permanent', () => {
    expect(
      classifyDriveError(
        {
          response: {
            status: 403,
            data: { error: { errors: [{ reason: 'insufficientPermissions' }] } },
          },
        },
        'listing RAW',
      ),
    ).toMatchObject({ kind: 'permission', retryable: false, status: 403 })

    expect(
      classifyDriveError({ response: { status: 404 } }, 'listing RAW'),
    ).toMatchObject({ kind: 'not_found', retryable: false, status: 404 })
  })

  it('treats 429, 5xx, timeout and network faults as retryable', () => {
    expect(classifyDriveError({ response: { status: 429 } }, 'polling')).toMatchObject({
      retryable: true,
      kind: 'rate_limited',
    })
    expect(classifyDriveError({ response: { status: 503 } }, 'polling')).toMatchObject({
      retryable: true,
      kind: 'server',
    })
    expect(classifyDriveError({ code: 'ETIMEDOUT' }, 'polling')).toMatchObject({
      retryable: true,
      kind: 'timeout',
    })
    expect(classifyDriveError({ code: 'ECONNRESET' }, 'polling')).toMatchObject({
      retryable: true,
      kind: 'network',
    })
    expect(classifyDriveError(new TypeError('fetch failed'), 'polling')).toMatchObject({
      retryable: true,
      kind: 'network',
    })
  })

  it('keeps an existing classified error intact', () => {
    const original = new DriveError('safe', {
      kind: 'permission',
      retryable: false,
      detail: { raw: true },
    })
    expect(classifyDriveError(original, 'anything')).toBe(original)
  })
})
