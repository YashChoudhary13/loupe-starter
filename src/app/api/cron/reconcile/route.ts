import { serverEnv } from '@/lib/env'
import { createCronPostHandler } from '@/lib/cron/handler'

export const runtime = 'nodejs'

const handlePost = createCronPostHandler({
  expectedSecret: () => serverEnv.cronSecret,
  run: async () => {
    const { runReconcileCron } = await import('@/lib/cron/jobs')
    return runReconcileCron()
  },
})

export async function POST(request: Request): Promise<Response> {
  return handlePost(request)
}
