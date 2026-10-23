import { describe, expect, it } from 'vitest'

import {
  colourPaletteNames,
  colourSwatchBackground,
  colourSwatchHex,
  JEWELLERY_COLOUR_PALETTE,
} from '@/lib/console/colour-swatch'

describe('console colour swatches', () => {
  it('renders jewellery metals as distinct visual swatches', () => {
    expect(colourSwatchBackground('Gold')).toContain('#d4af37')
    expect(colourSwatchBackground('Silver')).toContain('#c8cbd0')
    expect(colourSwatchBackground('Rose Gold')).toContain('#b76e79')
  })

  it('understands normalised aliases and descriptive modifiers', () => {
    expect(colourSwatchBackground('gold-tone')).toBe(colourSwatchBackground('Gold'))
    expect(colourSwatchBackground('Light Rose Gold')).toBe(
      colourSwatchBackground('Rose Gold'),
    )
  })

  it('renders a two-colour remembered name as a split swatch', () => {
    const swatch = colourSwatchBackground('Red / White')
    expect(swatch).toContain('conic-gradient')
    expect(swatch).toContain('#c9363e')
    expect(swatch).toContain('#f7f7f5')
  })

  it('covers every Shopify taxonomy colour with its own swatch', () => {
    for (const name of ['Beige', 'Brown', 'Bronze', 'Grey', 'Navy', 'Orange', 'Clear']) {
      expect(colourSwatchHex(name)).toMatch(/^#[0-9a-f]{6}$/)
    }
    expect(colourSwatchBackground('Grey')).not.toBe(colourSwatchBackground('Silver'))
    expect(colourSwatchBackground('gray')).toBe(colourSwatchBackground('Grey'))
    expect(colourSwatchBackground('Light Brown')).toBe(colourSwatchBackground('Brown'))
  })

  it('only exports honest solids for Shopify saved-colour entries', () => {
    expect(colourSwatchHex('Gold')).toBe('#d4af37')
    expect(colourSwatchHex('Red / White')).toBeNull()
    expect(colourSwatchHex('Multi Colour')).toBeNull()
  })

  it('puts category-ranked colours before the stable palette without duplicates', () => {
    const names = colourPaletteNames([{ name: 'Green' }, { name: 'Gold' }])
    expect(names.slice(0, 2)).toEqual(['Green', 'Gold'])
    expect(names.filter((name) => name === 'Gold')).toHaveLength(1)
    expect(names).toHaveLength(JEWELLERY_COLOUR_PALETTE.length)
  })
})
