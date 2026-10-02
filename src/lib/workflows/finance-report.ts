import 'server-only'

import { financeRange } from '@/lib/home/actions'

import type { WorkflowProgram } from './runner'
import type { DateRangeInput } from './types'

/**
 * D141 — the accountant's finance Excel for a chosen date range.
 *
 * The WhatsApp bot already owns the report: n8n workflow `umDDGkN9kkpIisLR`
 * reads Shopify one IST day at a time, builds the same sheet as the midnight
 * report, uploads it and sends it to its own allowlisted accountant plus the
 * fixed copy. Loupe only asks for it, without a `to`, so no recipient can be
 * chosen from here. The webhook answers with the accountant's send result.
 */
export const FINANCE_REPORT_WEBHOOK = 'https://n8n.qimati-eng.site/webhook/qimati-orders-range'

const UNCONFIRMED = 'It may still arrive; check WhatsApp before pressing Run again.'

export function prettyRange({ from, to }: DateRangeInput): string {
  const day = (iso: string, year: boolean) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      ...(year ? { year: 'numeric' } : {}),
      timeZone: 'UTC',
    })
  return from === to ? day(from, true) : `${day(from, from.slice(0, 4) !== to.slice(0, 4))} – ${day(to, true)}`
}

export function financeReportProgram(
  input: DateRangeInput,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): WorkflowProgram {
  let reply: unknown = null
  const range = prettyRange(input)

  return {
    steps: [
      {
        key: 'send',
        label: 'Build the Excel and send it on WhatsApp',
        async run(context) {
          const checked = financeRange({ from: input.from, to: input.to }, now())
          if (!checked.ok) throw new Error(checked.error)
          await context.report(`${range} · the bot is reading Shopify…`)

          const url = `${FINANCE_REPORT_WEBHOOK}?start=${checked.params.from}&end=${checked.params.to}`
          let response: Response
          try {
            response = await fetchImpl(url, { signal: AbortSignal.timeout(5 * 60_000), redirect: 'error' })
          } catch (cause) {
            throw new Error(`No answer from the bot (${cause instanceof Error ? cause.message : String(cause)}). ${UNCONFIRMED}`)
          }
          const text = await response.text()
          // Cloudflare stops waiting after 100 s; n8n carries on and sends.
          if (response.status === 524) {
            context.summary(`Asked for ${range}; not confirmed.`)
            return { detail: `The bot took over 100 seconds, so Loupe could not wait for its answer. ${UNCONFIRMED}`, warning: true }
          }
          if (!response.ok) {
            context.log(`n8n ${response.status}: ${text.slice(0, 300)}`)
            throw new Error(`The bot failed (${response.status}). Nothing was sent if it stopped before WhatsApp; the n8n execution has the reason.`)
          }
          try {
            reply = JSON.parse(text)
          } catch {
            throw new Error(`The bot answered something that is not JSON. ${UNCONFIRMED}`)
          }
          return 'Excel built and handed to WhatsApp.'
        },
      },
      {
        key: 'check',
        label: 'Check WhatsApp accepted it',
        async run(context) {
          if (reply === null) {
            return { detail: 'Not confirmed.', warning: true }
          }
          const send = reply as { statusCode?: unknown; body?: { messages?: { message_status?: unknown }[]; error?: { message?: unknown } } }
          const status = send.body?.messages?.[0]?.message_status
          if (send.statusCode !== 200 || (status !== 'accepted' && status !== 'sent')) {
            const reason = typeof send.body?.error?.message === 'string' ? send.body.error.message : `status ${String(send.statusCode)}`
            throw new Error(`WhatsApp refused the message: ${reason}`)
          }
          context.summary(`Sent ${range} to the accountant.`)
          return 'Accepted by WhatsApp for the accountant.'
        },
      },
    ],
  }
}
