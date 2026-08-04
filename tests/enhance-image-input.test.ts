import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import {
  MODEL_INPUT_MAX_EDGE,
  prepareModelInput,
} from '@/lib/enhance/image'

describe('model input detail preservation', () => {
  it('keeps a normal 1200x1600 catalogue source at full resolution', async () => {
    const source = await sharp({
      create: {
        width: 1200,
        height: 1600,
        channels: 3,
        background: '#f5f1e8',
      },
    })
      .jpeg()
      .toBuffer()

    const prepared = await prepareModelInput(source)

    expect(prepared.originalWidth).toBe(1200)
    expect(prepared.originalHeight).toBe(1600)
    expect(prepared.width).toBe(1200)
    expect(prepared.height).toBe(1600)
  })

  it('still bounds unusually large sources without changing aspect ratio', async () => {
    const source = await sharp({
      create: {
        width: 3000,
        height: 2000,
        channels: 3,
        background: '#f5f1e8',
      },
    })
      .jpeg()
      .toBuffer()

    const prepared = await prepareModelInput(source)

    expect(prepared.width).toBe(MODEL_INPUT_MAX_EDGE)
    expect(prepared.height).toBe(1365)
  })
})
