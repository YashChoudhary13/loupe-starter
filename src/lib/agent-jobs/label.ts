/** D143: pure helpers for the Enhance jobs page and its API. No server imports. */

export const JOB_STATUSES = ['collecting', 'queued', 'running', 'done', 'failed'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export const LABEL_MIN = 3
export const LABEL_MAX = 80
/** A queued batch nobody has claimed after this long is flagged on the page. */
export const QUEUE_STALE_MS = 30 * 60 * 1000

/** `2026-10-10 14.30` in the browser's local time — the enhance skill's own batch naming. */
export function defaultJobLabel(now: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}.${two(now.getMinutes())}`
}

export class JobInputError extends Error {}

export function parseJobLabel(raw: unknown): string {
  const label = typeof raw === 'string' ? raw.trim() : ''
  if (label.length < LABEL_MIN || label.length > LABEL_MAX) throw new JobInputError(`The batch label must be ${LABEL_MIN} to ${LABEL_MAX} characters.`)
  if (/[\u0000-\u001f\u007f/\\]/u.test(label)) throw new JobInputError('The batch label cannot contain slashes or control characters.')
  return label
}

export function parseJobStatus(raw: unknown): JobStatus {
  if (typeof raw === 'string' && (JOB_STATUSES as readonly string[]).includes(raw)) return raw as JobStatus
  throw new JobInputError('status must be collecting, queued, running, done or failed.')
}

export function parseRunner(raw: unknown): string {
  const runner = typeof raw === 'string' ? raw.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(runner)) throw new JobInputError('runner must be 1 to 40 letters, digits, dots, dashes or underscores.')
  return runner
}

export function parseLeaseSeconds(raw: unknown): number {
  if (raw === undefined || raw === null) return 1800
  if (!Number.isSafeInteger(raw) || Number(raw) < 60 || Number(raw) > 14_400) throw new JobInputError('lease_seconds must be a whole number from 60 to 14400.')
  return Number(raw)
}

export function queueIsStale(queuedAt: string | null, now: Date): boolean {
  if (!queuedAt) return false
  const t = Date.parse(queuedAt)
  return Number.isFinite(t) && now.getTime() - t > QUEUE_STALE_MS
}
