import {
  DUPLICATE_DISTANCE_THRESHOLD,
  perceptualHashDistance,
} from './phash'

export interface HashPhoto {
  readonly id: string
  readonly filename: string
  readonly phash: string
  readonly status: string
  readonly discoveredAt: string
  readonly productDraftId: string | null
}

export interface ReviewedPair {
  readonly leftIntakeFileId: string
  readonly rightIntakeFileId: string
}

export interface DuplicateCandidate {
  readonly intakeFileId: string
  readonly filename: string
  readonly status: string
  readonly discoveredAt: string
  readonly matchIntakeFileId: string
  readonly matchFilename: string
  readonly matchStatus: string
  readonly matchDiscoveredAt: string
  readonly distance: number
}

export function canonicalPair(left: string, right: string): readonly [string, string] {
  return left < right ? [left, right] : [right, left]
}

export function pairKey(left: string, right: string): string {
  return canonicalPair(left, right).join(':')
}

function later(left: HashPhoto, right: HashPhoto): HashPhoto {
  const time = left.discoveredAt.localeCompare(right.discoveredAt)
  return time > 0 || (time === 0 && left.id > right.id) ? left : right
}

/**
 * Returns the strongest unreviewed warning for each reviewable photograph.
 *
 * A published/older photograph may be the match, but only a current working
 * photograph becomes the review target. This keeps the work bounded by the live
 * queue instead of comparing every historical pair. SQL separately enforces that
 * only an ungrouped target can actually be marked duplicate.
 */
export function findDuplicateCandidates(
  reviewable: readonly HashPhoto[],
  all: readonly HashPhoto[],
  reviewed: readonly ReviewedPair[],
  threshold = DUPLICATE_DISTANCE_THRESHOLD,
): readonly DuplicateCandidate[] {
  const reviewableIds = new Set(reviewable.map((photo) => photo.id))
  const reviewedKeys = new Set(
    reviewed.map((pair) => pairKey(pair.leftIntakeFileId, pair.rightIntakeFileId)),
  )
  const seenPairs = new Set<string>()
  const bestByTarget = new Map<string, DuplicateCandidate>()

  for (const left of reviewable) {
    for (const right of all) {
      if (left.id === right.id || right.status === 'duplicate' || right.status === 'skipped') {
        continue
      }
      const key = pairKey(left.id, right.id)
      if (seenPairs.has(key) || reviewedKeys.has(key)) continue
      seenPairs.add(key)

      const distance = perceptualHashDistance(left.phash, right.phash)
      if (distance > threshold) continue

      const target =
        reviewableIds.has(right.id) && reviewableIds.has(left.id)
          ? later(left, right)
          : left
      const match = target.id === left.id ? right : left
      const candidate: DuplicateCandidate = {
        intakeFileId: target.id,
        filename: target.filename,
        status: target.status,
        discoveredAt: target.discoveredAt,
        matchIntakeFileId: match.id,
        matchFilename: match.filename,
        matchStatus: match.status,
        matchDiscoveredAt: match.discoveredAt,
        distance,
      }
      const prior = bestByTarget.get(target.id)
      if (!prior || candidate.distance < prior.distance) {
        bestByTarget.set(target.id, candidate)
      }
    }
  }

  return [...bestByTarget.values()].sort(
    (a, b) =>
      a.distance - b.distance ||
      b.discoveredAt.localeCompare(a.discoveredAt) ||
      a.intakeFileId.localeCompare(b.intakeFileId),
  )
}
