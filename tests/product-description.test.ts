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
    expect(materialDescriptor('316L')).toBe('316L Stainless Steel (Surgical Grade)')
    expect(defaultDescriptionText('316L').split('\n')).toHaveLength(6)
  })

  it('uses a one-off custom material in the standard description', () => {
    expect(defaultDescriptionText('  Sterling   Silver  ')).toContain(
      'Made with premium Sterling Silver',
    )
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
