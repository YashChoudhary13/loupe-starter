/**
 * One line of plain English per saved style preset, for the operator choosing
 * between them before a batch goes up.
 *
 * The prompts themselves live in the database and are the source of truth; this
 * is only what the console calls them. A preset with no entry here still shows —
 * it falls back to its own name — so adding a preset needs no code change.
 */
const PRESET_NOTES: Record<string, string> = {
  marble: 'White-and-cream marble with warm veining. The describer picks the pose.',
  yellow: 'Flat sand-yellow backdrop, no texture. The describer picks the pose.',
  'hand-chain': 'Worn on a hand against ivory silk. The describer records how the piece connects.',
  bag: 'Standing upright on marble, sleek. The describer transcribes printed lettering exactly.',
}

export function presetNote(slug: string): string | null {
  return PRESET_NOTES[slug] ?? null
}
