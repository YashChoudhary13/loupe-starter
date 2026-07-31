import { serverEnv } from '@/lib/env'
import { createCronPostHandler } from '@/lib/cron/handler'

export const runtime = 'nodejs'
export const maxDuration = 300

const handlePost = createCronPostHandler({
  expectedSecret: () => serverEnv.cronSecret,
  run: async () => {
    const { runShopifyReconciliationCron } = await import('@/lib/cron/jobs')
    return runShopifyReconciliationCron()
  },
})

export async function POST(request: Request): Promise<Response> {
  return handlePost(request)
}
