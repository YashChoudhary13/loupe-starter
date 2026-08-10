/**
 * What the console calls each saved style preset, in plain English, for the
 * operator choosing between them before a batch goes up.
 *
 * The prompts themselves live in the database and are the source of truth. A
 * preset with no entry here still shows — it falls back to its own prompt name —
 * so adding a preset needs no code change.
 */
const PRESETS: Record<string, { label: string; note: string }> = {
  satin: {
    label: 'Pearl-ivory satin — luxury default',
    note: 'Original luxury macro lighting and creamy satin depth, protected by exact construction, topology and proportional-zoom checks.',
  },
  marble: {
    label: 'Pale marble — luxury macro',
    note: 'Quiet polished marble, dimensional campaign lighting and the same protected construction-aware hero crop.',
  },
  yellow: {
    label: 'Muted sand — luxury macro',
    note: 'Smooth desaturated sand with deliberate gold separation, dimensional lighting and protected retail posing.',
  },
  necklace: {
    label: 'Necklaces — full-length hero',
    note: 'For neck-length chains, which the general presets render at bracelet scale. States the real worn length, keeps links fine and the neck opening wide, and stages the pose itself.',
  },
  'waist-chain': {
    label: 'Waist chains — full-length hero',
    note: 'For waist and hip chains, the longest pieces in the catalogue. Adds the adjuster run, dangling charms and a smooth seamless sweep, and refuses the anklet pose the shared classes fall back to.',
  },
  'chain-bracelet': {
    label: 'Chain bracelets — wrist-scale hero',
    note: 'For flexible wrist chains, which the general presets pose at necklace scale. States the real worn length, keeps links countable and the extender at its true fraction, and fastens the small circle itself on the house satin.',
  },
  'hand-chain': {
    label: 'Hand chain — worn',
    note: 'Close, low-distortion worn view with the same protected construction checks; exact wrist, branch, junction and finger-loop connections preserved.',
  },
  bag: {
    label: 'Bags — truthful premium hero',
    note: 'The most flattering supported angle with the same protected construction checks; the bag is never inflated or reshaped and artwork and lettering stay exact.',
  },
}

/** Display order. Anything not listed sorts after, alphabetically. */
const ORDER = ['satin', 'marble', 'yellow', 'necklace', 'waist-chain', 'chain-bracelet', 'hand-chain', 'bag']

export function presetLabel(slug: string): string | null {
  return PRESETS[slug]?.label ?? null
}

export function presetNote(slug: string): string | null {
  return PRESETS[slug]?.note ?? null
}

export function presetRank(slug: string): number {
  const index = ORDER.indexOf(slug)
  return index === -1 ? ORDER.length : index
}
