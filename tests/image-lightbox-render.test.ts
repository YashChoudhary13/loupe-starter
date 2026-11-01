import { createElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ImageLightbox, type LightboxImage } from '@/components/console/ImageLightbox'

const render = (element: ReactElement) => renderToString(element).replace(/<!-- -->/g, '')

const image = (n: number): LightboxImage => ({
  url: `/api/images/v${n}?size=full`,
  previewUrl: `/api/images/v${n}?size=preview`,
  thumbUrl: `/api/images/v${n}?size=thumb`,
  alt: `Necklace ${n}`,
  caption: `IMG_${n}.jpg · v1`,
})
const noop = () => {}

describe('ImageLightbox (D165)', () => {
  it('renders nothing while closed', () => {
    expect(render(createElement(ImageLightbox, { images: [image(1)], index: null, onClose: noop, onIndexChange: noop }))).toBe('')
  })

  it('opens on the preview behind the blurred thumb, with the full file only behind a button', () => {
    const html = render(createElement(ImageLightbox, { images: [image(1), image(2)], index: 0, onClose: noop, onIndexChange: noop }))
    expect(html).toContain('src="/api/images/v1?size=preview"')
    expect(html).toContain('src="/api/images/v1?size=thumb"')
    expect(html).toContain('>Full size<')
    expect(html).not.toContain('src="/api/images/v1?size=full"')
    expect(html).toContain('1 of 2')
    expect(html).toContain('IMG_1.jpg · v1')
  })

  it('shows a presigned-only image directly and offers no Full size', () => {
    const legacy: LightboxImage = { url: 'https://r2.example/signed', thumbUrl: null, alt: 'phone photograph', caption: 'IMG_9.jpg · phone photograph' }
    const html = render(createElement(ImageLightbox, { images: [legacy], index: 0, onClose: noop, onIndexChange: noop }))
    expect(html).toContain('src="https://r2.example/signed"')
    expect(html).not.toContain('Full size<')
  })
})
