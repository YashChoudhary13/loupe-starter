/**
 * What the operator sees in the content column while a section is being built
 * on the server.
 *
 * Every screen here is `force-dynamic` — it re-checks authorisation and
 * re-signs image URLs on every render, neither of which can be cached. Without
 * a `loading.tsx` boundary, Next.js keeps the PREVIOUS page on screen for the
 * whole server round trip, so clicking Tracking looked like nothing had
 * happened and invited a second and third click.
 *
 * The sidebar itself lives in the persistent (shell) layout and never unmounts
 * during navigation — this skeleton covers only the content column, matching
 * each page's geometry so the layout does not jump when real content lands.
 */
export function ScreenSkeleton({ title }: { readonly title: string }) {
  return (
    <main className="flex min-h-0 min-w-0 flex-col gap-3.5" aria-busy="true">
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-[26px] font-medium tracking-[-0.025em]">{title}</h1>
          <div className="text-[12px] text-muted-foreground">Loading…</div>
        </div>
        <div className="ml-auto flex gap-2">
          {[0, 1, 2].map((index) => (
            <div key={index} className="h-9 w-24 animate-pulse rounded-pill bg-surface" />
          ))}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_clamp(400px,32vw,500px)] gap-3.5 overflow-hidden">
        <div className="animate-pulse rounded-[24px] bg-surface" />
        <div className="animate-pulse rounded-[24px] bg-surface" />
      </div>

      <span className="sr-only">Loading {title}</span>
    </main>
  )
}
