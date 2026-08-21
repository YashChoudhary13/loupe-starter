import { serverEnv } from '@/lib/env'
import { createCronPostHandler } from '@/lib/cron/handler'

export const runtime = 'nodejs'
export const maxDuration = 120

/** Weekly (and on demand): register every published original the matcher does not have yet (D111). */
const handlePost = createCronPostHandler({
  expectedSecret: () => serverEnv.cronSecret,
  run: async () => {
    const { registerPublishedOriginals } = await import('@/lib/match/register')
    const { supabaseServer } = await import('@/lib/supabase/server')
    const registered = await registerPublishedOriginals(supabaseServer(), { limit: 500 })
    return { registered }
  },
})

export async function POST(request: Request): Promise<Response> {
  return handlePost(request)
}
