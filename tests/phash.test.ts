import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import {
  DUPLICATE_DISTANCE_THRESHOLD,
  perceptualHash,
  perceptualHashDistance,
} from '@/lib/duplicates/phash'

async function patternedImage(invert = false): Promise<Buffer> {
  const width = 192
  const height = 128
  const channels = 3
  const pixels = Buffer.alloc(width * height * channels)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const foreground = x > 34 && x < 158 && Math.abs(y - 64) < 22 + Math.sin(x / 9) * 8
      const value = (foreground !== invert) ? 35 : 225
      const offset = (y * width + x) * channels
      pixels[offset] = value
      pixels[offset + 1] = Math.min(255, value + (x % 23))
      pixels[offset + 2] = Math.max(0, value - (y % 19))
    }
  }
  return sharp(pixels, { raw: { width, height, channels } }).png().toBuffer()
}

describe('perceptual source hash', () => {
  it('is a deterministic 64-bit lowercase hex value', async () => {
    const input = await patternedImage()
    const first = await perceptualHash(input)
    const second = await perceptualHash(input)

    expect(first).toMatch(/^[0-9a-f]{16}$/)
    expect(second).toBe(first)
    expect(perceptualHashDistance(first, second)).toBe(0)
  })

  it('recognises a resized and JPEG-compressed copy as a warning candidate', async () => {
    const original = await patternedImage()
    const recompressed = await sharp(original)
      .resize(768, 512)
      .jpeg({ quality: 72 })
      .toBuffer()

    const distance = perceptualHashDistance(
      await perceptualHash(original),
      await perceptualHash(recompressed),
    )
    expect(distance).toBeLessThanOrEqual(DUPLICATE_DISTANCE_THRESHOLD)
  })

  it('does not confuse a structurally inverted photograph at the warning threshold', async () => {
    const distance = perceptualHashDistance(
      await perceptualHash(await patternedImage()),
      await perceptualHash(await patternedImage(true)),
    )
    expect(distance).toBeGreaterThan(DUPLICATE_DISTANCE_THRESHOLD)
  })

  it('refuses malformed hash strings', () => {
    expect(() => perceptualHashDistance('abc', '0'.repeat(16))).toThrow(
      '16-character hexadecimal',
    )
  })
})
