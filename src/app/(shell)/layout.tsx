import { cookies } from 'next/headers'

import { AppShell } from '@/components/shell/AppShell'
import { requireOperator } from '@/lib/auth/authorize'
import { loadAttentionCount } from '@/lib/tracking/attention-count'

/**
 * Shared frame for every authenticated section. The layout does not re-render
 * on navigation between its children, which is exactly what keeps the sidebar
 * and the LiveActivity poller mounted across section switches.
 *
 * Authorisation note: because layouts persist across client-side navigation,
 * each page still calls `requireOperator()` itself — this call covers the
 * initial document request, the pages cover every navigation after it.
 */
export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const operator = await requireOperator()
  const [attentionCount, cookieStore] = await Promise.all([loadAttentionCount(), cookies()])
  const collapsed = cookieStore.get('loupe_nav_collapsed')?.value === '1'

  return (
    <AppShell
      operator={operator}
      initialAttentionCount={attentionCount}
      initialCollapsed={collapsed}
    >
      {children}
    </AppShell>
  )
}
