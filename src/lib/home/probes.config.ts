import { workflowMap } from './n8n'

export type ProbeKind = 'http' | 'n8n' | 'supabase' | 'shopify'
/** `target`: the URL for `http`, the workflow id for `n8n`, unused otherwise. Adding a light is one entry here. */
export interface ProbeDef { key: string; label: string; kind: ProbeKind; target: string }

/** DTDC has no API and its connector cannot be observed from here, so those two lights say "reachable" and mean only that. */
export const STATIC_PROBES: readonly ProbeDef[] = [
  { key: 'loupe', label: 'Loupe', kind: 'http', target: 'https://loupe.qimati-eng.site/health' },
  { key: 'packaging', label: 'Packaging', kind: 'http', target: 'https://packaging.qimati-eng.site/' },
  { key: 'linkedin', label: 'LinkedIn', kind: 'http', target: 'https://linkedin.qimati-eng.site/' },
  { key: 'dtdc-portal', label: 'DTDC portal reachable', kind: 'http', target: 'https://customer.dtdc.in/' },
  { key: 'dtdc-api', label: 'DTDC connector reachable', kind: 'http', target: 'https://pxapi.dtdc.in/' },
  { key: 'supabase', label: 'Supabase', kind: 'supabase', target: '' },
  { key: 'shopify', label: 'Shopify', kind: 'shopify', target: '' },
]
const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)

/** The static lights plus one `n8n` light per workflow in HOME_N8N_WORKFLOWS (ids come from env, never from source). */
export function probeDefs(env: Record<string, string | undefined> = process.env): ProbeDef[] {
  const bots = Object.entries(workflowMap(env.HOME_N8N_WORKFLOWS)).map(([label, id]) => ({ key: `n8n-${slug(label)}`, label: `Bot · ${label}`, kind: 'n8n' as const, target: id }))
  return [...STATIC_PROBES, ...bots]
}
