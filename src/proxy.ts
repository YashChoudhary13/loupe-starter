import { NextResponse, type NextRequest } from 'next/server'
import { faceRoute } from '@/lib/faces/faces'

/** Every request: pick the face from the host, tell the app with `x-face`, and send a screen that belongs to another face to that face's host (D136).
 * A request from a page already open is served in place with the screen's own face, so switching faces inside the app loads no page (D172).
 * Such a request is told apart by the browser, not by Next: Next removes its own `rsc` header before the proxy runs, so the test is `Sec-Fetch-Mode`
 * (`navigate` for a page load, `cors` for the router's fetch; the page cannot set it), a server action's `next-action`, or a method other than GET.
 * A browser that sends no `Sec-Fetch-Mode` gets the redirect, and the router then loads the page on its own host, as before D172.
 * Which face a screen wears is presentation, never permission: every operator may open every face.
 * `x-next` carries the path asked for, so the shell layout can bring a signed-out visitor back to it after sign-in; both headers are set here, never taken from the browser. */
export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl
  const mode = request.headers.get('sec-fetch-mode')
  const inApp = (mode !== null && mode !== 'navigate') || request.headers.has('next-action') || (request.method !== 'GET' && request.method !== 'HEAD')
  const { face, redirect } = faceRoute({ host: request.headers.get('host') ?? request.nextUrl.host, pathname, dev: process.env.FACE_DEV, production: process.env.NODE_ENV === 'production', inApp })
  if (redirect) return NextResponse.redirect(new URL(`${redirect}${search}`, request.url), 307)
  const headers = new Headers(request.headers)
  if (face) headers.set('x-face', face)
  else headers.delete('x-face')
  headers.set('x-next', `${pathname}${search}`)
  return NextResponse.next({ request: { headers } })
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] }
