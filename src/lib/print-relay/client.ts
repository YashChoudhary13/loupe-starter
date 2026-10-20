import 'server-only'
import { serverEnv } from '@/lib/env'

/**
 * The office print relay's system door (print.qimati-eng.site, D157): Loupe hands it a finished file with a bearer token,
 * the desktop agent on the office PC validates it and prints it — a .tspl on the TSC label printer, a .pdf on the Brother.
 * Not configured (no URL or token in the environment) means the feature is off and callers fall back to the browser.
 */
export class RelayError extends Error { constructor(message: string, readonly status: number) { super(message); this.name = 'RelayError' } }
export const relayConfigured = (): boolean => Boolean(serverEnv.printRelayUrl && serverEnv.printRelayToken)

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  if (!relayConfigured()) throw new RelayError('Office printing is not set up on this server.', 501)
  let response: Response
  try {
    response = await fetch(`${serverEnv.printRelayUrl}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${serverEnv.printRelayToken}`, 'user-agent': 'Loupe (office print client)' }, signal: AbortSignal.timeout(20_000), cache: 'no-store' })
  } catch { throw new RelayError('The office print relay did not answer.', 502) }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let detail = text
    try { detail = (JSON.parse(text) as { detail?: string }).detail ?? text } catch { /* plain text */ }
    throw new RelayError(detail.slice(0, 200) || `The office print relay refused the job (${response.status}).`, response.status)
  }
  return response
}

/** Sends one file; the relay answers with the job id. `filename`'s extension picks the printer: .tspl = labels, .pdf = office printer. */
export async function relaySend(input: { filename: string; body: string | Uint8Array; uploader: string }): Promise<{ id: string }> {
  const query = new URLSearchParams({ filename: input.filename, uploader: input.uploader.slice(0, 60), copies: '1' })
  const response = await call(`/system/jobs?${query}`, { method: 'POST', body: typeof input.body === 'string' ? input.body : new Blob([input.body as BlobPart]), headers: { 'content-type': 'application/octet-stream' } })
  return (await response.json()) as { id: string }
}

export async function relayJob(id: string): Promise<{ id: string; status: string; message: string; pages: number | null }> {
  return (await (await call(`/system/jobs/${encodeURIComponent(id)}`)).json()) as { id: string; status: string; message: string; pages: number | null }
}
