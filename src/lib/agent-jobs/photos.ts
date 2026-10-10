/** D143 — which of the files an operator picked become photos of a batch. Pure, so the page stays thin. */

const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic'])

export interface PickedFile { readonly name: string; readonly type: string; readonly size: number; readonly lastModified: number }

/** The same file picked twice has the same name, size and timestamp; that is all a browser tells us. */
export function photoSignature(file: PickedFile): string {
  return `${file.name}|${file.size}|${file.lastModified}`
}

export function isPhoto(file: PickedFile): boolean {
  return ACCEPTED.has(file.type) || /\.(heic|jpe?g|png|webp)$/i.test(file.name)
}

/**
 * Splits a pick into the photos to upload, the files that are not photos, and the photos already in
 * the batch (`known` holds their signatures). A repeat inside one pick counts as already there.
 */
export function pickPhotos<T extends PickedFile>(files: readonly T[], known: ReadonlySet<string>): { fresh: T[]; skipped: number; repeats: number } {
  const seen = new Set(known)
  const fresh: T[] = []
  let skipped = 0
  let repeats = 0
  for (const file of files) {
    if (!isPhoto(file)) { skipped += 1; continue }
    const sig = photoSignature(file)
    if (seen.has(sig)) { repeats += 1; continue }
    seen.add(sig)
    fresh.push(file)
  }
  return { fresh, skipped, repeats }
}
