/** The four faces of one app, chosen by hostname (D136). Pure: no env, no Next import, so the proxy, the shell and tests share it. */
export const FACE_DOMAIN = 'qimati-eng.site'
export const FACES = {
  home: { host: 'qimati-eng.site', label: 'Qimati', screens: ['/home'] },
  loupe: { host: 'loupe.qimati-eng.site', label: 'Loupe', screens: ['/console', '/upload', '/identify', '/restock', '/tracking', '/prompts', '/models', '/workflows'] },
  qc: { host: 'qc.qimati-eng.site', label: 'Order QC', screens: ['/qc', '/labels'] },
  ship: { host: 'ship.qimati-eng.site', label: 'Fulfilment', screens: ['/dispatch'] },
} as const
export type Face = keyof typeof FACES
export const FACE_KEYS = Object.keys(FACES) as Face[]
/** Served by every face: the API, sign-in, diagnostics, Next's own assets and any file with an extension. */
const OPEN_PREFIXES = ['/api/', '/login', '/health', '/_next/']

export function isFace(value: unknown): value is Face { return typeof value === 'string' && Object.hasOwn(FACES, value) }
/** The `x-face` request header the proxy sets. Anything else (including a client-sent value the proxy dropped) is no face. */
export function faceFromHeader(value: string | null | undefined): Face | null { return isFace(value) ? value : null }
export function faceOfHost(host: string | null | undefined): Face | null {
  const name = (host ?? '').trim().toLowerCase().replace(/:\d+$/, '')
  return FACE_KEYS.find(face => FACES[face].host === name) ?? null
}
/** A real face host wins; production always falls back to Loupe so a stray DNS record never shows a blank page — FACE_DEV is for local work only; a dev machine with neither is unrestricted (null). */
export function faceForHost(host: string | null | undefined, options: { dev?: string; production: boolean }): Face | null {
  const real = faceOfHost(host)
  if (real) return real
  if (options.production) return 'loupe'
  if (isFace(options.dev)) return options.dev
  return null
}
const under = (pathname: string, screen: string) => pathname === screen || pathname.startsWith(`${screen}/`)
export function screenAllowed(face: Face | null, pathname: string): boolean {
  if (face === null) return true
  if (OPEN_PREFIXES.some(prefix => pathname.startsWith(prefix)) || /\.[a-z0-9]+$/i.test(pathname)) return true
  return FACES[face].screens.some(screen => under(pathname, screen))
}
export function owningFace(pathname: string): Face | null { return FACE_KEYS.find(face => FACES[face].screens.some(screen => under(pathname, screen))) ?? null }
export function faceHome(face: Face | null): string { return face ? FACES[face].screens[0] : '/console' }
export function faceOrigins(): string[] { return FACE_KEYS.map(face => `https://${FACES[face].host}`) }
/** Where a finished sign-in returns to: the face host recorded when it started, else the configured base. Never a value the browser chose. */
export function faceReturnUrl(face: unknown, fallbackBase: string): string { return isFace(face) ? `https://${FACES[face].host}/` : `${fallbackBase.replace(/\/+$/, '')}/` }

export interface FaceRoute { face: Face | null; redirect: string | null }
/** The proxy's decision for one request. A redirect is absolute whenever the request arrived on a real face host or the app is in production, so it can never resolve against a bind address like 127.0.0.1 behind nginx. */
export function faceRoute(input: { host: string | null | undefined; pathname: string; dev?: string; production: boolean }): FaceRoute {
  const face = faceForHost(input.host, input)
  const real = faceOfHost(input.host)
  const origin = face && (real || input.production) ? `https://${FACES[face].host}` : ''
  if (input.pathname === '/') return { face, redirect: `${origin}${faceHome(face)}` }
  if (screenAllowed(face, input.pathname)) return { face, redirect: null }
  const owner = owningFace(input.pathname)
  return { face, redirect: owner ? `https://${FACES[owner].host}${input.pathname}` : null }
}
