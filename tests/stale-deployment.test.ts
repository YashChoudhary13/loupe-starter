import { describe, expect, it } from 'vitest'
import { STALE_DEPLOYMENT_MESSAGE, isStaleDeploymentError } from '@/lib/live/stale-deployment'

describe('stale tab after a deploy', () => {
  it('recognises the exact Next.js message an old tab receives and nothing else', () => {
    expect(isStaleDeploymentError(new Error('Server Action "40d0c4531d2fee3dd4297ed95f6866e485c36f88b5" was not found on the server. Read more: https://nextjs.org/docs/messages/failed-to-find-server-action'))).toBe(true)
    expect(isStaleDeploymentError('failed-to-find-server-action')).toBe(true)
    expect(isStaleDeploymentError(new Error('Shopify lookup failed'))).toBe(false)
    expect(isStaleDeploymentError(undefined)).toBe(false)
    expect(STALE_DEPLOYMENT_MESSAGE).toMatch(/Reload/)
  })
})
