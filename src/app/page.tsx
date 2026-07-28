import Link from 'next/link'

/**
 * Phase 1 has no operator UI by design — scope is scaffold, schema, seed and the
 * SKU counter. The console and tracking screens arrive in later phases against
 * design/console-mockup.html and design/tracking-mockup.html.
 */
export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col justify-center px-6 py-12">
      <p className="text-[10px] font-medium uppercase tracking-[0.11em] text-[var(--muted)]">
        Qimati
      </p>
      <h1 className="mt-1 text-[26px] font-medium tracking-[-0.025em]">Loupe</h1>
      <p className="mt-3 max-w-md text-[13px] leading-relaxed text-[var(--ink-soft)]">
        Phase 1 — foundation. Database schema, seed data and the atomic SKU counter are in
        place. There is no operator interface yet.
      </p>
      <Link
        href="/health"
        className="mt-6 inline-flex w-fit rounded-[999px] bg-[var(--ink)] px-4 py-2 text-[13px] font-medium text-white"
      >
        Health
      </Link>
    </main>
  )
}
