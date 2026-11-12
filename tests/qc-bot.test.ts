import { describe, expect, it, vi } from 'vitest'
import { missingItems, notifyMissing, withMissingNotice } from '@/lib/qc/bot'
import type { QcShortage, QcView } from '@/lib/qc/types'

const shortage = (over: Partial<QcShortage>): QcShortage => ({ id: 'x', ref: 1, session_id: 's', event_id: 'e', order_id: 'gid://shopify/Order/1', order_name: 'Qimati7831', generation: 1, line_id: 'l', variant_id: 'v',
  sku: 'ER656-C-GOLD', title: 'Earrings 656', variant_title: 'Gold', quantity: 1, reason: 'not in stock', reported_by: 'op', reported_at: '', resolved_at: null, resolved_by: null, resolution: null, resolution_note: null, ...over })
const env = { BOT_MISSING_WEBHOOK_URL: 'https://n8n.example/webhook/loupe-missing', BOT_WEBHOOK_SECRET: 'secret' }

describe('missing pieces for the WhatsApp bot', () => {
  it('names each line by SKU plus option, adds quantities, and leaves out resolved and SKU-less lines', () => {
    expect(missingItems([shortage({}), shortage({ quantity: 2 }), shortage({ sku: 'RS284', variant_title: 'Pink' }), shortage({ sku: 'NK1', variant_title: null }), shortage({ resolved_at: 'x' }), shortage({ sku: null })]))
      .toEqual({ items: [{ code: 'ER656-C-GOLD Gold', qty: 3 }, { code: 'RS284 Pink', qty: 1 }, { code: 'NK1', qty: 1 }], skipped: 1 })
  })
  it('stays silent until the bot door is configured, and when nothing is short', async () => {
    const post = vi.fn()
    expect(await notifyMissing('Qimati7831', [shortage({})], 'op', {}, post)).toBeNull()
    expect(await notifyMissing('Qimati7831', [shortage({})], 'op', { ...env, BOT_MISSING_WEBHOOK_URL: 'http://plain.example' }, post)).toBeNull()
    expect(await notifyMissing('Qimati7831', [], 'op', env, post)).toBeNull()
    expect(post).not.toHaveBeenCalled()
  })
  it('sends the order number and pieces with the bearer secret, and never a customer or an amount', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    expect(await notifyMissing('Qimati7831', [shortage({})], 'Asha', env, post)).toContain('sent to WhatsApp')
    const [url, init] = post.mock.calls[0]
    expect(url).toBe(env.BOT_MISSING_WEBHOOK_URL)
    expect(init.headers.Authorization).toBe('Bearer secret')
    expect(JSON.parse(init.body)).toEqual({ order: '7831', by: 'Asha', items: [{ code: 'ER656-C-GOLD Gold', qty: 1 }] })
  })
  it('tells the operator where to resend when the bot refuses or is down, without throwing', async () => {
    expect(await notifyMissing('Qimati7831', [shortage({})], 'op', env, vi.fn().mockResolvedValue({ ok: false, status: 401 }))).toContain('Send to WhatsApp')
    expect(await notifyMissing('Qimati7831', [shortage({})], 'op', env, vi.fn().mockRejectedValue(new Error('down')))).toContain('Send to WhatsApp')
  })
  it('only speaks for a checklist that passed just now with something short', async () => {
    const view = (outcome: string, replayed = false, shortages = [shortage({})]) => ({ order: { name: 'Qimati7831' }, session: { snapshot: { name: 'Qimati7831' } }, shortages, replayed, event: { outcome, actor_name: 'op' } }) as unknown as QcView
    for (const [candidate, action] of [[view('passed'), 'scan'], [view('incomplete'), 'complete'], [view('passed', true), 'complete'], [view('passed', false, []), 'complete']] as const)
      expect(await withMissingNotice(candidate, action)).toBe(candidate)
  })
})
