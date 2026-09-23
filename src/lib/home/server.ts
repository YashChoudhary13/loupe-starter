import 'server-only'
import { listParcels } from '@/lib/dispatch/store'
import { listRecentPasses, qcOrderStatuses } from '@/lib/qc/server'
import { listShortages } from '@/lib/qc/shortages'
import { ShopifyClient } from '@/lib/shopify/client'
import { supabaseServer } from '@/lib/supabase/server'
import { availableActions, botConfig } from './actions'
import { n8nFromEnv, workflowMap } from './n8n'
import { computeNumbers, type HomeNumbers } from './numbers'
import { probeDefs } from './probes.config'
import { supabaseProbeStore } from './probe-store'
import { cached, probeHttp, probeN8n, probeShopify, probeSupabase, runProbes, type ProbeLight } from './probes'
import { readOnlyShopify, type ReadOnlyShopify } from './shopify-reads'
import type { ToolContext } from './tools'

let shopifyClient: ShopifyClient | null = null
/** One client per process: its token manager caches the 24 h token, so a 30 s probe cycle never re-mints. Null when Shopify is not configured. */
export function homeShopify(): ShopifyClient | null { try { return (shopifyClient ??= new ShopifyClient()) } catch { return null } }
export function homeReadOnlyShopify(): ReadOnlyShopify | null { const client = homeShopify(); return client ? readOnlyShopify(client) : null }
export async function qcPassed(ids: string[]): Promise<Record<string, boolean>> { const statuses = await qcOrderStatuses(ids); return Object.fromEntries(ids.map(id => [id, statuses[id]?.status === 'passed'])) }

const lights = cached(30_000, () => {
  const n8n = n8nFromEnv(), shopify = homeShopify(), now = Date.now
  const off = (detail: string) => Promise.resolve({ status: 'red' as const, detail, ms: 0 })
  return runProbes(probeDefs(), def =>
    def.kind === 'http' ? probeHttp(def.target, { fetchImpl: fetch, now })
    : def.kind === 'n8n' ? (n8n ? probeN8n(def.target, n8n, now) : off('N8N_URL / N8N_API_KEY not set'))
    : def.kind === 'supabase' ? probeSupabase(supabaseServer(), now)
    : shopify ? probeShopify(shopify, now) : off('Shopify not configured'), supabaseProbeStore(supabaseServer()), now)
})
const numbers = cached(60_000, () => computeNumbers({ shop: homeReadOnlyShopify(), qcPassed, openParcels: async () => (await listParcels(1)).open.length, openShortages: async () => (await listShortages(1)).open.length, now: () => new Date() }))

export interface HomeSnapshot { lights: ProbeLight[]; numbers: HomeNumbers; actionsConnected: boolean }
/** Lights at most 30 s old, numbers at most 60 s old, per process. */
export async function homeSnapshot(): Promise<HomeSnapshot> {
  const now = Date.now()
  const [l, n] = await Promise.all([lights(now), numbers(now)])
  return { lights: l, numbers: n, actionsConnected: availableActions(botConfig()).length > 0 }
}

/** What the assistant's tools may reach. Shopify only through the read-only wrapper; nothing here can write. */
export function homeToolContext(): ToolContext {
  return {
    shop: homeReadOnlyShopify(), n8n: n8nFromEnv(), workflows: workflowMap(process.env.HOME_N8N_WORKFLOWS), now: () => new Date(),
    status: async () => { const snapshot = await homeSnapshot(); return { lights: snapshot.lights, numbers: snapshot.numbers } },
    qcPassed, passes: listRecentPasses, shortages: listShortages, parcels: listParcels,
  }
}
