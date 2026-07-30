import type { drive_v3 } from '@googleapis/drive'

import { classifyDriveError, DriveError } from './drive-errors'
import {
  type DriveChange,
  type DriveChangePage,
  type DriveFileMetadata,
  type DriveFilePage,
  type DriveHousekeeper,
  type DriveMoveOutcome,
  type DriveReader,
} from './drive-types'

export const RAW_FILE_FIELDS =
  'nextPageToken,files(id,name,md5Checksum,size,mimeType,parents,trashed)'

export const CHANGE_FIELDS =
  'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,md5Checksum,size,mimeType,parents,trashed))'

export interface DriveApiExecutor {
  getStartPageToken(
    params: drive_v3.Params$Resource$Changes$Getstartpagetoken,
  ): Promise<drive_v3.Schema$StartPageToken>
  listFiles(
    params: drive_v3.Params$Resource$Files$List,
  ): Promise<drive_v3.Schema$FileList>
  listChanges(
    params: drive_v3.Params$Resource$Changes$List,
  ): Promise<drive_v3.Schema$ChangeList>
  downloadFile(params: drive_v3.Params$Resource$Files$Get): Promise<ArrayBuffer>
  getFile(params: drive_v3.Params$Resource$Files$Get): Promise<drive_v3.Schema$File>
  updateFile(params: drive_v3.Params$Resource$Files$Update): Promise<drive_v3.Schema$File>
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function fileMetadata(file: drive_v3.Schema$File | null | undefined): DriveFileMetadata | null {
  const id = nonEmpty(file?.id)
  const name = nonEmpty(file?.name)
  if (!id || !name) return null

  return {
    id,
    name,
    md5Checksum: nonEmpty(file?.md5Checksum),
    size: nonEmpty(file?.size),
    mimeType: nonEmpty(file?.mimeType),
    parents: (file?.parents ?? []).filter(
      (parent): parent is string => typeof parent === 'string' && parent.length > 0,
    ),
    trashed: file?.trashed === true,
  }
}

function changeMetadata(change: drive_v3.Schema$Change): DriveChange {
  return {
    fileId: nonEmpty(change.fileId),
    removed: change.removed === true,
    file: fileMetadata(change.file),
  }
}

/** Drive query string escaping uses a backslash for quotes and backslashes. */
function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/**
 * Drive v3 metadata reader.
 *
 * The executor keeps generated-client overloads out of the intake domain and
 * makes pagination requests directly observable in unit tests.
 */
export class GoogleDriveClient implements DriveReader, DriveHousekeeper {
  constructor(private readonly api: DriveApiExecutor) {}

  async getStartPageToken(): Promise<string> {
    let data: drive_v3.Schema$StartPageToken
    try {
      data = await this.api.getStartPageToken({
        supportsAllDrives: true,
        fields: 'startPageToken',
      })
    } catch (error) {
      throw classifyDriveError(error, 'getting a start page token')
    }

    const token = nonEmpty(data.startPageToken)
    if (!token) {
      throw new DriveError('Google Drive returned no start page token.', {
        kind: 'malformed_response',
        retryable: false,
        detail: data,
      })
    }
    return token
  }

  async listRawFolderPage(rawFolderId: string, pageToken?: string): Promise<DriveFilePage> {
    const params: drive_v3.Params$Resource$Files$List = {
      q: `'${escapeDriveQueryValue(rawFolderId)}' in parents and trashed=false`,
      pageSize: 1000,
      fields: RAW_FILE_FIELDS,
      spaces: 'drive',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      ...(pageToken ? { pageToken } : {}),
    }

    let data: drive_v3.Schema$FileList
    try {
      data = await this.api.listFiles(params)
    } catch (error) {
      throw classifyDriveError(error, 'listing the RAW folder')
    }

    return {
      files: (data.files ?? [])
        .map(fileMetadata)
        .filter((file): file is DriveFileMetadata => file !== null),
      nextPageToken: nonEmpty(data.nextPageToken),
    }
  }

  async listChangesPage(pageToken: string): Promise<DriveChangePage> {
    let data: drive_v3.Schema$ChangeList
    try {
      data = await this.api.listChanges({
        pageToken,
        pageSize: 1000,
        fields: CHANGE_FIELDS,
        spaces: 'drive',
        includeRemoved: true,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      })
    } catch (error) {
      throw classifyDriveError(error, 'reading the change log')
    }

    return {
      changes: (data.changes ?? []).map(changeMetadata),
      nextPageToken: nonEmpty(data.nextPageToken),
      newStartPageToken: nonEmpty(data.newStartPageToken),
    }
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    if (!fileId.trim()) {
      throw new DriveError('Google Drive file ID is missing.', {
        kind: 'request',
        retryable: false,
      })
    }

    let data: ArrayBuffer
    try {
      data = await this.api.downloadFile({
        fileId,
        alt: 'media',
        supportsAllDrives: true,
      })
    } catch (error) {
      throw classifyDriveError(error, `downloading Drive file ${fileId}`)
    }

    const buffer = Buffer.from(data)
    if (buffer.byteLength === 0) {
      throw new DriveError('Google Drive returned an empty image file.', {
        kind: 'malformed_response',
        retryable: false,
        detail: { fileId },
      })
    }
    return buffer
  }

  /**
   * Moves a file into a folder, and does nothing if it is already there.
   *
   * Drive has no `move`: a file's location is its `parents` list, so the move is
   * "add the target, remove whatever it is in now" in one update. Reading the
   * current parents first is what makes a retry safe — Drive rejects
   * `removeParents` naming a folder the file is not in, so a second attempt on an
   * already-moved file would fail for no reason at all.
   *
   * Post-publish housekeeping is deliberately allowed to fail; see hard rule 3
   * and `record_drive_housekeeping`.
   */
  async moveToFolder(fileId: string, targetFolderId: string): Promise<DriveMoveOutcome> {
    if (!fileId.trim() || !targetFolderId.trim()) {
      throw new DriveError('Google Drive needs both a file and a destination folder.', {
        kind: 'request',
        retryable: false,
      })
    }

    let current: drive_v3.Schema$File
    try {
      current = await this.api.getFile({
        fileId,
        fields: 'id,name,parents,trashed',
        supportsAllDrives: true,
      })
    } catch (error) {
      throw classifyDriveError(error, `reading Drive file ${fileId}`)
    }

    const parents = (current.parents ?? []).filter(
      (parent): parent is string => typeof parent === 'string' && parent.length > 0,
    )

    if (parents.length === 1 && parents[0] === targetFolderId) {
      return { fileId, moved: false, parents }
    }

    const removeParents = parents.filter((parent) => parent !== targetFolderId)

    let updated: drive_v3.Schema$File
    try {
      updated = await this.api.updateFile({
        fileId,
        addParents: parents.includes(targetFolderId) ? undefined : targetFolderId,
        removeParents: removeParents.length > 0 ? removeParents.join(',') : undefined,
        fields: 'id,parents',
        supportsAllDrives: true,
      })
    } catch (error) {
      throw classifyDriveError(error, `moving Drive file ${fileId} into /Processed`)
    }

    return {
      fileId,
      moved: true,
      parents: (updated.parents ?? []).filter(
        (parent): parent is string => typeof parent === 'string' && parent.length > 0,
      ),
    }
  }
}
