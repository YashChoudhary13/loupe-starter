/**
 * A draft that never reached Shopify must not look finished.
 *
 * On 2026-08-17 three drafts were saved and pushed normally and a fourth was
 * only grouped: `product_drafts` held the row, `reserved_sku`,
 * `shopify_product_id` and `error` were all NULL, and the only event was
 * `draft.created`. The queue tile renders `reservedSku ?? categoryName`, so it
 * read "Kada Bracelets" — identical to a finished draft — and the photograph had
 * already left Pending. The operator had no way to see that nothing existed in
 * Shopify.
 *
 * The rule is age-based on purpose (hard rule 5). "Assembling with no Shopify
 * product" is the NORMAL state for the seconds between the save response and the
 * background push completing; flagging on status alone would mark every healthy
 * draft the moment it was saved.
 */
import { describe, expect, it } from 'vitest'

import { isUnpushedDraft, UNPUSHED_DRAFT_MINUTES } from '@/lib/console/queue-view'

const NOW = Date.parse('2026-08-17T11:07:00.000Z')

function minutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString()
}

describe('isUnpushedDraft', () => {
  it('flags the real case: grouped, never saved, no Shopify product', () => {
    // draft 1458d9b5, created 11:02:04, untouched since.
    expect(
      isUnpushedDraft(
        { status: 'assembling', shopify_product_id: null, updated_at: minutesAgo(5) },
        NOW,
      ),
    ).toBe(true)
  })

  it('leaves a just-saved draft alone while its background push is still running', () => {
    // The push runs after the response (D60). Zero seconds of grace would paint
    // an amber dot on every healthy draft for the few seconds productSet takes.
    expect(
      isUnpushedDraft(
        { status: 'assembling', shopify_product_id: null, updated_at: minutesAgo(0) },
        NOW,
      ),
    ).toBe(false)
    expect(
      isUnpushedDraft(
        {
          status: 'assembling',
          shopify_product_id: null,
          updated_at: minutesAgo(UNPUSHED_DRAFT_MINUTES - 0.1),
        },
        NOW,
      ),
    ).toBe(false)
  })

  it('never flags a draft that reached Shopify, however old', () => {
    expect(
      isUnpushedDraft(
        {
          status: 'assembling',
          shopify_product_id: 'gid://shopify/Product/10153842966825',
          updated_at: minutesAgo(10_000),
        },
        NOW,
      ),
    ).toBe(false)
  })

  it('leaves publishing and failed drafts to their own attention lines', () => {
    for (const status of ['publishing', 'failed', 'published']) {
      expect(
        isUnpushedDraft({ status, shopify_product_id: null, updated_at: minutesAgo(60) }, NOW),
      ).toBe(false)
    }
  })
})
