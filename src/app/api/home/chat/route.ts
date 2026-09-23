import { actorFor, NotAuthorisedError, requireOperatorForAction, type Operator } from '@/lib/auth/authorize'
import { serverEnv } from '@/lib/env'
import { isOwnOrigin } from '@/lib/faces/server'
import { availableActions, botConfig } from '@/lib/home/actions'
import { DEFAULT_MODEL, rateLimiter, runChatTurn, systemPrompt, type ChatEvent, type ChatMessage } from '@/lib/home/chat'
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
  try { operator = await requireOperatorForAction() } catch (error) { return fail(error instanceof NotAuthorisedError ? 401 : 500, 'Sign in again to chat.') }
  if (!isOwnOrigin(request.headers.get('origin'))) return fail(403, 'Open the Home dashboard to chat.')
  if (!request.headers.get('content-type')?.startsWith('application/json')) return fail(415, 'Send JSON.')
  const text = await request.text()
  if (text.length > 65_536) return fail(413, 'That conversation is too long. Start a new one.')
  let body: { messages?: unknown; message?: unknown }
  try { body = JSON.parse(text) } catch { return fail(400, 'Send JSON.') }
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) return fail(400, 'Say something first.')
  const history = (Array.isArray(body.messages) ? body.messages : []).filter(isMessage)
  if (!limiter.allow(operator.id)) return fail(429, 'Sixty questions an hour is the limit here. Try again later.')
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ChatEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      try {
        const snapshot = await homeSnapshot(), actions = availableActions(botConfig())
        const usage = await runChatTurn({ apiKey: serverEnv.openRouterApiKey, model: process.env.HOME_CHAT_MODEL?.trim() || DEFAULT_MODEL, system: systemPrompt({ now: new Date(), lights: snapshot.lights, numbers: snapshot.numbers, actions }), history, message, tools: READ_TOOLS, actions, ctx: homeToolContext(), uid: operator.id, secret: serverEnv.authSessionSecret, emit })
        const { error } = await supabaseServer().from('events').insert({ entity_type: 'home_chat', event: 'home.chat_turn', detail: usage, actor: actorFor(operator) })
        if (error) console.warn('home.chat_turn not recorded:', error.message)
        emit({ type: 'done', usage })
      } catch (error) { emit({ type: 'error', text: error instanceof Error ? error.message : 'The assistant failed.' }) }
      finally { controller.close() }
    },
  })
  return new Response(stream, { headers: { ...headers, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' } })
}
