import 'server-only'

import { supabaseServer } from '@/lib/supabase/server'

import {
  findDuplicateCandidates,
  type DuplicateCandidate,
  type HashPhoto,
  type ReviewedPair,
} from './candidates'

interface IntakeHashRow {
  id: string
  filename: string
  phash: string | null
  status: string
  discovered_at: string
  product_draft_id: string | null
}

function toHashPhoto(row: IntakeHashRow): HashPhoto | null {
  if (!row.phash) return null
  return {
    id: row.id,
    filename: row.filename,
    phash: row.phash,
    status: row.status,
    discoveredAt: row.discovered_at,
    productDraftId: row.product_draft_id,
  }
}

export async function loadDuplicateCandidates(
  intakeFileIds?: readonly string[],
): Promise<readonly DuplicateCandidate[]> {
  const db = supabaseServer()
  let reviewableQuery = db
    .from('intake_files')
    .select('id, filename, phash, status, discovered_at, product_draft_id')
    .in('status', ['enhanced', 'failed', 'grouped'])
    .not('phash', 'is', null)
    .order('discovered_at', { ascending: false })
    .limit(500)
  if (intakeFileIds) reviewableQuery = reviewableQuery.in('id', [...intakeFileIds])

  const [reviewableResult, allResult, reviewsResult] = await Promise.all([
    reviewableQuery,
    db
      .from('intake_files')
      .select('id, filename, phash, status, discovered_at, product_draft_id')
      .not('phash', 'is', null)
      .order('discovered_at', { ascending: false })
      .limit(5000),
    db
      .from('duplicate_reviews')
      .select('left_intake_file_id, right_intake_file_id')
      .limit(5000),
  ])

  if (reviewableResult.error) {
    throw new Error(`duplicate review queue: ${reviewableResult.error.message}`)
  }
  if (allResult.error) throw new Error(`duplicate hash catalogue: ${allResult.error.message}`)
  if (reviewsResult.error) throw new Error(`duplicate reviews: ${reviewsResult.error.message}`)

  const reviewable = ((reviewableResult.data ?? []) as IntakeHashRow[])
    .map(toHashPhoto)
    .filter((row): row is HashPhoto => row !== null)
  const all = ((allResult.data ?? []) as IntakeHashRow[])
    .map(toHashPhoto)
    .filter((row): row is HashPhoto => row !== null)
  const reviewed = ((reviewsResult.data ?? []) as {
    left_intake_file_id: string
    right_intake_file_id: string
  }[]).map<ReviewedPair>((row) => ({
    leftIntakeFileId: row.left_intake_file_id,
    rightIntakeFileId: row.right_intake_file_id,
  }))

  return findDuplicateCandidates(reviewable, all, reviewed)
}
