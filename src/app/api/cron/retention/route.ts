import { serverEnv } from '@/lib/env'
import { createCronPostHandler } from '@/lib/cron/handler'

export const runtime = 'nodejs'
export const maxDuration = 300

const handlePost = createCronPostHandler({
  expectedSecret: () => serverEnv.cronSecret,
  run: async () => {
    const { runRetentionPurge } = await import('@/lib/retention/purge')
    const { consoleObjectStore } = await import('@/lib/console/images')
    const { supabaseServer } = await import('@/lib/supabase/server')
    const purge = await runRetentionPurge({}, { db: supabaseServer(), store: consoleObjectStore() })
    // D165: the VPS image cache sweep rides along, best effort — a cache problem never fails retention.
    const { sweepImageCache } = await import('@/lib/images/cache')
    const imageCache = await sweepImageCache().catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      console.warn('image cache sweep failed:', reason)
      return { error: reason }
    })
    return { ...purge, imageCache }
  },
})

export async function POST(request: Request): Promise<Response> {
  return handlePost(request)
}
