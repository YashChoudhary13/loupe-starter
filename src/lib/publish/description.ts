/**
 * Qimati's clean six-bullet product description.
 *
 * The wording matches the current live catalogue, but the HTML does not: old
 * products carry pasted WhatsApp classes and heading tags. Loupe stores a
 * plain-text override and owns the small, escaped HTML wrapper (D50).
 */

export const DESCRIPTION_OVERRIDE_MAX_LENGTH = 5_000

const STANDARD_BULLETS = [
  (material: string) =>
    `Made with premium ${material} – highly durable, rust-resistant & skin-friendly`,
  () => 'Water-resistant / Waterproof – safe for daily wear, sweat & moisture',
  () => 'Not fully soap-proof or chemical-proof – avoid harsh chemicals for longer life',
  () => 'Finished with 18KT Gold Tone Plating for a rich luxury look',
  () => 'Advanced PVD Coating – ensures long-lasting color, anti-tarnish & scratch resistance',
  () => 'Extra E-Coating Layer on top – added protection & shine (rare in most brands)',
] as const

const MATERIAL_DESCRIPTORS: Readonly<Record<string, string>> = {
  '304': '304 Stainless Steel',
  '316L': '316L Stainless Steel (Surgical Grade)',
  Brass: 'Brass',
}

export function materialDescriptor(material: string): string {
  const clean = material.trim().replace(/\s+/g, ' ')
  return MATERIAL_DESCRIPTORS[clean] ?? clean
}

export function defaultDescriptionText(material: string): string {
  const descriptor = materialDescriptor(material)
  if (!descriptor) return ''
  return STANDARD_BULLETS.map((line) => `• ${line(descriptor)}`).join('\n')
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
