import { serverEnv } from '@/lib/env'
import { createCronPostHandler } from '@/lib/cron/handler'

export const runtime = 'nodejs'

const handlePost = createCronPostHandler({
  expectedSecret: () => serverEnv.cronSecret,
  run: async () => {
    const { runSweepCron } = await import('@/lib/cron/jobs')
    return runSweepCron()
  },
})

export async function POST(request: Request): Promise<Response> {
  return handlePost(request)
}
