import { serverEnv } from '@/lib/env'
import { faceOrigins } from './faces'

/** The console's own browser origins: AUTH_BASE_URL plus every face host. A form or fetch from anywhere else is refused (D136). No `server-only` import here on purpose: `@/lib/env` already carries it, and the route tests mock that module. */
export function isOwnOrigin(origin: string | null): boolean {
  if (!origin) return false
  return origin === new URL(serverEnv.authBaseUrl).origin || faceOrigins().includes(origin)
}
