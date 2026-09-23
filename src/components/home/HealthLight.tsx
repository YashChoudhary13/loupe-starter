import type { ProbeLight } from '@/lib/home/probes'

const TONE = { green: 'bg-green', amber: 'bg-amber', red: 'bg-[#b3261e]' } as const
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })

/** One health light: a dot, the label, and either "ok · 312 ms" or "red since 23 Sept, 03:12 am · HTTP 502". */
export function HealthLight({ light }: { light: ProbeLight }) {
  return (
    <li className="flex items-center gap-3 rounded-panel bg-surface px-4 py-3">
      <span aria-hidden className={`size-3 shrink-0 rounded-full ${TONE[light.status]}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{light.label}</div>
        <div className="truncate text-[11.5px] text-muted-foreground">{light.status === 'green' ? `ok · ${light.ms} ms` : `${light.status} since ${when(light.since)} · ${light.detail}`}</div>
      </div>
      <span className="sr-only">{light.status}</span>
    </li>
  )
}
