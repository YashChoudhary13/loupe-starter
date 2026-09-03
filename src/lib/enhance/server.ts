import 'server-only'

import { serverEnv } from '@/lib/env'
import { googleDriveClient } from '@/lib/google/drive-server'

import { enhancementConfig } from './config'
import { OpenRouterClient } from './openrouter'
import { R2ObjectStore } from './storage'
import { SupabaseEnhancementRepository } from './supabase-repository'
import { runEnhancementBatch } from './worker'

export function runProductionEnhancementBatch() {
  const openRouter = new OpenRouterClient(serverEnv.openRouterApiKey)
  return runEnhancementBatch({
    drive: googleDriveClient(),
    repository: new SupabaseEnhancementRepository(),
    store: new R2ObjectStore({
      endpoint: serverEnv.r2Endpoint,
      accessKeyId: serverEnv.r2AccessKeyId,
      secretAccessKey: serverEnv.r2SecretAccessKey,
      bucket: serverEnv.r2Bucket,
    }),
    describer: openRouter,
    enhancer: openRouter,
    checker: openRouter,
    config: enhancementConfig(),
  })
}
