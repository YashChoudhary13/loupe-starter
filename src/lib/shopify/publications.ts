/**
 * Sales-channel publication — making a published product visible on Online
 * Store, Point of Sale, Google & YouTube and every other installed channel.
 *
 * WHY THIS IS A SEPARATE CALL
 *
 * `ProductSetInput` has no publications field. Introspected against the live
 * store on API 2026-07:
 *
 *   descriptionHtml handle seo productType tags templateSuffix
 *   giftCardTemplateSuffix title vendor category giftCard redirectNewHandle
 *   status collections metafields files productOptions variants
 *   requiresSellingPlan claimOwnership combinedListingRole
 *
 * So a product created by `productSet` lands on **no** channel, and every
 * product had to be opened in Shopify admin and ticked into Sales Channels by
 * hand. `publishablePublish(id, [PublicationInput!])` is the only way to do it
 * through the API, and it runs after the product exists.
 *
 * WHICH CHANNELS
 *
 * Every publication whose catalog is an **APP** catalog and whose status is
 * ACTIVE. `catalogType: APP` is what "sales channel" means in the Admin API;
 * MARKET and COMPANY_LOCATION catalogs are the Markets and B2B mechanisms and
 * publishing to them is a different decision with different consequences, so
 * they are deliberately not included.
 *
 * There is no allowlist of channel names. A channel Qimati installs later is a
 * channel they want their products on — an allowlist would silently omit it and
 * reintroduce exactly the manual step this module removes.
 *
 * IDEMPOTENCY
 *
 * `publishablePublish` is a no-op for a publication the resource already has, so
 * a retry, a redo, or a Save Draft followed by a Publish all converge on the
 * same state. That is what lets the caller treat a failure here as fatal and
 * lean on the existing handle-keyed retry rather than inventing a repair path.
 */
import type { ShopifyClient } from './client'
import { ShopifyError } from './errors'

export interface SalesChannel {
  readonly id: string
  /** The channel's app title — "Online Store", "Point of Sale". For humans. */
  readonly name: string
}

/**
 * `Publication.name` exists but is deprecated, so the app title is read from the
 * catalog instead. `first: 100` is far above any real store; `hasNextPage` is
 * still checked rather than assumed, because a silent truncation here means a
 * channel quietly stops receiving products.
 */
const SALES_CHANNELS_QUERY = /* GraphQL */ `
  query LoupeSalesChannels {
    publications(first: 100, catalogType: APP) {
      pageInfo {
        hasNextPage
      }
      nodes {
        id
        catalog {
          ... on AppCatalog {
            status
            apps(first: 1) {
              nodes {
                title
              }
            }
          }
        }
      }
    }
  }
`

interface SalesChannelsResponse {
  publications: {
    pageInfo: { hasNextPage: boolean }
    nodes: readonly {
      id: string
      catalog: {
        status?: string | null
        apps?: { nodes: readonly { title: string | null }[] } | null
      } | null
    }[]
  } | null
}

const PUBLISHABLE_PUBLISH_MUTATION = /* GraphQL */ `
  mutation LoupePublishablePublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors {
        field
        message
      }
    }
  }
`

interface PublishablePublishResponse {
  publishablePublish: {
    userErrors: readonly { field?: readonly string[] | null; message: string }[]
  } | null
}

/**
 * Cached per client for the same reason `primaryLocationId` is: a 20-way
 * parallel publish should ask once, not twenty times. A `ShopifyClient` is built
 * per server action, so installing a new channel takes effect on the very next
 * publish without a deploy or a cache bust.
 */
const channelCache = new WeakMap<ShopifyClient, Promise<readonly SalesChannel[]>>()

export function salesChannels(client: ShopifyClient): Promise<readonly SalesChannel[]> {
  let pending = channelCache.get(client)
  if (!pending) {
    pending = client.graphql<SalesChannelsResponse>(SALES_CHANNELS_QUERY).then((data) => {
      const page = data.publications
      if (!page) {
        throw new ShopifyError('The publications query returned no payload.', {
          kind: 'malformed',
          retryable: false,
          detail: data,
        })
      }
      if (page.pageInfo.hasNextPage) {
        throw new ShopifyError(
          'The store has more than 100 sales channels, so this query is truncating the list.',
          {
            kind: 'graphql',
            retryable: false,
            hint: 'Paginate SALES_CHANNELS_QUERY. Publishing to a truncated list would silently miss channels.',
          },
        )
      }

      return page.nodes
        // ARCHIVED and DRAFT app catalogs are channels that are not selling.
        .filter((node) => node.catalog?.status === 'ACTIVE')
        .map((node) => ({
          id: node.id,
          name: node.catalog?.apps?.nodes?.[0]?.title?.trim() || node.id,
        }))
    })
    channelCache.set(client, pending)
  }
  return pending
}

/**
 * Publishes one product to every active sales channel.
 *
 * Returns the channels it published to, so the caller can record them — "we
 * published to four channels" in an events row is the difference between
 * knowing this worked and believing it did.
 *
 * A store with no active sales channel is not an error. It is a store nobody has
 * finished setting up, and failing the publish over it would block a product for
 * a reason the operator cannot act on from the console.
 */
export async function publishToSalesChannels(
  client: ShopifyClient,
  productId: string,
): Promise<readonly SalesChannel[]> {
  const channels = await salesChannels(client)
  if (channels.length === 0) return []

  const data = await client.graphql<PublishablePublishResponse>(PUBLISHABLE_PUBLISH_MUTATION, {
    id: productId,
    input: channels.map((channel) => ({ publicationId: channel.id })),
  })

  const result = data.publishablePublish
  if (!result) {
    throw new ShopifyError('publishablePublish returned no payload.', {
      kind: 'malformed',
      retryable: false,
      detail: data,
    })
  }
  if (result.userErrors.length > 0) {
    throw new ShopifyError(
      `Shopify refused to publish ${productId} to its sales channels: ` +
        result.userErrors
          .map((e) => `${(e.field ?? []).join('.') || '(no field)'}: ${e.message}`)
          .join('; '),
      {
        kind: 'user_error',
        retryable: false,
        detail: result.userErrors,
        hint: 'The app needs write_publications. Confirm it in the Shopify app configuration, then retry the draft.',
      },
    )
  }

  return channels
}
