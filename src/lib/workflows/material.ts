import 'server-only'

import { ShopifyClient } from '@/lib/shopify/client'
import { MATERIAL_METAFIELD } from '@/lib/shopify/product-set'
import { supabaseServer } from '@/lib/supabase/server'

import { readCatalogue, stripHtml } from './catalogue'
import {
  describeChange,
  planMaterialFixes,
  type MaterialChange,
  type MaterialPlan,
  type MaterialProductInput,
} from './material-plan'
import type { StepContext, WorkflowProgram } from './runner'

/**
 * D122 — "Material consistency": the 4 Sep 2026 audit script as a one-click
 * Loupe workflow. Reads the whole store, makes tag, metafield and SEO follow
 * the description, writes, then reads back to prove it.
 */

const PRODUCT_UPDATE = /* GraphQL */ `
  mutation LoupeWorkflowProductUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id }
      userErrors { field message }
    }
  }
`

const METAFIELD_SET = /* GraphQL */ `
  mutation LoupeWorkflowMaterialSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`

const VERIFY = /* GraphQL */ `
  query LoupeWorkflowMaterialVerify($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id tags
        seo { title description }
        metafield(namespace: "custom", key: "material") { value }
      }
    }
  }
`

interface UserError {
  field: readonly string[] | null
  message: string
}

interface VerifyNode {
  id: string
  tags: readonly string[]
  seo: { title: string | null; description: string | null } | null
  metafield: { value: string | null } | null
}

async function prefixByCategoryTag(): Promise<Map<string, string>> {
  const { data, error } = await supabaseServer()
    .from('categories')
    .select('shopify_tag, sku_prefix')
  if (error) throw new Error(`Could not read categories: ${error.message}`)
  const map = new Map<string, string>()
  for (const row of (data ?? []) as { shopify_tag: string | null; sku_prefix: string }[]) {
    if (row.shopify_tag) map.set(row.shopify_tag.trim().toLowerCase(), row.sku_prefix)
  }
  return map
}

async function writeChange(client: ShopifyClient, change: MaterialChange): Promise<string[]> {
  const errors: string[] = []
  const product: Record<string, unknown> = { id: change.id }
  if (change.tags) product.tags = change.tags.after
  // Title and description always together — SEOInput replaces the whole object.
  if (change.seo) product.seo = change.seo.after
  if (Object.keys(product).length > 1) {
    const response = await client.graphql<{ productUpdate: { userErrors: readonly UserError[] } }>(
      PRODUCT_UPDATE,
      { product },
    )
    errors.push(...response.productUpdate.userErrors.map((error) => error.message))
  }
  if (change.metafield) {
    const response = await client.graphql<{ metafieldsSet: { userErrors: readonly UserError[] } }>(
      METAFIELD_SET,
      { metafields: [{ ownerId: change.id, ...MATERIAL_METAFIELD, value: change.metafield.after }] },
    )
    errors.push(...response.metafieldsSet.userErrors.map((error) => error.message))
  }
  return errors
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left)
  return a.size === new Set(right).size && right.every((item) => a.has(item))
}

async function verifyChanges(
  client: ShopifyClient,
  changes: readonly MaterialChange[],
): Promise<string[]> {
  const mismatched: string[] = []
  for (let offset = 0; offset < changes.length; offset += 50) {
    const chunk = changes.slice(offset, offset + 50)
    const { nodes } = await client.graphql<{ nodes: readonly (VerifyNode | null)[] }>(VERIFY, {
      ids: chunk.map((change) => change.id),
    })
    const byId = new Map(nodes.filter((node): node is VerifyNode => node !== null).map((node) => [node.id, node]))
    for (const change of chunk) {
      const node = byId.get(change.id)
      let ok = node !== undefined
      if (ok && change.tags) ok = sameSet(node!.tags, change.tags.after)
      if (ok && change.metafield) ok = (node!.metafield?.value ?? '') === change.metafield.after
      if (ok && change.seo) {
        ok =
          node!.seo?.title === change.seo.after.title &&
          node!.seo?.description === change.seo.after.description
      }
      if (!ok) mismatched.push(change.handle)
    }
  }
  return mismatched
}

export function materialProgram(): WorkflowProgram {
  const client = new ShopifyClient()
  let products: MaterialProductInput[] = []
  let plan: MaterialPlan | null = null

  return {
    steps: [
      {
        key: 'pull',
        label: 'Pull the catalogue',
        async run(context: StepContext) {
          const catalogue = await readCatalogue(client, (count) =>
            context.report(`${count.toLocaleString('en-IN')} products so far`),
          )
          products = catalogue.map((product) => ({
            ...product,
            bodyText: stripHtml(product.descriptionHtml),
          }))
          const active = products.filter((product) => product.status === 'ACTIVE').length
          return `${catalogue.length.toLocaleString('en-IN')} products, ${active.toLocaleString('en-IN')} active`
        },
      },
      {
        key: 'plan',
        label: 'Compare description with tag, metafield and SEO',
        async run(context: StepContext) {
          plan = planMaterialFixes(products, await prefixByCategoryTag())
          if (plan.changes.length > 0) {
            context.section('Fixes', plan.changes.map(describeChange))
          }
          if (plan.needsHuman.length > 0) {
            context.section(
              'Needs a human — description names no material or two',
              plan.needsHuman.map((finding) => `${finding.handle}: ${finding.issue}`),
            )
          }
          for (const finding of plan.findings) context.log(`${finding.handle}: ${finding.issue}`)
          if (plan.findings.length === 0) {
            context.summary(`All ${plan.active.toLocaleString('en-IN')} active products are consistent.`)
            return 'Everything consistent'
          }
          const human = plan.needsHuman.length
          return {
            detail: `${plan.findings.length} inconsistent · ${plan.changes.length} fixable now${human > 0 ? ` · ${human} need a human` : ''}`,
            warning: human > 0,
          }
        },
      },
      {
        key: 'write',
        label: 'Write the fixes',
        async run(context: StepContext) {
          if (!plan || plan.changes.length === 0) return 'Nothing to write'
          let written = 0
          const failed: string[] = []
          for (const [index, change] of plan.changes.entries()) {
            await context.report(`${index + 1} of ${plan.changes.length}`)
            const errors = await writeChange(client, change)
            if (errors.length > 0) {
              failed.push(change.handle)
              context.log(`${change.handle}: Shopify refused — ${errors.join('; ')}`)
            } else {
              written += 1
            }
          }
          if (failed.length > 0) context.section('Shopify refused', failed)
          return {
            detail: `${written} of ${plan.changes.length} written${failed.length > 0 ? `, ${failed.length} refused` : ''}`,
            warning: failed.length > 0,
          }
        },
      },
      {
        key: 'verify',
        label: 'Read back and verify',
        async run(context: StepContext) {
          if (!plan || plan.changes.length === 0) return 'Nothing to verify'
          const mismatched = await verifyChanges(client, plan.changes)
          const fixed = plan.changes.length - mismatched.length
          const human = plan.needsHuman.length
          context.summary(
            `${fixed} product${fixed === 1 ? '' : 's'} fixed` +
              (mismatched.length > 0 ? `, ${mismatched.length} did not stick` : '') +
              (human > 0 ? `, ${human} need a human` : '') +
              '.',
          )
          if (mismatched.length > 0) {
            context.section('Did not match after writing — run again', mismatched)
            return { detail: `${fixed} of ${plan.changes.length} match; ${mismatched.length} do not`, warning: true }
          }
          return `${fixed} of ${plan.changes.length} match the intended state`
        },
      },
    ],
  }
}
