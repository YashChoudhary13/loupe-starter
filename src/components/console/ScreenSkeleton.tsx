/**
 * What the operator sees while a protected screen is being built on the server.
 *
 * Every screen here is `force-dynamic` — it re-checks authorisation and re-signs
 * image URLs on every render, neither of which can be cached. Without a
 * `loading.tsx` boundary, Next.js keeps the PREVIOUS page on screen for the
 * whole server round trip, so clicking Tracking looked like nothing had
 * happened and invited a second and third click.
 *
 * This is deliberately the page's own geometry — sidebar column, header, card
 * shapes — rather than a spinner, so the layout does not jump when the real
 * content replaces it.
 */
export function ScreenSkeleton({ title }: { readonly title: string }) {
  return (
    <div className="grid h-dvh grid-cols-[216px_1fr] gap-[18px] p-[18px]" aria-busy="true">
      <div className="rounded-[24px] bg-surface" />

      <main className="flex min-h-0 min-w-0 flex-col gap-3.5">
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

        <div className="grid min-h-0 flex-1 grid-cols-[1fr_372px] gap-3.5 overflow-hidden">
          <div className="animate-pulse rounded-[24px] bg-surface" />
          <div className="animate-pulse rounded-[24px] bg-surface" />
        </div>
      </main>

      <span className="sr-only">Loading {title}</span>
    </div>
  )
}
