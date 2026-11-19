import 'server-only'

import { consoleObjectStore } from '@/lib/console/images'
import { serverEnv } from '@/lib/env'
import { makePreview } from '@/lib/images/preview'
import { loadPublishInput } from '@/lib/publish/publish-product'
import { ShopifyClient } from '@/lib/shopify/client'
import { shopifyConfig } from '@/lib/shopify/config'
import { supabaseServer } from '@/lib/supabase/server'

import {
  DESIGN_LABELS_METAFIELD, fingerprint, kindFor, labelPhotos, LABEL_MODEL, MAX_PHOTOS, metafieldValue, storedFingerprint,
  type ProductFacts,
} from './labeller'
import { perKeyQueue } from './queue'

/**
 * Design labels for a draft that has just reached Shopify (D177). Called after Save draft's background push and after
 * Publish; never part of either: it never throws, never touches the draft row, and a failure is an `events` row only.
 *
 *   1. read the product from Shopify: title, options and the current `qimati.design_labels`
 *   2. stop when that value was made for the same photos, category and vocabulary (the fingerprint)
 *   3. the first four photos in publish order from R2, one at a time, each cut to the 1280 px WebP preview
 *   4. Claude Opus labels them (the search project's prompt, ./labeller.ts)
 *   5. one `metafieldsSet` on the product. Never productSet (a re-push resends stock), never tags (they drive collections).
 *
 * `DESIGN_LABELS=off` turns it off.
 */
const ACTOR = 'design-tags'

const PRODUCT_QUERY = /* GraphQL */ `
  query DesignLabelsProduct($id: ID!, $namespace: String!, $key: String!) {
    product(id: $id) {
      title
      options { name values }
      metafield(namespace: $namespace, key: $key) { value }
    }
  }
`
const METAFIELDS_SET = /* GraphQL */ `
  mutation DesignLabelsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message code }
    }
  }
`

interface ProductRead { product: (ProductFacts & { metafield: { value: string } | null }) | null }
interface SetResult { metafieldsSet: { metafields: { id: string }[] | null; userErrors: { field?: string[] | null; message: string }[] } | null }

// Two at a time: each holds up to four previews and one Opus call; the server has 3.7 GB.
const queue = perKeyQueue(labelOnce, 2)

export function labelDraftDesign(draftId: string): Promise<void> {
  if (process.env.DESIGN_LABELS?.trim().toLowerCase() === 'off') return Promise.resolve()
  return queue(draftId).catch((cause) => console.error('design-tags:', cause instanceof Error ? cause.message : String(cause)))
}

async function labelOnce(draftId: string): Promise<void> {
  const db = supabaseServer()
  const record = (event: string, detail: Record<string, unknown>) =>
    db.from('events').insert({ entity_type: 'product_draft', entity_id: draftId, event, detail, actor: ACTOR })
      .then(({ error }) => { if (error) console.error(`design-tags: ${event} not recorded:`, error.message) })
  try {
    const input = await loadPublishInput(db, draftId)
    const productId = input.draft.shopify_product_id
    const images = input.images.slice(0, MAX_PHOTOS)
    if (!productId || images.length === 0) return  // nothing in Shopify yet, or nothing to look at

    const shopify = new ShopifyClient({ config: shopifyConfig() })
    const { product } = await shopify.graphql<ProductRead>(PRODUCT_QUERY, { id: productId, namespace: DESIGN_LABELS_METAFIELD.namespace, key: DESIGN_LABELS_METAFIELD.key })
    if (!product) throw new Error(`Shopify has no product ${productId}.`)
    const prefix = input.category.sku_prefix
    const print = fingerprint(images.map((image) => image.imageVersionId), prefix)
    if (storedFingerprint(product.metafield?.value) === print) return  // labelled already for these photos

    const store = consoleObjectStore()
    const photos: Buffer[] = []
    for (const image of images) photos.push(await makePreview(await store.get(image.storageKey)))
    const kind = kindFor(prefix, product.title)
    const options = product.options.filter((option) => option.name !== 'Title')  // Shopify's default option, as the search snapshot drops it
    const { labels, usage } = await labelPhotos({
      apiKey: serverEnv.homeClaudeApiKey, workspaceId: process.env.HOME_CLAUDE_WORKSPACE_ID?.trim() || undefined,
      photos, product: { title: product.title, options }, kind,
    })

    const value = metafieldValue(labels, kind, print, new Date())
    const set = await shopify.graphql<SetResult>(METAFIELDS_SET, { metafields: [{ ownerId: productId, ...DESIGN_LABELS_METAFIELD, value: JSON.stringify(value) }] })
    const errors = set.metafieldsSet?.userErrors ?? [{ message: 'No result was returned.' }]
    if (errors.length > 0 || !set.metafieldsSet?.metafields?.[0]?.id) {
      throw new Error(`Shopify did not save the design labels: ${errors.map((e) => e.message).join('; ') || 'no metafield returned'}`)
    }
    await record('draft.design_labelled', { model: LABEL_MODEL, kind, images: print, photos: photos.length, ...usage })
  } catch (cause) {
    const message = (cause instanceof Error ? cause.message : String(cause)).slice(0, 500)
    console.error(`design-tags: draft ${draftId} not labelled:`, message)
    await record('draft.design_label_failed', { message })
  }
}
