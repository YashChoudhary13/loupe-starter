import { describe, expect, it } from 'vitest'

import {
  POSTGREST_IN_BATCH_SIZE,
  queryBatches,
} from '@/lib/tracking/query-batches'

describe('tracking PostgREST query batches', () => {
  it('keeps a large UUID filter below the request-header limit without losing values', () => {
    const values = Array.from({ length: 440 }, (_, index) => `entity-${index}`)

    const batches = queryBatches(values)

    expect(batches).toHaveLength(5)
    expect(batches.every((batch) => batch.length <= POSTGREST_IN_BATCH_SIZE)).toBe(true)
    expect(batches.flat()).toEqual(values)
  })

  it('does not issue an empty IN query', () => {
    expect(queryBatches([])).toEqual([])
  })
})
