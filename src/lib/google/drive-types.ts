/** The only Google OAuth scope Loupe requests. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'

export const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'

/**
 * The Drive metadata persisted by the intake queue.
 *
 * Drive represents `size` as a decimal string because it is an int64. Keeping it
 * as a string avoids silently rounding a value above JavaScript's safe integer
 * range before Postgres receives it.
 */
export interface DriveFileMetadata {
  readonly id: string
  readonly name: string
  readonly md5Checksum: string | null
  readonly size: string | null
  readonly mimeType: string | null
  readonly parents: readonly string[]
  readonly trashed: boolean
}

export interface DriveFilePage {
  readonly files: readonly DriveFileMetadata[]
  readonly nextPageToken: string | null
}

export interface DriveChange {
  readonly fileId: string | null
  readonly removed: boolean
  readonly file: DriveFileMetadata | null
}

export interface DriveChangePage {
  readonly changes: readonly DriveChange[]
  readonly nextPageToken: string | null
  readonly newStartPageToken: string | null
}

/**
 * Small, fakeable boundary around Drive. Intake logic depends on this interface,
 * not on the generated Google client and its many overloaded methods.
 */
export interface DriveReader {
  getStartPageToken(): Promise<string>
  listRawFolderPage(rawFolderId: string, pageToken?: string): Promise<DriveFilePage>
  listChangesPage(pageToken: string): Promise<DriveChangePage>
}
