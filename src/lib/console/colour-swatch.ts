/**
 * The small, stable palette used by the listing console.
 *
 * Shopify still needs a human-readable label ("Gold", "Rose Gold", …) to
 * identify a saved colour. The console turns that label into a swatch for the
 * operator; publishing then links the variant to Shopify's native saved-colour
 * metaobject while retaining the name for accessibility and auditability.
 */
export interface JewelleryColour {
  readonly name: string
  /** Representative solid used when this colour is one part of a split swatch. */
  readonly colour: string
  readonly background: string
}

export const JEWELLERY_COLOUR_PALETTE: readonly JewelleryColour[] = [
  {
    name: 'Gold',
    colour: '#d4af37',
    background: 'linear-gradient(135deg, #8f6816 0%, #d4af37 45%, #f3dc82 70%, #a77c20 100%)',
  },
  {
    name: 'Silver',
    colour: '#c8cbd0',
    background: 'linear-gradient(135deg, #74777c 0%, #c8cbd0 43%, #f4f5f6 70%, #96999e 100%)',
  },
  {
    name: 'Rose Gold',
    colour: '#b76e79',
    background: 'linear-gradient(135deg, #8f4f58 0%, #b76e79 42%, #e5b0aa 72%, #9f5f66 100%)',
  },
  { name: 'White', colour: '#f7f7f5', background: '#f7f7f5' },
  { name: 'Black', colour: '#202124', background: '#202124' },
  { name: 'Red', colour: '#c9363e', background: '#c9363e' },
  { name: 'Blue', colour: '#3567b7', background: '#3567b7' },
  { name: 'Green', colour: '#3f8058', background: '#3f8058' },
  { name: 'Pink', colour: '#df8faa', background: '#df8faa' },
  { name: 'Purple', colour: '#7954a8', background: '#7954a8' },
  { name: 'Yellow', colour: '#e7bd38', background: '#e7bd38' },
  {
    name: 'Multi Colour',
    colour: '#7954a8',
    background:
      'conic-gradient(#c9363e 0 17%, #e7bd38 17% 34%, #3f8058 34% 51%, #3567b7 51% 68%, #7954a8 68% 84%, #df8faa 84% 100%)',
  },
] as const

const normalise = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()
const byName = new Map(JEWELLERY_COLOUR_PALETTE.map((colour) => [normalise(colour.name), colour]))

const aliases = new Map<string, string>([
  ['gray', 'Silver'],
  ['grey', 'Silver'],
  ['gold tone', 'Gold'],
  ['gold-tone', 'Gold'],
  ['yellow gold', 'Gold'],
  ['silver tone', 'Silver'],
  ['silver-tone', 'Silver'],
  ['white gold', 'Silver'],
  ['pink gold', 'Rose Gold'],
  ['multicolour', 'Multi Colour'],
  ['multi-color', 'Multi Colour'],
  ['multicolor', 'Multi Colour'],
])

const UNKNOWN_SWATCH =
  'linear-gradient(135deg, #d7d7da 0 46%, #ffffff 46% 54%, #8b8b90 54% 100%)'

function knownColour(value: string): JewelleryColour | null {
  const key = normalise(value)
  const direct = byName.get(key)
  if (direct) return direct

  const alias = aliases.get(key)
  if (alias) return byName.get(normalise(alias)) ?? null

  // Handles useful modifiers without inventing a different colour: e.g.
  // "Light Rose Gold" and "Dark Blue" still preview as their base colour.
  return (
    [...JEWELLERY_COLOUR_PALETTE]
      .filter((colour) => colour.name !== 'Multi Colour')
      .sort((left, right) => right.name.length - left.name.length)
      .find((colour) => key.includes(normalise(colour.name))) ?? null
  )
}

/** CSS background for a colour name, including simple two-tone names. */
export function colourSwatchBackground(name: string): string {
  const rawParts = name.split(/\s*(?:\/|&|\+|,|\band\b)\s*/i)
  const parts = rawParts
    .map((part) => knownColour(part))
    .filter((colour): colour is JewelleryColour => colour !== null)

  if (rawParts.length >= 2 && parts.length >= 2) {
    const stops = parts
      .slice(0, 4)
      .map((colour, index, colours) => {
        const start = Math.round((index / colours.length) * 100)
        const end = Math.round(((index + 1) / colours.length) * 100)
        return `${colour.colour} ${start}% ${end}%`
      })
    return `conic-gradient(${stops.join(', ')})`
  }

  const direct = knownColour(name)
  if (direct) return direct.background

  // Unknown remembered vocabulary stays visibly "custom" rather than being
  // assigned a plausible but false hue.
  return UNKNOWN_SWATCH
}

/**
 * Representative solid for Shopify's native saved-colour entry.
 *
 * Split and multi-colour swatches deliberately return null: compressing a
 * pattern into one plausible-looking solid would publish false structured
 * data. Those values must already exist as a richer saved colour in Shopify.
 */
export function colourSwatchHex(name: string): string | null {
  const parts = name.split(/\s*(?:\/|&|\+|,|\band\b)\s*/i)
  if (parts.length > 1) return null
  const colour = knownColour(name)
  return colour && colour.name !== 'Multi Colour' ? colour.colour : null
}

/**
 * Category-ranked remembered colours first, then the stable palette. Duplicate
 * spellings are removed case-insensitively.
 */
export function colourPaletteNames(
  suggestions: readonly { readonly name: string }[],
): readonly string[] {
  const names: string[] = []
  const seen = new Set<string>()

  for (const name of [
    ...suggestions.map((suggestion) => suggestion.name),
    ...JEWELLERY_COLOUR_PALETTE.map((colour) => colour.name),
  ]) {
    const key = normalise(name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }

  return names
}
