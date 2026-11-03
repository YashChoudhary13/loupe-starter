import { describe, expect, it } from 'vitest'

import {
  buildDescriptionHtml,
  defaultDescriptionText,
  magnetBullet,
  materialDescriptor,
  resolveDescriptionText,
} from '@/lib/publish/description'

describe('product descriptions', () => {
  it('expands the controlled steel names used by the live catalogue', () => {
    expect(materialDescriptor('304')).toBe('304 Stainless Steel')
    expect(materialDescriptor('316L')).toBe('316L Stainless Steel')
    expect(defaultDescriptionText('316L').split('\n')).toHaveLength(7)
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
      `A rare one-off piece.\n• ${magnetBullet('304')}`,
    )
    expect(resolveDescriptionText('304', null)).toContain('304 Stainless Steel')
  })

  it('keeps new and previously saved default descriptions free of the retired scratch claim', () => {
    for (const material of ['304', '316L', 'Brass']) {
      expect(buildDescriptionHtml(material, null)).not.toMatch(/scratch/i)
    }
    const legacy = 'Custom detail\nAdvanced PVD Coating, not standard plating – long-lasting colour, anti-tarnish & scratch resistance\nRemove before bathing'
    expect(buildDescriptionHtml('316L', legacy)).toBe(
      `<ul><li>Custom detail</li><li>Advanced PVD Coating, not standard plating – long-lasting colour &amp; anti-tarnish</li><li>${magnetBullet('316L')}</li><li>Remove before bathing</li></ul>`,
    )
    expect(resolveDescriptionText('304', 'Not scratch-resistant. Handle with care.')).toBe(
      `Not scratch-resistant. Handle with care.\n• ${magnetBullet('304')}`,
    )
  })

  it('escapes override text and never passes operator HTML through', () => {
    expect(buildDescriptionHtml('Brass', '<script>alert("x")</script>\nSafe & bright')).toBe(
      `<ul><li>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</li><li>${magnetBullet('Brass')}</li><li>Safe &amp; bright</li></ul>`,
    )
  })

  it('puts the magnet line second-last, and only for known materials', () => {
    for (const material of ['304', '316L']) {
      const lines = defaultDescriptionText(material).split('\n')
      expect(lines).toHaveLength(7)
      expect(lines[5]).toBe(
        `• May or may not attract a magnet – normal for ${material} stainless steel after shaping and polishing. Magnet pull does not mean lower grade jewellery: it is the same quality, anti-tarnish and rust-resistant`,
      )
    }
    expect(defaultDescriptionText('Brass').split('\n')[5]).toBe(
      '• Brass is non-magnetic – only a steel clasp, post or spring may attract a magnet; the brass body and its finish are unaffected',
    )
    expect(magnetBullet('Sterling Silver')).toBeNull()
    expect(defaultDescriptionText('Sterling Silver')).not.toMatch(/magnet/i)
    // An override that already answers the magnet question is left alone.
    expect(resolveDescriptionText('316L', 'Attracts a magnet slightly; still 316L.')).toBe(
      'Attracts a magnet slightly; still 316L.',
    )
    expect(resolveDescriptionText(null, 'No material yet')).toBe('No material yet')
  })
})
