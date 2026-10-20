import { NextResponse, type NextRequest } from 'next/server'
import { faceRoute } from '@/lib/faces/faces'

/** Every request: pick the face from the host, tell the app with `x-face`, and send a screen that belongs to another face to that face's host (D136).
 * `x-next` carries the path asked for, so the shell layout can bring a signed-out visitor back to it after sign-in; both headers are set here, never taken from the browser. */
export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl
  const { face, redirect } = faceRoute({ host: request.headers.get('host') ?? request.nextUrl.host, pathname, dev: process.env.FACE_DEV, production: process.env.NODE_ENV === 'production' })
  if (redirect) return NextResponse.redirect(new URL(`${redirect}${search}`, request.url), 307)
  const headers = new Headers(request.headers)
  if (face) headers.set('x-face', face)
  else headers.delete('x-face')
  headers.set('x-next', `${pathname}${search}`)
  return NextResponse.next({ request: { headers } })
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] }
