import { describe, expect, it } from 'vitest'

import { isPhoto, photoSignature, pickPhotos } from '@/lib/agent-jobs/photos'

const file = (name: string, type = 'image/jpeg', size = 100, lastModified = 1) => ({ name, type, size, lastModified })

describe('pickPhotos', () => {
  it('keeps photos, counts files that are not photos', () => {
    const picked = pickPhotos([file('a.jpg'), file('notes.pdf', 'application/pdf'), file('b.png', 'image/png')], new Set())
    expect(picked.fresh.map((f) => f.name)).toEqual(['a.jpg', 'b.png'])
    expect(picked).toMatchObject({ skipped: 1, repeats: 0 })
  })

  it('does not add a photo the batch already holds, nor the same photo twice in one pick', () => {
    const known = new Set([photoSignature(file('a.jpg'))])
    const picked = pickPhotos([file('a.jpg'), file('b.jpg'), file('b.jpg')], known)
    expect(picked.fresh.map((f) => f.name)).toEqual(['b.jpg'])
    expect(picked.repeats).toBe(2)
  })

  it('treats a phone photo with no reported type as a photo by its extension', () => {
    expect(isPhoto(file('IMG_0001.HEIC', ''))).toBe(true)
    expect(isPhoto(file('IMG_0001', ''))).toBe(false)
  })

  it('tells two different shots of the same name apart', () => {
    expect(photoSignature(file('a.jpg', 'image/jpeg', 100, 1))).not.toBe(photoSignature(file('a.jpg', 'image/jpeg', 101, 1)))
  })
})
