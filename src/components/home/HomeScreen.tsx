import type { HomeSnapshot } from '@/lib/home/server'
import { ChatPanel } from './ChatPanel'
import { HealthLight } from './HealthLight'
import { NumberTile } from './NumberTile'

const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })

export function HomeScreen({ lights, numbers, actionsConnected }: HomeSnapshot) {
  const worst = lights.some(light => light.status === 'red') ? 'red' : lights.some(light => light.status === 'amber') ? 'amber' : 'green'
  return (
    <section className="h-full overflow-auto px-3 py-4 md:px-8 md:py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-medium tracking-[-0.025em]">Qimati</h1>
          <p className="mt-1 text-[13px] text-ink-soft">{lights.length === 0 ? 'No probes configured.' : worst === 'green' ? 'Everything is answering.' : worst === 'amber' ? 'Something is slow or partly down.' : 'Something is down.'} Checked {clock(lights[0]?.checkedAt ?? numbers.computedAt)} IST.</p>
        </div>
        <span className="rounded-pill bg-chip px-3 py-1 text-[11.5px] text-ink-soft">Numbers as of {clock(numbers.computedAt)}</span>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        <NumberTile label="Orders today" value={numbers.ordersToday} />
        <NumberTile label="Paid, unfulfilled" value={numbers.paidUnfulfilled} />
        <NumberTile label="Awaiting QC" value={numbers.awaitingQc} capped={numbers.awaitingQcCapped} href="/qc" />
        <NumberTile label="Awaiting tracking" value={numbers.awaitingTracking} href="/dispatch" />
        <NumberTile label="Open shortages" value={numbers.openShortages} href="/qc/shortages" />
      </div>
      {numbers.problems.length > 0 && <p role="alert" className="mt-3 text-[12px] text-amber">{numbers.problems.join(' · ')}</p>}
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div>
          <h2 className="mb-3 text-[15px] font-medium">Services</h2>
          {lights.length === 0 ? <p className="text-[13px] text-ink-soft">No probes configured.</p> : <ul className="grid gap-2">{lights.map(light => <HealthLight key={light.key} light={light} />)}</ul>}
        </div>
        <div><h2 className="mb-3 text-[15px] font-medium">Ask</h2><ChatPanel actionsConnected={actionsConnected} /></div>
      </div>
    </section>
  )
}
