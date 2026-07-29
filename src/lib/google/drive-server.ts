import 'server-only'

import { auth, drive } from '@googleapis/drive'

import { GoogleDriveClient } from '@/lib/google/drive-client'
import { googleServiceAccount } from '@/lib/google/service-account'

import { DRIVE_SCOPE } from './drive-types'

let cached: GoogleDriveClient | undefined

/**
 * Creates the production Drive v3 client behind a structural server-only wall.
 *
 * Credential validation happens synchronously before the first network request;
 * GoogleAuth receives the validated service-account fields explicitly and only
 * the one full-Drive scope required by this phase.
 */
export function googleDriveClient(): GoogleDriveClient {
  if (cached) return cached

  const serviceAccount = googleServiceAccount()
  const authorization = new auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: [DRIVE_SCOPE],
  })
  const client = drive({ version: 'v3', auth: authorization })

  cached = new GoogleDriveClient({
    getStartPageToken: async (params) => (await client.changes.getStartPageToken(params)).data,
    listFiles: async (params) => (await client.files.list(params)).data,
    listChanges: async (params) => (await client.changes.list(params)).data,
    downloadFile: async (params) =>
      (
        await client.files.get(params, {
          responseType: 'arraybuffer',
        })
      ).data as ArrayBuffer,
  })
  return cached
}
