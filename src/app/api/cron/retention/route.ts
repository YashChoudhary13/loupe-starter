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
    return runRetentionPurge({}, { db: supabaseServer(), store: consoleObjectStore() })
  },
})

export async function POST(request: Request): Promise<Response> {
  return handlePost(request)
}
