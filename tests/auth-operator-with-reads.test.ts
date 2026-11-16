/**
 * D174 — a page's sign-in check and its reads go out together, and the check still decides what is shown.
 *
 * Before, every screen waited for the `app_users` round trip and only then started reading: one database round
 * trip in front of every click. The properties that must survive putting them side by side:
 *   - no session cookie: nothing is read at all;
 *   - a session whose operator has been deactivated: redirected on this very request, whatever the reads returned (D44);
 *   - a read that fails is the operator's error to see, never an answer to somebody who is not allowed in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const SECRET = 'a'.repeat(64)
const state = vi.hoisted(() => ({ cookie: undefined as string | undefined, user: null as null | { id: string; email: string; name: string | null; role: 'operator'; active: boolean }, lookups: 0, release: null as null | (() => void) }))
vi.mock('server-only', () => ({}))
vi.mock('react', async importOriginal => ({ ...(await importOriginal<typeof import('react')>()), cache: <T>(fn: T) => fn }))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => (state.cookie ? { value: state.cookie } : undefined) }) }))
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`REDIRECT ${to}`) } }))
vi.mock('@/lib/env', () => ({ serverEnv: { authSessionSecret: 'a'.repeat(64) } }))
vi.mock('@/lib/supabase/server', () => ({
  supabaseServer: () => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => {
    state.lookups += 1
    await new Promise<void>(resolve => { state.release = resolve })
    return { data: state.user, error: null }
  } }) }) }) }) }),
}))
import { requireOperatorWith } from '@/lib/auth/authorize'
import { issueSession } from '@/lib/auth/session'

const USER = { id: 'u1', email: 'packer@example.com', name: 'Packer', role: 'operator' as const, active: true }
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
beforeEach(() => { state.cookie = issueSession(SECRET, { id: USER.id, email: USER.email, name: USER.name, role: USER.role }).value; state.user = USER; state.lookups = 0; state.release = null })

describe('requireOperatorWith', () => {
  it('starts the reads while the operator row is still being checked, and returns them once it passes', async () => {
    const load = vi.fn(async () => 'orders')
    const page = requireOperatorWith(load)
    await tick()
    expect(state.lookups).toBe(1)
    expect(load).toHaveBeenCalledTimes(1) // already reading: the row check has not answered yet
    state.release!()
    await expect(page).resolves.toBe('orders')
  })

  it('reads nothing for a visitor without a good session cookie', async () => {
    for (const cookie of [undefined, 'not-a-session', state.cookie!.slice(0, -2) + 'xx']) {
      state.cookie = cookie
      const load = vi.fn(async () => 'orders')
      await expect(requireOperatorWith(load, '/dispatch/print?auto')).rejects.toThrow('REDIRECT /login?next=%2Fdispatch%2Fprint%3Fauto')
      expect(load).not.toHaveBeenCalled()
    }
    expect(state.lookups).toBe(0)
  })

  it('redirects a deactivated operator on this request, whatever the reads returned', async () => {
    state.user = null // the row is gone or inactive
    const page = requireOperatorWith(async () => 'orders')
    await tick(); state.release!()
    await expect(page).rejects.toThrow('REDIRECT /login')
  })

  it('a read that fails first never answers before the sign-in check', async () => {
    state.user = null
    const page = requireOperatorWith(async () => { throw new Error('Shopify said: secret detail') })
    await tick(); state.release!()
    await expect(page).rejects.toThrow('REDIRECT /login') // not the read's error
    state.user = USER
    const allowed = requireOperatorWith(async () => { throw new Error('Shopify is down') })
    await tick(); state.release!()
    await expect(allowed).rejects.toThrow('Shopify is down')
  })
})
