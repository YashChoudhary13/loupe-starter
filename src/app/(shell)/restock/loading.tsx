export default function RestockLoading() {
  return (
    <main className="flex min-h-0 min-w-0 flex-col gap-3.5" aria-busy="true">
      <div>
        <h1 className="text-[26px] font-medium tracking-[-0.025em]">Restock</h1>
        <div className="text-[12px] text-muted-foreground">Loading…</div>
      </div>
      <div className="h-14 animate-pulse rounded-panel bg-surface" />
      <div className="h-28 animate-pulse rounded-card bg-surface" />
      <span className="sr-only">Loading Restock</span>
    </main>
  )
}
