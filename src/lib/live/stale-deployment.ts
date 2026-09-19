/**
 * Every `next build` gives each server action a new id. A tab opened before a deploy keeps calling
 * the old id and the new server answers "Server Action … was not found" (Next.js
 * `failed-to-find-server-action`). Nothing is wrong with the file or the pipeline; the tab is stale.
 * Client-safe: no server imports.
 */
export const STALE_DEPLOYMENT_MESSAGE = 'Loupe was updated while this tab was open. Reload the page, then try again.'

export function isStaleDeploymentError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /Server Action "?[0-9a-f]+"? was not found on the server|failed-to-find-server-action/i.test(message)
}
