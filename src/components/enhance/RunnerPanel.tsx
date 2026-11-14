'use client'

import { useEffect, useRef, useState } from 'react'

import { clockTime, type LoginProgress, type RunnerView, type SeatStatus } from '@/lib/agent-jobs/tracking'
import { cn } from '@/lib/utils'

import { Card, SectionLabel } from '../console/primitives'

/**
 * D170 — the Canada server on the page: its limits, what it is doing, the tail of its log, and the
 * few things a person can ask of it. When it is signed out, the sign-in happens here: a link to
 * open, a box for the code. No terminal: every button is one fixed request.
 */

const small = 'shrink-0 rounded-pill bg-chip px-3.5 py-[7px] text-[11.5px] text-ink-soft transition-colors hover:bg-[#ebebeb] disabled:opacity-45'
const black = 'shrink-0 rounded-pill bg-ink px-4 py-2 text-[12px] font-medium text-white transition-opacity disabled:opacity-45'
const amberButton = 'shrink-0 rounded-pill bg-amber px-4 py-2 text-[12px] font-medium text-white transition-opacity disabled:opacity-45'

export interface RunnerPanelProps {
  readonly runner: RunnerView | null
  readonly now: Date
  /** Sends one fixed request to the server; resolves to an error line, or null when it was accepted. */
  readonly onCommand: (kind: string, payload?: Record<string, string>) => Promise<string | null>
}

export function RunnerPanel({ runner, now, onCommand }: RunnerPanelProps) {
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ask = async (kind: string, payload?: Record<string, string>) => {
    setPending(kind); setError(null)
    try { setError(await onCommand(kind, payload)) } finally { setPending(null) }
  }
  if (!runner) return null
  const offline = runner.state === 'offline'
  const claudeOut = !offline && runner.claude !== null && !runner.claude.signedIn
  const seatsOut = offline ? [] : runner.codex.filter((c) => !c.signedIn)
  const login = runner.login && runner.login.state !== 'ok' ? runner.login : null
  const until = clockTime(runner.holdUntil, now)

  return (
    <>
      {(claudeOut || login) && (
        <SignIn login={login} claudeOut={claudeOut} pending={pending} error={error} ask={ask} />
      )}

      <Card className="p-4 md:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <SectionLabel>Limits on the server</SectionLabel>
          <span className={cn('text-[12px]', offline ? 'text-amber' : 'text-muted-foreground')}>{headline(runner, until, now)}</span>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {runner.claude && <Seat seat={runner.claude} now={now} />}
          {runner.codex.map((c) => <Seat key={c.name} seat={c} now={now} />)}
        </div>
        {!offline && seatsOut.length > 0 && !login && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {seatsOut.map((c) => (
              <button key={c.name} type="button" disabled={pending !== null} className={small} onClick={() => void ask('codex_login_start', { seat: c.name })}>Sign in {c.name}</button>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-4 md:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionLabel>Server · live log (read only)</SectionLabel>
          {!offline && (
            <div className="flex flex-wrap gap-1.5">
              {runner.holdUntil && <button type="button" disabled={pending !== null} className={small} onClick={() => void ask('try_now')}>Try now</button>}
              {runner.paused
                ? <button type="button" disabled={pending !== null} className={black} onClick={() => void ask('resume')}>Resume</button>
                : <button type="button" disabled={pending !== null} className={small} onClick={() => void ask('pause')}>Pause</button>}
            </div>
          )}
        </div>
        <Log text={runner.log} />
        {error && !claudeOut && !login && <p className="mt-2 text-[12px] text-amber">{error}</p>}
      </Card>
    </>
  )
}

function headline(runner: RunnerView, until: string | null, now: Date): string {
  switch (runner.state) {
    case 'offline': return runner.seenAt ? `The server has not reported since ${clockTime(runner.seenAt, now)}` : 'The server has not reported yet'
    case 'working': return runner.jobLabel ? `Working on ${runner.jobLabel}` : 'Working'
    case 'paused': return 'Paused by you. Nothing starts until Resume.'
    case 'limit': return until ? `Limit reached. Starts again by itself at ${until}` : 'Limit reached. Waiting for it to reset'
    case 'login': return 'Stopped until someone signs in'
    default: return 'Idle. Ready for photos'
  }
}

function Seat({ seat, now }: { seat: SeatStatus; now: Date }) {
  const p = seat.fiveHour.percent
  const resets = clockTime(seat.fiveHour.resetsAt, now)
  const full = p !== null && p >= 100
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-tile bg-chip px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <b className="truncate text-[13px] font-semibold" title={seat.account ?? undefined}>{seat.name}</b>
        <span className="text-[12px] tabular-nums text-ink-soft">{!seat.signedIn ? 'signed out' : p === null ? 'unknown' : `${p}%`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-pill bg-[#e2e2e2]" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p ?? 0} aria-label={`${seat.name} 5-hour use`}>
        <span className={cn('block h-full rounded-pill', full ? 'bg-amber' : 'bg-ink')} style={{ width: `${p ?? 0}%` }} />
      </div>
      <span className="text-[11.5px] leading-snug text-muted-foreground">
        {!seat.signedIn ? (seat.error ?? 'Needs a sign-in')
          : seat.error ? seat.error
          : `5-hour window${resets ? ` · resets ${resets}` : ''}${seat.week.percent !== null ? ` · week ${seat.week.percent}%` : ''}`}
      </span>
    </div>
  )
}

/** The one black panel of the screen. Stays at the newest line unless the reader scrolled up. */
function Log({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [text])
  return (
    <pre ref={ref} tabIndex={0} aria-label="Server log"
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }}
      className="mt-3 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-panel bg-ink px-4 py-3.5 font-mono text-[11.5px] leading-[1.7] text-[#d8d8d8]">
      {text.trim() || 'Nothing logged yet.'}
    </pre>
  )
}

function SignIn({ login, claudeOut, pending, error, ask }: {
  login: LoginProgress | null; claudeOut: boolean; pending: string | null; error: string | null
  ask: (kind: string, payload?: Record<string, string>) => Promise<void>
}) {
  const [code, setCode] = useState('')
  const target = login?.target ?? 'claude'
  const isClaude = target === 'claude'
  const name = isClaude ? 'Claude' : target
  const waiting = pending !== null
  return (
    <section className="flex flex-col gap-3 rounded-card bg-[#faf2e4] p-5" role="alert">
      <h2 className="text-[16px] font-semibold text-amber">
        {login ? `Signing in ${name} on the server` : 'Claude is signed out on the server'}
      </h2>
      <p className="text-[12.5px] leading-relaxed text-ink-soft">Nothing is lost. The photos wait in the queue and start by themselves after the sign-in.</p>

      {!login && claudeOut && (
        <button type="button" disabled={waiting} className={cn(amberButton, 'self-start')} onClick={() => void ask('claude_login_start')}>
          {pending === 'claude_login_start' ? 'Asking the server…' : 'Start sign-in'}
        </button>
      )}
      {login?.state === 'starting' && <p className="text-[12.5px] text-ink-soft">Preparing the sign-in page. A few seconds.</p>}
      {login?.state === 'checking' && <p className="text-[12.5px] text-ink-soft">Checking the sign-in. A few seconds.</p>}

      {login?.state === 'awaiting_code' && (
        <ol className="flex flex-col gap-3">
          <Step n={1}>
            <span>Open the sign-in page and sign in with the {name} account.</span>
            {login.url
              ? <a href={login.url} target="_blank" rel="noreferrer" className={cn(amberButton, 'self-start')}>Open sign-in page</a>
              : <span className="text-amber">The server sent no link. Start again.</span>}
          </Step>
          {isClaude ? (
            <Step n={2}>
              <label htmlFor="runner-login-code">Paste the code it shows you.</label>
              <input id="runner-login-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false}
                placeholder="Code from the sign-in page"
                className="h-11 w-full min-w-0 rounded-field border border-[#e2d3b6] bg-white px-3.5 text-[14px] text-ink focus:outline-2 focus:outline-ink" />
              <button type="button" disabled={waiting || code.trim().length < 8} className={cn(black, 'self-start')}
                onClick={() => { void ask('claude_login_code', { code: code.trim() }).then(() => setCode('')) }}>
                {pending === 'claude_login_code' ? 'Sending…' : 'Finish sign-in'}
              </button>
            </Step>
          ) : (
            <Step n={2}>
              <span>Type this code on that page. The server notices by itself when you are done.</span>
              <span className="select-all self-start rounded-field bg-white px-3.5 py-2 font-mono text-[16px] font-medium tracking-[0.08em] text-ink">{login.code ?? '…'}</span>
            </Step>
          )}
        </ol>
      )}

      {login?.state === 'failed' && (
        <>
          <p className="text-[12.5px] text-amber">{login.message ?? 'The sign-in did not go through.'}</p>
          <button type="button" disabled={waiting} className={cn(amberButton, 'self-start')}
            onClick={() => void ask(isClaude ? 'claude_login_start' : 'codex_login_start', isClaude ? undefined : { seat: target })}>Start again</button>
        </>
      )}
      {login && login.state !== 'failed' && (
        <button type="button" disabled={waiting} className="self-start text-[11.5px] text-ink-soft underline underline-offset-2" onClick={() => void ask('login_cancel')}>Cancel this sign-in</button>
      )}
      {error && <p className="text-[12px] text-amber">{error}</p>}
    </section>
  )
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-[12.5px] text-ink-soft">
      <span className="grid size-[22px] shrink-0 place-items-center rounded-full bg-amber text-[11px] font-semibold text-white" aria-hidden>{n}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">{children}</div>
    </li>
  )
}
