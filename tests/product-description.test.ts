import { describe, expect, it } from 'vitest'

import {
  buildDescriptionHtml,
  defaultDescriptionText,
  materialDescriptor,
  resolveDescriptionText,
} from '@/lib/publish/description'

describe('product descriptions', () => {
  it('expands the controlled steel names used by the live catalogue', () => {
    expect(materialDescriptor('304')).toBe('304 Stainless Steel')
    expect(materialDescriptor('316L')).toBe('316L Stainless Steel')
    expect(defaultDescriptionText('316L').split('\n')).toHaveLength(6)
  })

  it('uses a one-off custom material in the standard description', () => {
    expect(defaultDescriptionText('  Sterling   Silver  ')).toContain(
      'Premium Sterling Silver – durable and ready for everyday wear',
    )
  })

  it('writes the owner-approved reseller wording, with a brass-specific first line', () => {
    const steel = defaultDescriptionText('316L').split('\n')
    expect(steel[0]).toBe(
      '• Premium 316L Stainless Steel – highly durable, rust-resistant and ready for everyday wear',
    )
    expect(defaultDescriptionText('Brass').split('\n')[0]).toBe(
      '• Premium Brass – warm-toned, durable and easy to care for',
    )
    const text = defaultDescriptionText('304')
    for (const banned of ['Made with', 'made to last', 'skin-friendly', 'Waterproof', 'Surgical Grade', 'ensures', 'rare in most brands', 'Plating']) {
      expect(text).not.toContain(banned)
    }
    expect(text).toContain('Water-resistant for daily wear — remove before swimming, bathing or physical activity')
    expect(text).toContain('Advanced PVD Coating, not standard plating')
  })

  it('uses the optional override instead of the standard wording', () => {
    expect(resolveDescriptionText('304', '  A rare one-off piece.  ')).toBe(
      'A rare one-off piece.',
    )
    expect(resolveDescriptionText('304', null)).toContain('304 Stainless Steel')
  })

  it('escapes override text and never passes operator HTML through', () => {
    expect(buildDescriptionHtml('Brass', '<script>alert("x")</script>\nSafe & bright')).toBe(
      '<ul><li>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</li><li>Safe &amp; bright</li></ul>',
    )
  })
})
