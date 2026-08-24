/**
 * Add an AI-styled "worn on foot" image to the top-selling anklet listings.
 *
 *   npm run anklet:worn                      # dry run: lists what would be done
 *   npm run anklet:worn -- --apply           # enhance + upload for real
 *   npm run anklet:worn -- --apply --limit 5 # first 5 only (do this first)
 *   npm run anklet:worn -- --sku AK087       # single product, dry run
 *
 * "Top" = Shopify's BEST_SELLING sort inside the anklets collection
 * (--collection <handle> to override, default "anklets"). For each product the
 * FIRST product image is run through the `anklet-worn` matrix core (D116) with
 * the --setting scene (default "sunlit-stone") and the result is APPENDED to
 * the product's media with alt "Worn view (AI-styled)". Products that already
 * have a media whose alt starts with "Worn view" are skipped, so re-running is
 * safe. Nothing is deleted and the existing images are untouched.
 *
 * ponytail: sequential, one product at a time — 50 images is minutes, not hours,
 * and OpenRouter rate limits bite fans. Parallelise only if this becomes daily.
 */
import { readFileSync } from 'node:fs'

import { config } from 'dotenv'

config({ path: '.env', quiet: true })
config({ path: '.env.local', override: true, quiet: true })

import { OpenRouterClient } from '../src/lib/enhance/openrouter'
import { resolveImagePrompt } from '../src/lib/enhance/prompt'
import { composeClientPair } from '../src/lib/prompts/matrix'
import { ShopifyClient } from '../src/lib/shopify/client'

const WORN_ALT = 'Worn view (AI-styled)'
/**
 * Cheap by default: the sources are already-enhanced hero images, not raw
 * photos, so a light edit model holds identity fine. ~$0.005/image vs ~$0.19
 * for gpt-image-2 high (measured from OpenRouter pricing 2026-08-24).
 * Override with --model openai/gpt-image-2 if a piece needs the heavy model.
 */
const DEFAULT_IMAGE_MODEL = 'google/gemini-3.1-flash-image'

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1]! : fallback
}
const apply = process.argv.includes('--apply')
/** With --replace, an existing "Worn view" media is DELETED and regenerated instead of skipped. */
const replace = process.argv.includes('--replace')
const limit = Number(arg('limit', '50'))
const collectionHandle = arg('collection', 'anklets')
const settingSlug = arg('setting', 'sunlit-stone')
const onlySku = arg('sku', '')
const imageModel = arg('model', DEFAULT_IMAGE_MODEL)
const descriptionsPath = arg('descriptions', '')
/** --from AK084 --to AK131: SKU number range instead of best-selling top N. */
const fromSku = arg('from', '')
const toSku = arg('to', '')
/** Target total images per product; a product already at or above this is skipped. 0 = no cap. */
const maxMedia = Number(arg('max-media', '0'))

function skuNumber(sku: string | null): number | null {
  const match = /^AK(\d+)$/u.exec(sku ?? '')
  return match ? Number(match[1]) : null
}

interface ProductNode {
  id: string
  title: string
  featuredImage: { url: string } | null
  variants: { nodes: { sku: string | null }[] }
  media: { nodes: { id: string; alt: string | null }[] }
}

async function ankletsBySkuRange(shopify: ShopifyClient): Promise<ProductNode[]> {
  const low = skuNumber(fromSku)
  const high = skuNumber(toSku)
  if (low === null || high === null) throw new Error('--from/--to must look like AK084')
  const data = await shopify.graphql<{
    products: { nodes: ProductNode[] }
  }>(
    `query {
      products(first: 250, query: "tag:anklets status:active") {
        nodes {
          id
          title
          featuredImage { url }
          variants(first: 1) { nodes { sku } }
          media(first: 50) { nodes { id alt } }
        }
      }
    }`,
  )
  const inRange = data.products.nodes
    .filter((product) => {
      const number = skuNumber(product.variants.nodes[0]?.sku ?? null)
      return number !== null && number >= low && number <= high
    })
    .sort(
      (a, b) =>
        (skuNumber(a.variants.nodes[0]?.sku ?? null) ?? 0) -
        (skuNumber(b.variants.nodes[0]?.sku ?? null) ?? 0),
    )
  console.log(`${inRange.length} active anklet(s) in ${fromSku}–${toSku}.`)
  return inRange
}

async function topAnklets(shopify: ShopifyClient): Promise<ProductNode[]> {
  const data = await shopify.graphql<{
    collectionByHandle: {
      title: string
      products: { nodes: ProductNode[] }
    } | null
  }>(
    `query ($handle: String!, $first: Int!) {
      collectionByHandle(handle: $handle) {
        title
        products(first: $first, sortKey: BEST_SELLING) {
          nodes {
            id
            title
            featuredImage { url }
            variants(first: 1) { nodes { sku } }
            media(first: 50) { nodes { id alt } }
          }
        }
      }
    }`,
    { handle: collectionHandle, first: limit },
  )
  if (!data.collectionByHandle) {
    throw new Error(
      `No collection with handle "${collectionHandle}". Pass --collection <handle> (see Shopify admin URL of the anklets collection).`,
    )
  }
  console.log(`Collection "${data.collectionByHandle.title}", best-selling order.`)
  return data.collectionByHandle.products.nodes
}

/**
 * Descriptions come from a JSON file of { "AK103": "<80-200 word paragraph>" }
 * written by hand or by an assistant reading the hero images (no describer
 * model spend). With no file, or no entry for a SKU, the PRODUCT block is
 * stripped the same way the worker does when the describer is exhausted, and
 * SOURCE AUTHORITY carries identity alone.
 */
function loadDescriptions(): Record<string, string> {
  if (!descriptionsPath) return {}
  return JSON.parse(readFileSync(descriptionsPath, 'utf8')) as Record<string, string>
}

function wornPrompt(description: string | null): string {
  const pair = composeClientPair('anklet-worn', settingSlug)
  if (!pair) throw new Error(`Unknown combination: anklet-worn × ${settingSlug}`)
  return resolveImagePrompt(pair.imageBody, description, true, description === null, 'flat-arc', false).text
}

async function downloadSource(url: string): Promise<{ buffer: Buffer; mediaType: 'image/jpeg' | 'image/png' } | null> {
  const res = await fetch(url)
  if (!res.ok) return null
  const type = res.headers.get('content-type') ?? ''
  const mediaType = type.includes('png') ? 'image/png' : type.includes('jpeg') || type.includes('jpg') ? 'image/jpeg' : null
  if (!mediaType) return null
  return { buffer: Buffer.from(await res.arrayBuffer()), mediaType }
}

async function uploadToProduct(shopify: ShopifyClient, productId: string, image: Buffer): Promise<void> {
  const staged = await shopify.graphql<{
    stagedUploadsCreate: {
      stagedTargets: { url: string; resourceUrl: string; parameters: { name: string; value: string }[] }[]
      userErrors: { message: string }[]
    }
  }>(
    `mutation ($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { message }
      }
    }`,
    {
      input: [
        {
          resource: 'IMAGE',
          filename: 'worn-view.png',
          mimeType: 'image/png',
          httpMethod: 'POST',
          fileSize: String(image.length),
        },
      ],
    },
  )
  const errors = staged.stagedUploadsCreate.userErrors
  if (errors.length) throw new Error(`stagedUploadsCreate: ${errors[0]!.message}`)
  const target = staged.stagedUploadsCreate.stagedTargets[0]!

  const form = new FormData()
  for (const parameter of target.parameters) form.append(parameter.name, parameter.value)
  form.append('file', new Blob([new Uint8Array(image)], { type: 'image/png' }), 'worn-view.png')
  const post = await fetch(target.url, { method: 'POST', body: form })
  if (!post.ok) throw new Error(`staged upload POST ${post.status}`)

  const media = await shopify.graphql<{
    productCreateMedia: { media: { id: string }[]; mediaUserErrors: { message: string }[] }
  }>(
    `mutation ($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { id }
        mediaUserErrors { message }
      }
    }`,
    {
      productId,
      media: [{ originalSource: target.resourceUrl, alt: WORN_ALT, mediaContentType: 'IMAGE' }],
    },
  )
  const mediaErrors = media.productCreateMedia.mediaUserErrors
  if (mediaErrors.length) throw new Error(`productCreateMedia: ${mediaErrors[0]!.message}`)

  // The worn view is the listing's main image (owner decision 2026-08-24): move it to position 0.
  const created = media.productCreateMedia.media[0]
  if (created) {
    const reorder = await shopify.graphql<{
      productReorderMedia: { mediaUserErrors: { message: string }[] }
    }>(
      `mutation ($id: ID!, $moves: [MoveInput!]!) {
        productReorderMedia(id: $id, moves: $moves) { mediaUserErrors { message } }
      }`,
      { id: productId, moves: [{ id: created.id, newPosition: '0' }] },
    )
    const reorderErrors = reorder.productReorderMedia.mediaUserErrors
    if (reorderErrors.length) throw new Error(`productReorderMedia: ${reorderErrors[0]!.message}`)
  }
}

async function main(): Promise<void> {
  const openRouterKey = process.env.OPENROUTER_API_KEY
  if (!openRouterKey) throw new Error('OPENROUTER_API_KEY is not set')
  const shopify = new ShopifyClient()
  const enhancer = new OpenRouterClient(openRouterKey)
  const descriptions = loadDescriptions()

  let products = fromSku || toSku ? await ankletsBySkuRange(shopify) : await topAnklets(shopify)
  if (onlySku) {
    products = products.filter((product) => product.variants.nodes[0]?.sku === onlySku)
  }

  let done = 0
  let skipped = 0
  let failed = 0
  let costUsd = 0
  for (const product of products) {
    const sku = product.variants.nodes[0]?.sku ?? '?'
    const wornMedia = product.media.nodes.filter((node) => node.alt?.startsWith('Worn view'))
    if (wornMedia.length > 0 && !replace) {
      console.log(`skip  ${sku}  ${product.title} — already has a worn view`)
      skipped += 1
      continue
    }
    if (maxMedia > 0 && product.media.nodes.length - (replace ? wornMedia.length : 0) >= maxMedia) {
      console.log(`skip  ${sku}  ${product.title} — already has ${product.media.nodes.length} images`)
      skipped += 1
      continue
    }
    if (!product.featuredImage) {
      console.log(`skip  ${sku}  ${product.title} — no image`)
      skipped += 1
      continue
    }
    if (!apply) {
      const described = descriptions[sku] ? 'described' : 'no description'
      console.log(`would ${sku}  ${described}  ${product.featuredImage.url}`)
      done += 1
      continue
    }
    try {
      if (wornMedia.length > 0 && replace) {
        const deletion = await shopify.graphql<{
          productDeleteMedia: { mediaUserErrors: { message: string }[] }
        }>(
          `mutation ($productId: ID!, $mediaIds: [ID!]!) {
            productDeleteMedia(productId: $productId, mediaIds: $mediaIds) { mediaUserErrors { message } }
          }`,
          { productId: product.id, mediaIds: wornMedia.map((node) => node.id) },
        )
        const deleteErrors = deletion.productDeleteMedia.mediaUserErrors
        if (deleteErrors.length) throw new Error(`productDeleteMedia: ${deleteErrors[0]!.message}`)
        console.log(`redo  ${sku}  — removed ${wornMedia.length} old worn view(s)`)
      }
      const source = await downloadSource(product.featuredImage.url)
      if (!source) {
        console.log(`skip  ${sku}  — image not jpeg/png`)
        skipped += 1
        continue
      }
      const result = await enhancer.enhance(source.buffer, source.mediaType, wornPrompt(descriptions[sku] ?? null), {
        model: imageModel,
        size: (process.env.IMAGE_SIZE as `${number}x${number}`) || '1024x1024',
        quality: (process.env.IMAGE_QUALITY as 'low' | 'medium' | 'high') || 'high',
      })
      await uploadToProduct(shopify, product.id, result.image)
      costUsd += result.costUsd
      done += 1
      console.log(`done  ${sku}  ${product.title}  ($${result.costUsd.toFixed(3)})`)
    } catch (error) {
      failed += 1
      console.error(`FAIL  ${sku}  ${product.title}: ${error instanceof Error ? error.message : error}`)
    }
  }

  console.log(
    apply
      ? `\n${done} uploaded, ${skipped} skipped, ${failed} failed. Total image cost $${costUsd.toFixed(2)}.`
      : `\n${done} would be enhanced, ${skipped} skipped (dry run; pass --apply).`,
  )
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
