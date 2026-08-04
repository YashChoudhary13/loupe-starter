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
    label: 'Pearl-ivory satin — premium default',
    note: 'Neutral pearl-ivory satin with edge folds, strong product separation and construction-aware retail posing.',
  },
  marble: {
    label: 'Pale marble — premium retail',
    note: 'Quiet white-and-cream marble with restrained veining and the same faithful, construction-aware hero crop.',
  },
  yellow: {
    label: 'Muted sand backdrop',
    note: 'Smooth desaturated sand yellow with deliberate contrast from gold and the same faithful retail posing.',
  },
  'hand-chain': {
    label: 'Hand chain — worn',
    note: 'Close, low-distortion worn view with exact wrist, branch, junction and finger-loop connections preserved.',
  },
  bag: {
    label: 'Bags — truthful premium hero',
    note: 'The most flattering supported angle without inflating or reshaping the bag; artwork and lettering stay exact.',
  },
}

/** Display order. Anything not listed sorts after, alphabetically. */
const ORDER = ['satin', 'marble', 'yellow', 'hand-chain', 'bag']

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
