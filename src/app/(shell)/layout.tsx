import { cookies, headers } from 'next/headers'

import { AppShell } from '@/components/shell/AppShell'
import { countRestockCandidates } from '@/lib/agent-intake/restock'
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
 * initial document request, the pages cover every navigation after it. This
 * call runs first, so it is the one that sends a signed-out visitor to sign-in,
 * with the path the proxy saw (`x-next`) so they come back to the same screen.
 */
export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const headerStore = await headers()
  const operator = await requireOperator(headerStore.get('x-next') ?? undefined)
  const [attentionCount, restockCount, cookieStore] = await Promise.all([loadAttentionCount(), countRestockCandidates(), cookies()])
  const collapsed = cookieStore.get('loupe_nav_collapsed')?.value === '1'

  return (
    <AppShell
      operator={operator}
      face={faceFromHeader(headerStore.get('x-face'))}
      initialAttentionCount={attentionCount}
      initialRestockCount={restockCount}
      initialCollapsed={collapsed}
    >
      {children}
    </AppShell>
  )
}
