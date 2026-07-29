import { checkGoogleServiceAccount } from '@/lib/google/service-account'
import { supabaseServer } from '@/lib/supabase/server'
import { TABLES, type TableName } from '@/lib/tables'

// Always hit the database. A cached health page reports the health of the past.
export const dynamic = 'force-dynamic'
export const revalidate = 0

export const metadata = { title: 'Health · Loupe' }

interface TableCount {
  readonly table: TableName
  readonly count: number | null
  readonly error: string | null
}

interface HealthReport {
  readonly counts: readonly TableCount[]
  readonly fatal: string | null
  readonly elapsedMs: number
  readonly checkedAt: string
}

async function countRows(table: TableName): Promise<TableCount> {
  const { count, error } = await supabaseServer()
    .from(table)
    .select('*', { count: 'exact', head: true })

  return {
    table,
    count: error ? null : (count ?? 0),
    error: error ? error.message : null,
  }
}

/**
 * Kept out of the component body on purpose. Reading the clock is impure, and a
 * Server Component's render must not be — React's purity rule flags it, and it
 * is right to: the measurement belongs to the data fetch, not to the rendering.
 */
async function collectHealth(): Promise<HealthReport> {
  const startedAt = Date.now()
  try {
    const counts = await Promise.all(TABLES.map(countRows))
    return {
      counts,
      fatal: null,
      elapsedMs: Date.now() - startedAt,
      checkedAt: formatIst(new Date()),
    }
  } catch (e) {
    return {
      counts: [],
      fatal: e instanceof Error ? e.message : String(e),
      elapsedMs: Date.now() - startedAt,
      checkedAt: formatIst(new Date()),
    }
  }
}

// Stored UTC, displayed Asia/Kolkata — the operators are in Jaipur.
function formatIst(d: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Asia/Kolkata',
  }).format(d)
}

export default async function HealthPage() {
  const { counts, fatal, elapsedMs, checkedAt } = await collectHealth()
  const failures = counts.filter((c) => c.error !== null)
  const ok = fatal === null && failures.length === 0
  // Non-throwing on purpose: a broken Drive credential must be VISIBLE here, not
  // take the diagnostics page down with it.
  const google = checkGoogleServiceAccount()

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <header className="mb-8">
        <p className="text-[10px] font-medium uppercase tracking-[0.11em] text-[var(--muted)]">
          Loupe · diagnostics
        </p>
        <h1 className="mt-1 text-[26px] font-medium tracking-[-0.025em] text-[var(--ink)]">
          Health
        </h1>
      </header>

      <section
        className={`mb-8 rounded-[24px] px-6 py-5 ${
          ok ? 'bg-[var(--ink)] text-white' : 'border border-[var(--amber)] bg-[#FDF8EF]'
        }`}
      >
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-[15px] font-semibold">
            {ok ? 'Database reachable' : 'Database problem'}
          </span>
          <span className={`text-[13px] tabular-nums ${ok ? 'text-white/60' : 'text-[var(--muted)]'}`}>
            {elapsedMs} ms
          </span>
        </div>
        <p className={`mt-1 text-[13px] ${ok ? 'text-white/70' : 'text-[var(--ink-soft)]'}`}>
          {fatal ??
            (failures.length > 0
              ? `${failures.length} of ${TABLES.length} tables could not be read.`
              : `${TABLES.length} tables, all readable. Checked ${checkedAt} IST.`)}
        </p>
      </section>

      <p className="mb-3 text-[10px] font-medium uppercase tracking-[0.11em] text-[var(--muted)]">
        Row counts
      </p>
      <div className="overflow-hidden rounded-[18px] border border-black/10 bg-[var(--surface)]">
        <table className="w-full text-[13px]">
          <tbody>
            {counts.map(({ table, count, error }, i) => (
              <tr key={table} className={i === 0 ? '' : 'border-t border-black/[0.06]'}>
                <td className="px-5 py-2.5 font-mono text-[12px] text-[var(--ink-soft)]">{table}</td>
                <td className="px-5 py-2.5 text-right tabular-nums">
                  {error === null ? (
                    <span className="font-semibold text-[var(--ink)]">{count}</span>
                  ) : (
                    <span className="text-[var(--amber)]">{error}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mb-3 mt-8 text-[10px] font-medium uppercase tracking-[0.11em] text-[var(--muted)]">
        Credentials
      </p>
      <div className="overflow-hidden rounded-[18px] border border-black/10 bg-[var(--surface)]">
        <table className="w-full text-[13px]">
          <tbody>
            <tr>
              <td className="px-5 py-2.5 font-mono text-[12px] text-[var(--ink-soft)]">
                GOOGLE_SERVICE_ACCOUNT_JSON
              </td>
              <td className="px-5 py-2.5 text-right">
                {google.ok ? (
                  <span className="font-mono text-[12px] text-[var(--ink)]">
                    {google.clientEmail}
                  </span>
                ) : (
                  <span className="text-[var(--amber)]">{google.reason}</span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {!google.ok && (
        <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--amber)]">
          {google.message}
        </p>
      )}

      <p className="mt-6 text-[12px] leading-relaxed text-[var(--muted)]">
        Counts are read with the server-only service-role client, which bypasses Row Level
        Security. Every table has RLS enabled and no policies, so the browser client reads
        nothing at all. Authentication lands in Phase 4; this page is deliberately open until
        then.
      </p>
      <p className="mt-2 text-[12px] leading-relaxed text-[var(--muted)]">
        The credential is validated, not merely checked for presence — an unquoted multi-line
        value in <code className="font-mono">.env</code> reaches the process as the single
        character <code className="font-mono">{'{'}</code>, which passes every truthiness test
        and then fails inside a worker. Only the service-account address is shown; the private
        key is never rendered or logged.
      </p>
    </main>
  )
}
