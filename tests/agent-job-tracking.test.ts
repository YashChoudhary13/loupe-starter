import { describe, expect, it } from 'vitest'

import { JobInputError } from '@/lib/agent-jobs/label'
import {
  countPhotos, finishedPhotos, leftPhotos, parseMaxPhotos, parsePassOutcome, parseResumeAt, parseRunnerCommand, parseRunnerView,
  photoReason, runnerNeedsPerson, totalPhotos,
} from '@/lib/agent-jobs/tracking'

const NOW = new Date('2026-11-14T08:00:00Z')
const row = (status: unknown, seen = '2026-11-14T07:59:55Z') => ({ runner: 'canada-1', status, log: 'line', seen_at: seen })

describe('D170 photo counts', () => {
  it('adds up done, left and total', () => {
    const c = countPhotos(['done', 'done', 'restock', 'working', 'waiting', 'failed'])
    expect([totalPhotos(c), finishedPhotos(c), leftPhotos(c)]).toEqual([6, 3, 3])
  })
  it('says why a photograph is where it is', () => {
    const base = { id: 'x', filename: 'a.jpg', hasThumb: false }
    expect(photoReason({ ...base, state: 'failed', attempts: 3, lastError: 'Codex refused it.' }, 'done')).toBe('Tried 3 times and stopped. Codex refused it.')
    expect(photoReason({ ...base, state: 'waiting', attempts: 1, lastError: 'Out of credits.' }, 'queued')).toBe('Back in the queue after try 1 of 3. Out of credits.')
    expect(photoReason({ ...base, state: 'waiting', attempts: 0, lastError: null }, 'queued')).toBe('Waiting for its turn.')
  })
})

describe('D170 runner report', () => {
  it('reads limits, sign-in and the login step', () => {
    const view = parseRunnerView(row({
      state: 'login', paused: false, hold_until: '2026-11-14T11:53:00Z',
      claude: { signed_in: false, error: 'OAuth session expired' },
      codex: [{ name: 'codex-1', account: 'a@example.test', signed_in: true, five_hour: 52.4, five_hour_resets: '2026-11-14T11:53:00Z', week: 9 }],
      login: { target: 'claude', state: 'awaiting_code', url: 'https://claude.com/cai/oauth/authorize?code=true' },
    }), NOW)
    expect(view?.state).toBe('login')
    expect(view?.claude?.signedIn).toBe(false)
    expect(view?.codex[0]).toMatchObject({ name: 'codex-1', signedIn: true, fiveHour: { percent: 52, resetsAt: '2026-11-14T11:53:00.000Z' }, week: { percent: 9 } })
    expect(view?.login).toMatchObject({ target: 'claude', state: 'awaiting_code', url: 'https://claude.com/cai/oauth/authorize?code=true' })
    expect(runnerNeedsPerson(view ?? null)).toBe(true)
  })
  it('calls a silent server offline and asks nobody', () => {
    const view = parseRunnerView(row({ state: 'working', claude: { signed_in: false } }, '2026-11-14T07:50:00Z'), NOW)
    expect(view?.state).toBe('offline')
    expect(runnerNeedsPerson(view ?? null)).toBe(false)
  })
  it('drops a link that is not https and survives rubbish', () => {
    expect(parseRunnerView(row({ login: { target: 'claude', state: 'awaiting_code', url: 'javascript:alert(1)' } }), NOW)?.login?.url).toBeNull()
    expect(parseRunnerView(row('nonsense'), NOW)).toMatchObject({ state: 'idle', claude: null, codex: [], login: null })
    expect(parseRunnerView(null, NOW)).toBeNull()
  })
})

describe('D170 commands and pass input', () => {
  it('takes only the fixed kinds', () => {
    expect(parseRunnerCommand('pause', { anything: 'x' })).toEqual({ kind: 'pause', payload: {} })
    expect(() => parseRunnerCommand('run', { cmd: 'rm -rf /' })).toThrow(JobInputError)
  })
  it('takes a sign-in code and nothing shaped like a command', () => {
    expect(parseRunnerCommand('claude_login_code', { code: ' qrJkVXBF79r7XwGZ#P5iGaZynQU5NmfA0 ' }).payload.code).toBe('qrJkVXBF79r7XwGZ#P5iGaZynQU5NmfA0')
    for (const bad of ['', 'short', 'abc def ghi jkl', 'aaaaaaaa; reboot', 'aaaaaaaa\nbbbbbbbb', '$(whoami)aaaaaaaa'])
      expect(() => parseRunnerCommand('claude_login_code', { code: bad })).toThrow(JobInputError)
  })
  it('names a Codex seat exactly', () => {
    expect(parseRunnerCommand('codex_login_start', { seat: 'codex-2' }).payload).toEqual({ seat: 'codex-2' })
    expect(() => parseRunnerCommand('codex_login_start', { seat: '../etc' })).toThrow(JobInputError)
  })
  it('checks outcome, resume time and photo cap', () => {
    expect(parsePassOutcome('limit')).toBe('limit')
    expect(() => parsePassOutcome('done')).toThrow(JobInputError)
    expect(parseResumeAt('2026-11-14T11:53:00Z')).toBe('2026-11-14T11:53:00.000Z')
    expect(parseResumeAt(null)).toBeNull()
    expect(() => parseResumeAt('soon')).toThrow(JobInputError)
    expect(parseMaxPhotos(undefined)).toBeNull()
    expect(parseMaxPhotos(15)).toBe(15)
    expect(() => parseMaxPhotos(0)).toThrow(JobInputError)
  })
})
