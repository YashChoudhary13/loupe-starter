/** Tiny n8n public-API client for the Home dashboard (D137): workflows, executions and the two bot webhooks. Every call is injectable. */
export interface N8nWorkflow { id: string; name: string; active: boolean }
export interface N8nExecution { id: string; status: string; startedAt: string | null; stoppedAt: string | null }
export interface N8nClient { workflow(id: string): Promise<N8nWorkflow>; executions(id: string, limit?: number): Promise<N8nExecution[]> }
export type WebhookPost = (url: string, secret: string, body: Record<string, unknown>, fetchImpl?: typeof fetch) => Promise<{ status: number; text: string }>

const ID = /^[A-Za-z0-9_-]{1,64}$/
/** An id goes into a URL path, so anything outside n8n's own alphabet is refused before a request is made. */
export function workflowId(value: string): string { if (!ID.test(value)) throw new Error('That n8n workflow id does not look right.'); return value }

/** `HOME_N8N_WORKFLOWS`: a JSON object of label → workflow id. Anything else counts as "no workflows configured". */
export function workflowMap(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([label, id]) => label.trim() && typeof id === 'string' && ID.test(id)).map(([label, id]) => [label.trim(), id as string]))
  } catch { return {} }
}

export function n8nClient(options: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }): N8nClient {
  const base = options.baseUrl.replace(/\/+$/, ''), doFetch = options.fetchImpl ?? fetch, timeout = options.timeoutMs ?? 5_000
  const get = async <T>(path: string): Promise<T> => {
    const response = await doFetch(`${base}/api/v1${path}`, { headers: { 'X-N8N-API-KEY': options.apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) })
    if (!response.ok) throw new Error(`n8n answered ${response.status} for ${path}.`)
    return (await response.json()) as T
  }
  return {
    async workflow(id) {
      const raw = await get<{ name?: unknown; active?: unknown }>(`/workflows/${workflowId(id)}`)
      return { id, name: typeof raw.name === 'string' ? raw.name : id, active: raw.active === true }
    },
    async executions(id, limit = 5) {
      const raw = await get<{ data?: unknown }>(`/executions?workflowId=${workflowId(id)}&limit=${Math.min(20, Math.max(1, Math.trunc(limit)))}`)
      const rows = (Array.isArray(raw.data) ? raw.data : []) as Record<string, unknown>[]
      return rows.map(row => ({ id: String(row.id ?? ''), status: typeof row.status === 'string' ? row.status : 'unknown', startedAt: typeof row.startedAt === 'string' ? row.startedAt : null, stoppedAt: typeof row.stoppedAt === 'string' ? row.stoppedAt : null }))
    },
  }
}

/** The two bot webhooks carry the shared secret, never the API key; 15 s because the bot may send before it answers. `redirect: 'error'` so the secret header can never follow a redirect to another host. */
export const postWebhook: WebhookPost = async (url, secret, body, fetchImpl = fetch) => {
  const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Loupe-Secret': secret }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000) })
  return { status: response.status, text: (await response.text()).slice(0, 300) }
}

export function n8nFromEnv(env: Record<string, string | undefined> = process.env): N8nClient | null {
  const baseUrl = env.N8N_URL?.trim(), apiKey = env.N8N_API_KEY?.trim()
  return baseUrl && apiKey && /^https?:\/\//.test(baseUrl) ? n8nClient({ baseUrl, apiKey }) : null
}
