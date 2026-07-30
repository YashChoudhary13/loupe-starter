import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { EnhancementError } from '@/lib/enhance/errors'
import {
  normaliseGeneratedImage,
  readImageDimensions,
} from '@/lib/enhance/image'

describe('generated image normalisation', () => {
  it('normalises a square provider result to Loupe’s configured PNG size', async () => {
    const providerImage = await sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 3,
        background: '#eee6d6',
      },
    })
      .jpeg()
      .toBuffer()

    const result = await normaliseGeneratedImage(providerImage, {
      width: 1280,
      height: 1280,
    })
    expect(await readImageDimensions(result)).toEqual({ width: 1280, height: 1280 })
    expect((await sharp(result).metadata()).format).toBe('png')
  })

  it('refuses to stretch a provider result with the wrong aspect ratio', async () => {
    const providerImage = await sharp({
      create: {
        width: 1024,
        height: 768,
        channels: 3,
        background: '#eee6d6',
      },
    })
      .png()
      .toBuffer()

    await expect(
      normaliseGeneratedImage(providerImage, { width: 1280, height: 1280 }),
    ).rejects.toMatchObject({
      code: 'image_aspect_ratio_not_honoured',
      retryable: false,
    } satisfies Partial<EnhancementError>)
  })
})
