import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * D111: a published product's original becomes a matcher reference. The sweep
 * is keyed on state ("published, original present, no reference yet"), so it is
 * safe to call after every publish and again weekly; nothing is registered twice.
 */
export async function registerPublishedOriginals(
  db: Pick<SupabaseClient, 'rpc'>,
  options: { limit?: number; actor?: string } = {},
): Promise<number> {
  const { data, error } = await db.rpc('register_published_originals', {
    p_limit: options.limit ?? 200,
    p_actor: options.actor ?? 'cron:match-register',
  })
  if (error) throw new Error(`register_published_originals: ${error.message}`)
  return (data as number | null) ?? 0
}

/** Best effort after a publish: registration must never fail a publish that already happened. */
export async function registerAfterPublish(
  db: Pick<SupabaseClient, 'rpc'>,
  actor: string,
): Promise<{ registered: number } | { error: string }> {
  try {
    return { registered: await registerPublishedOriginals(db, { limit: 50, actor }) }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    console.error('reference registration after publish failed:', message)
    return { error: message }
  }
}
