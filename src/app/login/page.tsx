import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { currentOperator } from '@/lib/auth/authorize'
import { decodeSignedValue, DENIED_COOKIE } from '@/lib/auth/session'
import { serverEnv } from '@/lib/env'

export const dynamic = 'force-dynamic'

const MESSAGES: Record<string, string> = {
  cancelled: 'Sign-in was cancelled. Nothing happened — try again when you are ready.',
  handshake:
    'That sign-in link had expired or was opened in a different browser. Start again from this page.',
  google:
    'Google could not complete the sign-in. Try once more; if it keeps failing, whoever runs Loupe needs to check the OAuth client.',
}

/**
 * The sign-in screen, and the access-denied screen — deliberately the same page.
 *
 * A refused sign-in has to land somewhere that offers the way out ("sign in with
 * a different account"), and a separate /denied route would be a second page
 * that has to be kept unauthenticated and kept free of application data.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if (await currentOperator()) redirect('/console')

  const jar = await cookies()
  const denied = decodeSignedValue<{ email: string }>(
    serverEnv.authSessionSecret,
    jar.get(DENIED_COOKIE)?.value,
  )
  const params = await searchParams
  const errorKey = typeof params.error === 'string' ? params.error : null
  const message = errorKey ? MESSAGES[errorKey] : null

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-[420px] rounded-[24px] bg-surface p-8">
        <div className="flex items-center gap-2.5">
          <div className="grid size-[30px] place-items-center rounded-[9px] bg-ink text-[14px] font-semibold text-white">
            L
          </div>
          <span className="font-medium tracking-[-0.01em]">Loupe</span>
        </div>

        <h1 className="mt-7 text-[26px] font-medium tracking-[-0.025em]">
          {denied ? 'No access' : 'Sign in'}
        </h1>

        {denied ? (
          <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
            <span className="font-medium text-ink">{denied.email}</span> is not a Loupe user.
            Nothing on this account can be seen or changed. Ask an admin to add the address,
            or sign in with the account that was set up for you.
          </p>
        ) : (
          <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
            Loupe publishes to a real Shopify store, so access is by named account. Sign in
            with the Google account that was set up for you.
          </p>
        )}

        {message ? (
          <p className="mt-4 rounded-[14px] bg-chip px-4 py-3 text-[12.5px] leading-relaxed text-amber">
            {message}
          </p>
        ) : null}

        <a
          href="/api/auth/google/start"
          className="mt-7 flex h-[46px] w-full items-center justify-center gap-2.5 rounded-pill bg-ink text-[13px] font-medium text-white transition-colors hover:bg-[#242428]"
        >
          <GoogleMark />
          {denied ? 'Try a different Google account' : 'Continue with Google'}
        </a>

        <p className="mt-5 text-[11.5px] leading-relaxed text-muted-foreground">
          Access is decided by the operator list, not by email domain — a personal Gmail
          address is expected here.
        </p>
      </div>
    </main>
  )
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-[15px]">
      <path
        fill="currentColor"
        d="M12 10.2v3.9h5.5a4.8 4.8 0 0 1-2.1 3.1l3.3 2.6c1.9-1.8 3-4.4 3-7.5 0-.7-.1-1.4-.2-2.1H12Z"
      />
      <path
        fill="currentColor"
        opacity=".75"
        d="M6.6 14.3 5.9 15l-2.6 2A9 9 0 0 0 12 22c2.4 0 4.5-.8 6-2.2l-3.3-2.6c-.9.6-2 1-2.7 1a4.7 4.7 0 0 1-4.4-3.9Z"
      />
      <path
        fill="currentColor"
        opacity=".5"
        d="M3.3 7A9 9 0 0 0 3.3 17l3.3-2.6a5.3 5.3 0 0 1 0-3.4L3.3 7Z"
      />
      <path
        fill="currentColor"
        opacity=".85"
        d="M12 6.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 3.3 7l3.3 2.6A4.7 4.7 0 0 1 12 6.6Z"
      />
    </svg>
  )
}
