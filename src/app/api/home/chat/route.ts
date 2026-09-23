import { actorFor, NotAuthorisedError, requireOperatorForAction, type Operator } from '@/lib/auth/authorize'
import { serverEnv } from '@/lib/env'
import { isOwnOrigin } from '@/lib/faces/server'
import { availableActions, botConfig } from '@/lib/home/actions'
import { readBoundedBody } from '@/lib/home/body'
import { DEFAULT_MODEL, rateLimiter, runChatTurn, systemPrompt, type ChatEvent, type ChatMessage, type TurnUsage } from '@/lib/home/chat'
import { homeSnapshot, homeToolContext } from '@/lib/home/server'
import { READ_TOOLS } from '@/lib/home/tools'
import { supabaseServer } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 120
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const limiter = rateLimiter()
const fail = (status: number, error: string) => Response.json({ error }, { status, headers })
const isMessage = (value: unknown): value is ChatMessage => !!value && typeof value === 'object' && ['user', 'assistant'].includes(String((value as ChatMessage).role)) && typeof (value as ChatMessage).content === 'string'

/** One question in; a stream of NDJSON events out — status lines while tools run, confirm cards for proposed actions, the answer, then `done` (D137). */
export async function POST(request: Request) {
  let operator: Operator
  try { operator = await requireOperatorForAction() } catch (error) {
    if (error instanceof NotAuthorisedError) return fail(401, 'Sign in again to chat.')
    console.error('home route auth failed:', error)
    return fail(500, 'Sign in again to chat.')
  }
  if (!isOwnOrigin(request.headers.get('origin'))) return fail(403, 'Open the Home dashboard to chat.')
  if (!request.headers.get('content-type')?.startsWith('application/json')) return fail(415, 'Send JSON.')
  const text = await readBoundedBody(request, 65_536)
  if (text === null) return fail(413, 'That conversation is too long. Start a new one.')
  let body: { messages?: unknown; message?: unknown }
  try { body = JSON.parse(text) } catch { return fail(400, 'Send JSON.') }
  if (!body || typeof body !== 'object') return fail(400, 'Send JSON.')
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) return fail(400, 'Say something first.')
  const history = (Array.isArray(body.messages) ? body.messages : []).filter(isMessage)
  if (!limiter.allow(operator.id)) return fail(429, 'Sixty questions an hour is the limit here. Try again later.')
  const model = process.env.HOME_CHAT_MODEL?.trim() || DEFAULT_MODEL
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ChatEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      // A failed insert must never take down the stream — it's a best-effort cost/audit line, logged in its own try/catch on both paths below.
      const log = async (detail: Record<string, unknown>) => {
        try {
          const { error } = await supabaseServer().from('events').insert({ entity_type: 'home_chat', event: 'home.chat_turn', detail, actor: actorFor(operator) })
          if (error) console.warn('home.chat_turn not recorded:', error.message)
        } catch (logError) { console.warn('home.chat_turn not recorded:', logError) }
      }
      try {
        const snapshot = await homeSnapshot(), actions = availableActions(botConfig())
        const usage = await runChatTurn({ apiKey: serverEnv.openRouterApiKey, model, system: systemPrompt({ now: new Date(), lights: snapshot.lights, numbers: snapshot.numbers, actions }), history, message, tools: READ_TOOLS, actions, ctx: homeToolContext(), uid: operator.id, secret: serverEnv.authSessionSecret, emit })
        await log({ ...usage, ok: true })
        emit({ type: 'done', usage })
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'The assistant failed.'
        console.warn('home chat turn failed:', reason)
        const usage = (error as { usage?: TurnUsage })?.usage ?? { model, promptTokens: null, completionTokens: null, cost: null, toolCalls: 0 }
        await log({ ...usage, ok: false, error: reason })
        emit({ type: 'error', text: reason })
      } finally { controller.close() }
    },
  })
  return new Response(stream, { headers: { ...headers, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' } })
}
