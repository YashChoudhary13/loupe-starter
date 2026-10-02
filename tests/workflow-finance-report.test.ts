import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { FINANCE_REPORT_WEBHOOK, financeReportProgram, prettyRange } from '@/lib/workflows/finance-report'
import type { StepContext } from '@/lib/workflows/runner'

const now = () => new Date('2026-10-03T06:00:00Z')

async function run(input: { from: string; to: string }, respond: () => Promise<Response>) {
  const calls: string[] = []
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url))
    return respond()
  }) as unknown as typeof fetch
  let summary: string | null = null
  const context: StepContext = { actor: 'a@b', report: async () => {}, log: () => {}, section: () => {}, summary: (text) => { summary = text } }
  const outcomes: unknown[] = []
  for (const step of financeReportProgram(input, fetchImpl, now).steps) {
    try {
      outcomes.push(await step.run(context))
    } catch (cause) {
      outcomes.push({ thrown: (cause as Error).message })
      break
    }
  }
  return { calls, outcomes, summary }
}

const sent = (status: string) => Response.json({ statusCode: 200, body: { messages: [{ id: 'wamid.x', message_status: status }] } })

describe('finance report workflow (D141)', () => {
  it('asks the bot for both dates without a recipient and confirms the accepted send', async () => {
    const result = await run({ from: '2026-09-01', to: '2026-10-01' }, async () => sent('accepted'))
    expect(result.calls).toEqual([`${FINANCE_REPORT_WEBHOOK}?start=2026-09-01&end=2026-10-01`])
    expect(result.outcomes).toEqual(['Excel built and handed to WhatsApp.', 'Accepted by WhatsApp for the accountant.'])
    expect(result.summary).toBe('Sent 1 Sept – 1 Oct 2026 to the accountant.')
  })

  it('refuses a bad range before calling the bot', async () => {
    const future = await run({ from: '2026-10-01', to: '2026-10-04' }, async () => sent('accepted'))
    expect(future.calls).toEqual([])
    expect(future.outcomes).toEqual([{ thrown: expect.stringMatching(/future/) }])
    const injected = await run({ from: '2026-09-01&to=1', to: '2026-09-02' }, async () => sent('accepted'))
    expect(injected.calls).toEqual([])
  })

  it('fails on a bot error and on a WhatsApp refusal', async () => {
    const broken = await run({ from: '2026-09-01', to: '2026-09-02' }, async () => new Response('{"message":"Error in workflow"}', { status: 500 }))
    expect(broken.outcomes).toEqual([{ thrown: expect.stringMatching(/bot failed \(500\)/) }])
    const refused = await run({ from: '2026-09-01', to: '2026-09-02' }, async () =>
      Response.json({ statusCode: 400, body: { error: { message: 'Template paused' } } }))
    expect(refused.outcomes[1]).toEqual({ thrown: 'WhatsApp refused the message: Template paused' })
  })

  it('warns, never fails, when Cloudflare stops waiting', async () => {
    const slow = await run({ from: '2026-07-03', to: '2026-10-02' }, async () => new Response('timeout', { status: 524 }))
    expect(slow.outcomes).toEqual([
      { detail: expect.stringMatching(/check WhatsApp/), warning: true },
      { detail: 'Not confirmed.', warning: true },
    ])
    expect(slow.summary).toBe('Asked for 3 Jul – 2 Oct 2026; not confirmed.')
  })

  it('writes short ranges plainly', () => {
    expect(prettyRange({ from: '2026-10-02', to: '2026-10-02' })).toBe('2 Oct 2026')
    expect(prettyRange({ from: '2025-12-20', to: '2026-01-05' })).toBe('20 Dec 2025 – 5 Jan 2026')
  })
})
