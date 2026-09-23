import { actorFor, NotAuthorisedError, requireOperatorForAction, type Operator } from '@/lib/auth/authorize'
import { serverEnv } from '@/lib/env'
import { isOwnOrigin } from '@/lib/faces/server'
import { availableActions, botConfig, consumeNonce, readConfirmToken } from '@/lib/home/actions'
import { postWebhook } from '@/lib/home/n8n'
import { supabaseServer } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const fail = (status: number, error: string) => Response.json({ ok: false, error }, { status, headers })

/** Confirm one card: the token must be valid, this user's, unexpired and unspent, and the action still connected. Every run, success or not, is logged as `home.action` (D137). */
export async function POST(request: Request) {
  let operator: Operator
  try { operator = await requireOperatorForAction() } catch (error) { return fail(error instanceof NotAuthorisedError ? 401 : 500, 'Sign in again.') }
  if (!isOwnOrigin(request.headers.get('origin'))) return fail(403, 'Open the Home dashboard to confirm.')
  if (!request.headers.get('content-type')?.startsWith('application/json')) return fail(415, 'Send JSON.')
  const text = await request.text()
  if (text.length > 8_192) return fail(413, 'Request too large.')
  let body: { token?: unknown }
  try { body = JSON.parse(text) } catch { return fail(400, 'Send JSON.') }
  const verdict = readConfirmToken(serverEnv.authSessionSecret, body.token, operator.id)
  if (!verdict.ok) return fail(400, verdict.error)
  const config = botConfig(), action = availableActions(config).find(item => item.name === verdict.payload.action)
  if (!action) return fail(409, 'That action is not connected yet.')
  if (!consumeNonce(verdict.payload.nonce, verdict.payload.exp)) return fail(409, 'That card was already confirmed.')
  let ok = true, result: string
  try { result = await action.run(verdict.payload.params, { post: postWebhook, config, actor: actorFor(operator) }) } catch (error) { ok = false; result = error instanceof Error ? error.message : 'The action failed.' }
  const { error } = await supabaseServer().from('events').insert({ entity_type: 'home_action', event: 'home.action', detail: { action: action.name, params: verdict.payload.params, ok, result }, actor: actorFor(operator) })
  if (error) console.warn('home.action not recorded:', error.message)
  return Response.json({ ok, text: result }, { status: ok ? 200 : 502, headers })
}
