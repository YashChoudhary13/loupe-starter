/** One headline number. `null` means the check failed; `capped` means "at least this many". A plain anchor, because the target may live on another face (the proxy redirects). */
export function NumberTile({ label, value, capped = false, href }: { label: string; value: number | null; capped?: boolean; href?: string }) {
  const body = (
    <>
      <div className="text-[26px] font-medium tracking-[-0.025em] tabular-nums">{value === null ? '—' : `${value}${capped ? '+' : ''}`}</div>
      <div className="mt-1 text-[11.5px] text-muted-foreground">{label}</div>
    </>
  )
  const className = 'block rounded-panel bg-surface px-4 py-3 focus-visible:outline-2'
  return href ? <a href={href} className={`${className} hover:bg-chip`}>{body}</a> : <div className={className}>{body}</div>
}
