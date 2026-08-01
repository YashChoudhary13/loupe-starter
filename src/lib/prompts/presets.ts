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
    label: 'Ivory satin — the catalogue default',
    note: 'Ivory-champagne satin with soft folds. The prompt every published product so far was built on.',
  },
  marble: {
    label: 'Marble surface',
    note: 'White-and-cream marble with warm veining. The describer picks the pose.',
  },
  yellow: {
    label: 'Plain yellow backdrop',
    note: 'Flat sand-yellow backdrop, no texture. The describer picks the pose.',
  },
  'hand-chain': {
    label: 'Hand chain — worn',
    note: 'Worn on a hand against ivory silk. The describer records how the piece connects.',
  },
  bag: {
    label: 'Bags — standing',
    note: 'Standing upright on marble, sleek. The describer transcribes printed lettering exactly.',
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
