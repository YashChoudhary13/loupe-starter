/**
 * Qimati's clean six-bullet product description.
 *
 * The wording matches the live catalogue after the 2026-08-28 copy pass, but the HTML does not: old
 * products carry pasted WhatsApp classes and heading tags. Loupe stores a
 * plain-text override and owns the small, escaped HTML wrapper (D50).
 */

export const DESCRIPTION_OVERRIDE_MAX_LENGTH = 5_000

const CONTROLLED_MATERIALS = ['304', '316L', 'Brass'] as const

/** The live store's material tags are exactly these three names (D50, 2026-08-28). */
export function isControlledMaterial(material: string | null | undefined): boolean {
  const clean = material?.trim().replace(/\s+/g, ' ') ?? ''
  return (CONTROLLED_MATERIALS as readonly string[]).includes(clean)
}

// Wording approved by the owner on 2026-08-28 (Qimati SEO changelog, same date).
// Qimati is a reseller: no maker verbs ("made", "crafted"), no absolutes, no
// performance guarantees. Brass gets its own first line — it does not rust, it
// warms with wear.
function materialBullet(descriptor: string, material: string): string {
  const clean = material.trim().replace(/\s+/g, ' ')
  if (clean === 'Brass') return 'Premium Brass – warm-toned, durable and easy to care for'
  if (clean === '304' || clean === '316L') {
    return `Premium ${descriptor} – highly durable, rust-resistant and ready for everyday wear`
  }
  return `Premium ${descriptor} – durable and ready for everyday wear`
}

const STANDARD_BULLETS = [
  (descriptor: string, material: string) => materialBullet(descriptor, material),
  () => 'Water-resistant for daily wear — remove before swimming, bathing or physical activity',
  () => 'Not fully soap-proof or chemical-proof – avoid harsh chemicals for longer life',
  () => 'Finished in 18KT Gold Tone for a rich luxury look',
  () =>
    'Advanced PVD Coating, not standard plating – long-lasting colour, anti-tarnish & scratch resistance',
  () => 'Extra E-Coating Layer on top – added protection and shine',
] as const

const MATERIAL_DESCRIPTORS: Readonly<Record<string, string>> = {
  '304': '304 Stainless Steel',
  '316L': '316L Stainless Steel',
  Brass: 'Brass',
}

export function materialDescriptor(material: string): string {
  const clean = material.trim().replace(/\s+/g, ' ')
  return MATERIAL_DESCRIPTORS[clean] ?? clean
}

export function defaultDescriptionText(material: string): string {
  const descriptor = materialDescriptor(material)
  if (!descriptor) return ''
  return STANDARD_BULLETS.map((line) => `• ${line(descriptor, material)}`).join('\n')
}

export function resolveDescriptionText(
  material: string | null,
  override: string | null,
): string {
  return override?.trim() || (material ? defaultDescriptionText(material) : '')
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function buildDescriptionHtml(material: string | null, override: string | null): string {
  const text = resolveDescriptionText(material, override)
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[•*-]\s*/, ''))
    .filter(Boolean)

  if (lines.length === 0) return ''
  return `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`
}
