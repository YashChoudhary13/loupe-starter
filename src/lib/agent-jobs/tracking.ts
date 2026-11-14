/** D170: pure shapes and readers for per-photo tracking and the runner's report. No server imports. */

import { JobInputError } from './label'

export const PHOTO_STATES = ['waiting', 'working', 'done', 'restock', 'failed', 'cancelled'] as const
export type PhotoState = (typeof PHOTO_STATES)[number]

export function parsePhotoState(raw: unknown): PhotoState {
  return (PHOTO_STATES as readonly unknown[]).includes(raw) ? (raw as PhotoState) : 'waiting'
}

export type PhotoCounts = Readonly<Record<PhotoState, number>>
export const NO_COUNTS: PhotoCounts = { waiting: 0, working: 0, done: 0, restock: 0, failed: 0, cancelled: 0 }

export function countPhotos(states: readonly PhotoState[]): PhotoCounts {
  const counts = { ...NO_COUNTS }
  for (const state of states) counts[state] += 1
  return counts
}

export const totalPhotos = (c: PhotoCounts): number => c.waiting + c.working + c.done + c.restock + c.failed + c.cancelled
/** Done for the owner's purposes: a render in Pending or a card in Restock. */
export const finishedPhotos = (c: PhotoCounts): number => c.done + c.restock
export const leftPhotos = (c: PhotoCounts): number => c.waiting + c.working + c.failed

export interface JobPhoto {
  readonly id: string
  readonly filename: string
  readonly state: PhotoState
  readonly attempts: number
  readonly lastError: string | null
  readonly hasThumb: boolean
}

/** What the owner reads under a photograph. */
export function photoReason(photo: JobPhoto, jobStatus: string): string {
  switch (photo.state) {
    case 'done': return 'Rendered and delivered. It is in Pending in the Console.'
    case 'restock': return 'Looks like a piece the shop already has. It went to the Restock section for your choice.'
    case 'working': return jobStatus === 'running' ? 'Being worked on now.' : 'Was being worked on when the run stopped. It goes again by itself.'
    case 'cancelled': return 'Cancelled by you. It was not rendered.'
    case 'failed': return `Tried ${photo.attempts} times and stopped. ${photo.lastError ?? 'No reason was recorded.'}`
    default:
      return photo.attempts > 0
        ? `Back in the queue after try ${photo.attempts} of 3. ${photo.lastError ?? ''}`.trim()
        : 'Waiting for its turn.'
  }
}

// ---------------------------------------------------------------------------------------------
// The runner's report

export interface LimitWindow {
  /** 0–100, or null when the runner could not read it. */
  readonly percent: number | null
  readonly resetsAt: string | null
}

export interface SeatStatus {
  readonly name: string
  readonly account: string | null
  readonly signedIn: boolean
  readonly fiveHour: LimitWindow
  readonly week: LimitWindow
  readonly error: string | null
}

export type LoginState = 'starting' | 'awaiting_code' | 'checking' | 'ok' | 'failed'
export interface LoginProgress {
  readonly target: string
  readonly state: LoginState
  readonly url: string | null
  /** Codex shows a short code to type on its page; Claude shows none (its page gives a code to paste back). */
  readonly code: string | null
  readonly message: string | null
}

export type RunnerState = 'idle' | 'working' | 'paused' | 'limit' | 'login' | 'offline'

export interface RunnerView {
  readonly runner: string
  readonly state: RunnerState
  readonly seenAt: string | null
  readonly paused: boolean
  readonly holdUntil: string | null
  readonly holdReason: string | null
  readonly jobLabel: string | null
  readonly claude: SeatStatus | null
  readonly codex: readonly SeatStatus[]
  readonly login: LoginProgress | null
  readonly log: string
}

/** The runner reports every ten seconds; silent for this long means the page says so. */
export const RUNNER_SILENT_MS = 90_000

const str = (v: unknown, max = 300): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const iso = (v: unknown): string | null => {
  const s = str(v, 40)
  return s && Number.isFinite(Date.parse(s)) ? new Date(Date.parse(s)).toISOString() : null
}
const pct = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null)
const httpsUrl = (v: unknown): string | null => {
  const s = str(v, 2000)
  return s && /^https:\/\/[^\s<>"']+$/u.test(s) ? s : null
}

function seat(raw: unknown, fallbackName: string): SeatStatus {
  const o = obj(raw)
  return {
    name: str(o.name, 40) ?? fallbackName,
    account: str(o.account, 120),
    signedIn: o.signed_in === true,
    fiveHour: { percent: pct(o.five_hour), resetsAt: iso(o.five_hour_resets) },
    week: { percent: pct(o.week), resetsAt: iso(o.week_resets) },
    error: str(o.error),
  }
}

const LOGIN_STATES: readonly LoginState[] = ['starting', 'awaiting_code', 'checking', 'ok', 'failed']
const RUNNER_STATES: readonly RunnerState[] = ['idle', 'working', 'paused', 'limit', 'login']

/** Reads the stored report defensively: it is written by a script on another machine. */
export function parseRunnerView(row: { runner: string; status: unknown; log: unknown; seen_at: string | null } | null, now: Date): RunnerView | null {
  if (!row) return null
  const s = obj(row.status)
  const seen = iso(row.seen_at)
  const silent = !seen || now.getTime() - Date.parse(seen) > RUNNER_SILENT_MS
  const loginRaw = obj(s.login)
  const loginState = LOGIN_STATES.find((x) => x === loginRaw.state)
  const reported = RUNNER_STATES.find((x) => x === s.state) ?? 'idle'
  return {
    runner: row.runner,
    state: silent ? 'offline' : reported,
    seenAt: seen,
    paused: s.paused === true,
    holdUntil: iso(s.hold_until),
    holdReason: str(s.hold_reason),
    jobLabel: str(obj(s.job).label, 80),
    claude: s.claude ? seat(s.claude, 'Claude') : null,
    codex: Array.isArray(s.codex) ? s.codex.slice(0, 6).map((c, i) => seat(c, `Codex ${i + 1}`)) : [],
    login: loginState ? { target: str(loginRaw.target, 40) ?? 'claude', state: loginState, url: httpsUrl(loginRaw.url), code: str(loginRaw.code, 40), message: str(loginRaw.message) } : null,
    log: typeof row.log === 'string' ? row.log : '',
  }
}

/** Does the server need a person? Sign-in is the one thing only the owner can do. */
export function runnerNeedsPerson(view: RunnerView | null): boolean {
  if (!view || view.state === 'offline') return false
  if (view.claude && !view.claude.signedIn) return true
  return view.codex.length > 0 && view.codex.every((c) => !c.signedIn)
}

// ---------------------------------------------------------------------------------------------
// Commands the page may send. Fixed kinds; nothing here is ever run as text on the server.

export const RUNNER_COMMANDS = ['pause', 'resume', 'try_now', 'claude_login_start', 'claude_login_code', 'codex_login_start', 'login_cancel'] as const
export type RunnerCommandKind = (typeof RUNNER_COMMANDS)[number]

export function parseRunnerCommand(kind: unknown, payload: unknown): { kind: RunnerCommandKind; payload: Record<string, string> } {
  if (!(RUNNER_COMMANDS as readonly unknown[]).includes(kind)) throw new JobInputError('That is not something the server can be asked to do.')
  const k = kind as RunnerCommandKind
  const p = obj(payload)
  if (k === 'claude_login_code') {
    // What Claude's sign-in page shows: letters, digits, dashes, underscores and one '#'.
    const code = typeof p.code === 'string' ? p.code.trim() : ''
    if (!/^[A-Za-z0-9_-]{8,200}(#[A-Za-z0-9_-]{8,200})?$/u.test(code)) throw new JobInputError('Paste the whole code from the sign-in page, nothing else.')
    return { kind: k, payload: { code } }
  }
  if (k === 'codex_login_start') {
    const seatName = typeof p.seat === 'string' ? p.seat.trim() : ''
    if (!/^codex-[1-9]$/u.test(seatName)) throw new JobInputError('Pick which Codex seat to sign in.')
    return { kind: k, payload: { seat: seatName } }
  }
  return { kind: k, payload: {} }
}

export const PASS_OUTCOMES = ['ok', 'limit', 'login', 'error'] as const
export type PassOutcome = (typeof PASS_OUTCOMES)[number]

export function parsePassOutcome(raw: unknown): PassOutcome {
  if ((PASS_OUTCOMES as readonly unknown[]).includes(raw)) return raw as PassOutcome
  throw new JobInputError('outcome must be ok, limit, login or error.')
}

export function parseResumeAt(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  const t = typeof raw === 'string' ? Date.parse(raw) : Number.NaN
  if (!Number.isFinite(t)) throw new JobInputError('resume_at must be an ISO time.')
  return new Date(t).toISOString()
}

export function parseMaxPhotos(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null
  if (!Number.isSafeInteger(raw) || Number(raw) < 1 || Number(raw) > 1000) throw new JobInputError('max_photos must be a whole number from 1 to 1000.')
  return Number(raw)
}

/** `3:10 pm`, or `Sat 3:10 pm` when it is not today, in the viewer's own time zone. */
export function clockTime(isoTime: string | null, now: Date): string | null {
  if (!isoTime) return null
  const t = new Date(isoTime)
  if (!Number.isFinite(t.getTime())) return null
  const time = t.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })
  return t.toDateString() === now.toDateString() ? time : `${t.toLocaleDateString('en-IN', { weekday: 'short' })} ${time}`
}
