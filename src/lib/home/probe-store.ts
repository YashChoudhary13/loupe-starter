import type { ProbeLight, ProbeStateStore, ProbeStatus } from './probes'

type Result<T> = PromiseLike<{ error: { message: string } | null } & T>
/** The slice of a Supabase client the store touches; `supabaseServer()` satisfies it, and tests pass a fake. */
export interface ProbeStoreDb { from(table: string): { select(columns: string): Result<{ data: Record<string, unknown>[] | null }>; upsert(row: Record<string, unknown>, options: { onConflict: string }): Result<object>; insert(row: Record<string, unknown>): Result<object> } }

/** Last change per probe in `home_probe_state`, plus one `home.probe_changed` events row per change (D137). */
export function supabaseProbeStore(db: ProbeStoreDb): ProbeStateStore {
  return {
    async load() {
      const { data, error } = await db.from('home_probe_state').select('probe_key,status,since')
      if (error) throw new Error(error.message)
      return Object.fromEntries((data ?? []).map(row => [String(row.probe_key), { status: row.status as ProbeStatus, since: String(row.since) }]))
    },
    async changed(light: ProbeLight, previous: ProbeStatus | null) {
      const { error } = await db.from('home_probe_state').upsert({ probe_key: light.key, status: light.status, detail: light.detail, since: light.since, checked_at: light.checkedAt }, { onConflict: 'probe_key' })
      if (error) throw new Error(error.message)
      await db.from('events').insert({ entity_type: 'home_probe', event: 'home.probe_changed', detail: { key: light.key, label: light.label, from: previous, to: light.status, reason: light.detail }, actor: 'home' })
    },
  }
}
