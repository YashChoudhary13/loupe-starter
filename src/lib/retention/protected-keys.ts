/**
 * R2 prefixes that hold a photographer's real photograph, or a photograph an
 * operator took to identify stock. Nothing in Loupe deletes these — not
 * retention, not the discard of a held photograph. They are the only real
 * images of the products and the references the SKU matcher is built on
 * (docs/LOUPE-INTEGRATION-PLAN.md §1.3, 2026-08-21).
 *
 *   originals/   the immutable copy the enhancement worker writes
 *   manual/      the browser-uploaded source (ready images and D103 raw uploads)
 *   references/  copies registered for the matcher
 *   identify/    photographs taken on the /identify screen
 */
export const PROTECTED_KEY_PREFIXES = [
  'originals/',
  'manual/',
  'references/',
  'identify/',
] as const

export function isProtectedKey(key: string): boolean {
  return PROTECTED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
}
