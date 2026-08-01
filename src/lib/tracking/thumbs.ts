/**
 * Which stored thumbnail represents a row in Tracking.
 *
 * Kept pure and out of the read model so the one rule that breaks silently can
 * be tested: **a purged version must never produce a URL.** Retention deletes
 * the R2 object seven days after publish and deliberately keeps the row for the
 * audit trail (D5), so `thumb_key` still reads fine and still presigns fine —
 * and then 404s in the operator's browser. That failure would appear a week
 * after the code that caused it, on published work only.
 *
 * A blank square is honest. A broken image looks like a bug in the console.
 */

export interface ThumbCandidate {
  readonly versionNo: number
  readonly isSelected: boolean
  readonly thumbKey: string | null
  readonly purgedAt: string | null
}

/** The selected version's thumbnail, else the newest usable one. */
export function preferredThumbKey(candidates: readonly ThumbCandidate[]): string | null {
  const usable = candidates.filter(
    (candidate) => candidate.purgedAt === null && candidate.thumbKey,
  )
  const best = [...usable].sort(
    (a, b) => Number(b.isSelected) - Number(a.isSelected) || b.versionNo - a.versionNo,
  )[0]
  return best?.thumbKey ?? null
}

export interface DraftCoverCandidate {
  readonly draftId: string
  readonly position: number
  readonly thumbKey: string | null
  readonly purgedAt: string | null
}

/**
 * A draft's cover is image position 1 — the operator's own order, and the one
 * Shopify shows first. If that image is purged the draft has no cover rather
 * than silently promoting a different photograph, which would make two products
 * in the list look like the same one.
 */
export function draftCoverKeys(
  candidates: readonly DraftCoverCandidate[],
): Map<string, string> {
  const lowest = new Map<string, DraftCoverCandidate>()
  for (const candidate of candidates) {
    const current = lowest.get(candidate.draftId)
    if (!current || candidate.position < current.position) {
      lowest.set(candidate.draftId, candidate)
    }
  }

  const covers = new Map<string, string>()
  for (const [draftId, candidate] of lowest) {
    if (candidate.purgedAt === null && candidate.thumbKey) {
      covers.set(draftId, candidate.thumbKey)
    }
  }
  return covers
}
