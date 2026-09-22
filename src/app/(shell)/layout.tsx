import { cookies, headers } from 'next/headers'

import { AppShell } from '@/components/shell/AppShell'
import { requireOperator } from '@/lib/auth/authorize'
import { faceFromHeader } from '@/lib/faces/faces'
import { loadAttentionCount } from '@/lib/tracking/attention-count'

/**
 * Shared frame for every authenticated section. The layout does not re-render
 * on navigation between its children, which is exactly what keeps the sidebar
 * and the LiveActivity poller mounted across section switches.
 *
 * The face comes from the `x-face` header the proxy set from the hostname
 * (D136); nothing here trusts a value the browser could have sent.
 *
 * Authorisation note: because layouts persist across client-side navigation,
 * each page still calls `requireOperator()` itself — this call covers the
 * initial document request, the pages cover every navigation after it.
 */
export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const operator = await requireOperator()
  const [attentionCount, cookieStore, headerStore] = await Promise.all([loadAttentionCount(), cookies(), headers()])
  const collapsed = cookieStore.get('loupe_nav_collapsed')?.value === '1'

  return (
    <AppShell
      operator={operator}
      face={faceFromHeader(headerStore.get('x-face'))}
      initialAttentionCount={attentionCount}
      initialCollapsed={collapsed}
    >
      {children}
    </AppShell>
  )
}
