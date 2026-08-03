import { colourSwatchHex } from '@/lib/console/colour-swatch'

import type { ShopifyClient } from './client'
import { ShopifyError } from './errors'

export const SHOPIFY_COLOUR_METAFIELD = {
  namespace: 'shopify',
  key: 'color-pattern',
} as const

export const SHOPIFY_COLOUR_METAOBJECT_TYPE = 'shopify--color-pattern'

/** Shopify Standard Product Taxonomy · Color values (2026-08 taxonomy). */
const TAXONOMY_COLOUR_IDS = new Map<string, string>([
  ['black', 'gid://shopify/TaxonomyValue/1'],
  ['blue', 'gid://shopify/TaxonomyValue/2'],
  ['white', 'gid://shopify/TaxonomyValue/3'],
  ['gold', 'gid://shopify/TaxonomyValue/4'],
  ['silver', 'gid://shopify/TaxonomyValue/5'],
  ['green', 'gid://shopify/TaxonomyValue/9'],
  ['pink', 'gid://shopify/TaxonomyValue/11'],
  ['purple', 'gid://shopify/TaxonomyValue/12'],
  ['red', 'gid://shopify/TaxonomyValue/13'],
  ['yellow', 'gid://shopify/TaxonomyValue/14'],
  ['rose gold', 'gid://shopify/TaxonomyValue/16'],
  ['multicolor', 'gid://shopify/TaxonomyValue/2865'],
  ['multi colour', 'gid://shopify/TaxonomyValue/2865'],
])

const SOLID_PATTERN_ID = 'gid://shopify/TaxonomyValue/2874'

export interface ShopifySavedColour {
  readonly name: string
  readonly metaobjectId: string
}

interface SavedColourNode {
  readonly id: string
  readonly handle: string
  readonly displayName: string
  readonly fields: readonly { key: string; value: string | null }[]
}

const SAVED_COLOURS_QUERY = /* GraphQL */ `
  query LoupeSavedColours {
    metaobjects(type: "shopify--color-pattern", first: 250) {
      nodes {
        id
        handle
        displayName
        fields {
          key
          value
        }
      }
    }
  }
`

const UPSERT_SAVED_COLOUR = /* GraphQL */ `
  mutation LoupeUpsertSavedColour(
    $handle: MetaobjectHandleInput!
    $metaobject: MetaobjectUpsertInput!
  ) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject {
        id
        handle
        displayName
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`

function normalise(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function comparable(value: string): string {
  return normalise(value).replace(/[^a-z0-9]+/g, '')
}

function handleise(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function labelOf(node: SavedColourNode): string {
  return node.fields.find((field) => field.key === 'label')?.value ?? node.displayName
}

interface UpsertSavedColourResult {
  readonly metaobjectUpsert: {
    readonly metaobject: { id: string; handle: string; displayName: string } | null
    readonly userErrors: readonly {
      readonly field?: readonly string[] | null
      readonly message: string
      readonly code?: string | null
    }[]
  } | null
}

function definitionIsMissing(result: UpsertSavedColourResult['metaobjectUpsert']): boolean {
  return Boolean(
    result?.userErrors.some((error) =>
      error.message.toLowerCase().includes('no metaobject definition exists'),
    ),
  )
}

/**
 * Resolves Loupe's selected names to Shopify's native Color default entries.
 * Shopify materialises a default entry as a `shopify--color-pattern` metaobject
 * when a merchant first selects one in Admin. Existing entries always win,
 * including their custom swatch image or hex. Once the native definition is
 * active, a missing simple palette colour is created idempotently with the same
 * taxonomy references; richer split or custom values must be created in Shopify
 * first so Loupe never invents them.
 */
export async function syncShopifySavedColours(
  client: ShopifyClient,
  names: readonly string[],
): Promise<readonly ShopifySavedColour[]> {
  let nodes: readonly SavedColourNode[]
  try {
    const data = await client.graphql<{
      metaobjects: { nodes: readonly SavedColourNode[] }
    }>(SAVED_COLOURS_QUERY)
    nodes = data.metaobjects?.nodes ?? []
  } catch (cause) {
    throw new ShopifyError(
      'Loupe could not read Shopify’s saved colours.',
      {
        kind: 'graphql',
        retryable: false,
        detail: cause,
        hint:
          'Give the Shopify custom app read_metaobjects and write_metaobjects access, then try again.',
      },
    )
  }

  const existing = new Map<string, SavedColourNode>()
  for (const node of nodes) {
    existing.set(comparable(node.displayName), node)
    existing.set(comparable(labelOf(node)), node)
  }

  const resolved: ShopifySavedColour[] = []
  for (const name of names) {
    const key = comparable(name)
    const found = existing.get(key)
    if (found) {
      resolved.push({ name, metaobjectId: found.id })
      continue
    }

    const normalisedName = normalise(name)
    const taxonomyId = TAXONOMY_COLOUR_IDS.get(normalisedName)
    const hex = colourSwatchHex(name)
    if (!taxonomyId || !hex) {
      throw new ShopifyError(
        `Shopify has no saved colour named “${name}”.`,
        {
          kind: 'user_error',
          retryable: false,
          hint:
            `Create “${name}” under Shopify’s Color category metafield, including its swatch, then retry. ` +
            'Loupe will not guess a solid colour for a custom or multi-colour pattern.',
        },
      )
    }

    const variables = {
      handle: {
        type: SHOPIFY_COLOUR_METAOBJECT_TYPE,
        handle: `loupe-${handleise(name)}`,
      },
      metaobject: {
        fields: [
          { key: 'label', value: name },
          { key: 'color', value: hex },
          { key: 'color_taxonomy_reference', value: JSON.stringify([taxonomyId]) },
          { key: 'pattern_taxonomy_reference', value: SOLID_PATTERN_ID },
        ],
      },
    }

    const response = await client.graphql<UpsertSavedColourResult>(
      UPSERT_SAVED_COLOUR,
      variables,
    )

    const result = response.metaobjectUpsert
    if (definitionIsMissing(result)) {
      throw new ShopifyError(
        'Shopify’s built-in Color entries are not active for this store yet.',
        {
          kind: 'user_error',
          retryable: false,
          detail: result?.userErrors ?? [],
          hint:
            'One-time Shopify setup: open any categorized draft product, add the Color option, ' +
            'select one value under Default entries, and save. Then save this Loupe draft again.',
        },
      )
    }

    if (!result || result.userErrors.length > 0 || !result.metaobject?.id) {
      const detail = result?.userErrors ?? []
      throw new ShopifyError(
        `Shopify could not save the colour “${name}”.`,
        {
          kind: 'user_error',
          retryable: false,
          detail,
          hint:
            detail.length > 0
              ? detail.map((error) => error.message).join('; ')
              : 'Confirm the app has write_metaobjects access and retry.',
        },
      )
    }

    const created: SavedColourNode = {
      id: result.metaobject.id,
      handle: result.metaobject.handle,
      displayName: result.metaobject.displayName,
      fields: [{ key: 'label', value: name }],
    }
    existing.set(key, created)
    resolved.push({ name, metaobjectId: created.id })
  }

  return resolved
}
