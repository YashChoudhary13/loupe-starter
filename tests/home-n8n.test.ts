// tests/home-n8n.test.ts
import { describe, expect, it } from 'vitest'
import { n8nClient, n8nFromEnv, postWebhook, workflowId, workflowMap } from '@/lib/home/n8n'

interface Seen { url: string; method: string; headers: Record<string, string>; body: string | null }
function fake(responses: Array<() => Response>) {
  const seen: Seen[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()), body: typeof init?.body === 'string' ? init.body : null })
    return (responses.shift() ?? (() => new Response('{}', { status: 200 })))()
  }) as unknown as typeof fetch
  return { seen, fetchImpl }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('n8n client', () => {
  it('reads a workflow with the API key header', async () => {
    const { seen, fetchImpl } = fake([() => json({ id: 'abc', name: 'Main bot', active: true })])
    expect(await n8nClient({ baseUrl: 'https://n8n.example/', apiKey: 'k', fetchImpl }).workflow('abc')).toEqual({ id: 'abc', name: 'Main bot', active: true })
    expect(seen[0].url).toBe('https://n8n.example/api/v1/workflows/abc'); expect(seen[0].headers['x-n8n-api-key']).toBe('k')
  })
  it('lists executions, clamps the limit to 1–20, and tolerates missing fields', async () => {
    const { seen, fetchImpl } = fake([() => json({ data: [{ id: 7, status: 'success', startedAt: '2026-09-23T03:00:00Z', stoppedAt: '2026-09-23T03:00:05Z' }, { id: 6 }] })])
    const runs = await n8nClient({ baseUrl: 'https://n8n.example', apiKey: 'k', fetchImpl }).executions('abc', 99)
    expect(seen[0].url).toBe('https://n8n.example/api/v1/executions?workflowId=abc&limit=20')
    expect(runs).toEqual([{ id: '7', status: 'success', startedAt: '2026-09-23T03:00:00Z', stoppedAt: '2026-09-23T03:00:05Z' }, { id: '6', status: 'unknown', startedAt: null, stoppedAt: null }])
  })
  it('refuses an id that could change the URL, before any request', async () => {
    const { seen, fetchImpl } = fake([])
    await expect(n8nClient({ baseUrl: 'https://n8n.example', apiKey: 'k', fetchImpl }).workflow('../x?y')).rejects.toThrow(/workflow id/)
    expect(seen).toHaveLength(0); expect(() => workflowId('abc-DEF_9')).not.toThrow()
  })
  it('turns a non-2xx into an error naming the status', async () => {
    const { fetchImpl } = fake([() => new Response('nope', { status: 503 })])
    await expect(n8nClient({ baseUrl: 'https://n8n.example', apiKey: 'k', fetchImpl }).workflow('abc')).rejects.toThrow(/503/)
  })
  it('posts a webhook with the shared secret header and no API key', async () => {
    const { seen, fetchImpl } = fake([() => new Response('ok', { status: 200 })])
    expect(await postWebhook('https://n8n.example/webhook/report', 's3cret', { from: '2026-09-01' }, fetchImpl)).toEqual({ status: 200, text: 'ok' })
    expect(seen[0]).toMatchObject({ method: 'POST', url: 'https://n8n.example/webhook/report', body: '{"from":"2026-09-01"}' })
    expect(seen[0].headers['x-loupe-secret']).toBe('s3cret'); expect(seen[0].headers['x-n8n-api-key']).toBeUndefined()
  })
})
describe('configuration', () => {
  it('parses HOME_N8N_WORKFLOWS as label → id and drops anything malformed', () => {
    expect(workflowMap('{"Main bot":"abc","Order shipped":"d-1","bad":7,"":"x","evil":"../y"}')).toEqual({ 'Main bot': 'abc', 'Order shipped': 'd-1' })
    expect(workflowMap('not json')).toEqual({}); expect(workflowMap(undefined)).toEqual({}); expect(workflowMap('[1]')).toEqual({})
  })
  it('is null until both N8N_URL and N8N_API_KEY are set', () => {
    expect(n8nFromEnv({})).toBeNull(); expect(n8nFromEnv({ N8N_URL: 'https://n8n.example' })).toBeNull(); expect(n8nFromEnv({ N8N_URL: 'ftp://x', N8N_API_KEY: 'k' })).toBeNull()
    expect(n8nFromEnv({ N8N_URL: 'https://n8n.example', N8N_API_KEY: 'k' })).not.toBeNull()
  })
})
