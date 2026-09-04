import 'server-only'

import { ShopifyClient } from '@/lib/shopify/client'

import { judgeMember, unsupportedRules, type MemberProduct, type RuleSet } from './collection-rules'
import type { StepContext, WorkflowProgram } from './runner'

/**
 * D122 — "Collection membership audit". Shopify's admin lets a person add a
 * product to an automated collection by hand ("manually included"); such a
 * product ignores the rules and stays when it sells out. There is no API to
 * list or remove those includes, so this reads every member of every
 * automated collection, judges it against the rules, and names the ones that
 * fail for the admin collection page.
 */

const COLLECTIONS = /* GraphQL */ `
  query LoupeWorkflowCollections($cursor: String) {
    collections(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id handle title
        productsCount { count }
        ruleSet { appliedDisjunctively rules { column relation condition } }
      }
    }
  }
`

const MEMBERS = /* GraphQL */ `
  query LoupeWorkflowCollectionMembers($id: ID!, $cursor: String) {
    collection(id: $id) {
      products(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id handle title tags totalInventory
          priceRangeV2 { maxVariantPrice { amount } }
        }
      }
    }
  }
`

interface CollectionNode {
  id: string
  handle: string
  title: string
  productsCount: { count: number } | null
  ruleSet: RuleSet | null
}

interface CollectionsPage {
  collections: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: readonly CollectionNode[] }
}

interface MembersPage {
  collection: {
    products: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
      nodes: readonly {
        id: string
        handle: string
        title: string
        tags: readonly string[]
        totalInventory: number | null
        priceRangeV2: { maxVariantPrice: { amount: string } } | null
      }[]
    }
  } | null
}

async function readCollections(client: ShopifyClient): Promise<CollectionNode[]> {
  const collections: CollectionNode[] = []
  let cursor: string | null = null
  for (;;) {
    const page: CollectionsPage = await client.graphql<CollectionsPage>(COLLECTIONS, { cursor })
    collections.push(...page.collections.nodes)
    if (!page.collections.pageInfo.hasNextPage || !page.collections.pageInfo.endCursor) return collections
    cursor = page.collections.pageInfo.endCursor
  }
}

async function readMembers(client: ShopifyClient, id: string): Promise<MemberProduct[]> {
  const members: MemberProduct[] = []
  let cursor: string | null = null
  for (;;) {
    const page: MembersPage = await client.graphql<MembersPage>(MEMBERS, { id, cursor })
    const products = page.collection?.products
    if (!products) return members
    for (const node of products.nodes) {
      members.push({
        id: node.id,
        handle: node.handle,
        title: node.title,
        tags: node.tags,
        totalInventory: node.totalInventory ?? 0,
        maxPrice: Number.parseFloat(node.priceRangeV2?.maxVariantPrice.amount ?? '0') || 0,
      })
    }
    if (!products.pageInfo.hasNextPage || !products.pageInfo.endCursor) return members
    cursor = products.pageInfo.endCursor
  }
}

export function collectionsProgram(): WorkflowProgram {
  const client = new ShopifyClient()
  let automated: CollectionNode[] = []

  return {
    steps: [
      {
        key: 'rules',
        label: 'Read collection rules',
        async run(context: StepContext) {
          const all = await readCollections(client)
          automated = all.filter((collection) => collection.ruleSet && collection.ruleSet.rules.length > 0)
          const skipped: string[] = []
          for (const collection of automated) {
            const unsupported = unsupportedRules(collection.ruleSet!)
            if (unsupported.length > 0) {
              skipped.push(`${collection.handle}: ${unsupported.map((rule) => `${rule.column} ${rule.relation} ${rule.condition}`).join(', ')}`)
            }
            const marker = collection.ruleSet!.rules.find((rule) => /zzqimatirebuild/i.test(rule.condition))
            if (marker) context.log(`${collection.handle} still carries the rebuild marker rule (${marker.column} ${marker.relation} ${marker.condition}); harmless, remove in admin when convenient`)
          }
          if (skipped.length > 0) context.section('Rules Loupe cannot evaluate — collection not judged', skipped)
          return `${automated.length} automated collections, ${all.length - automated.length} manual`
        },
      },
      {
        key: 'members',
        label: 'Check every member against its rules',
        async run(context: StepContext) {
          let checked = 0
          let stuck = 0
          const perCollection: string[] = []
          for (const [index, collection] of automated.entries()) {
            const ruleSet = collection.ruleSet!
            if (unsupportedRules(ruleSet).length > 0) continue
            await context.report(`${collection.handle} (${index + 1} of ${automated.length})`)
            const members = await readMembers(client, collection.id)
            checked += members.length
            const failing = members
              .map((member) => ({ member, verdict: judgeMember(ruleSet, member) }))
              .filter((row): row is { member: MemberProduct; verdict: { ok: false; reason: string } } => !row.verdict.ok)
            if (failing.length === 0) continue
            stuck += failing.length
            perCollection.push(`${collection.handle}: ${failing.length} of ${members.length}`)
            context.section(
              `${collection.title} (${collection.handle}) — ${failing.length} of ${members.length} fail the rules`,
              failing.map((row) => `${row.member.handle} — ${row.verdict.reason}`),
            )
          }
          if (stuck === 0) {
            context.summary(`All ${checked.toLocaleString('en-IN')} collection members pass their rules.`)
            return `${checked.toLocaleString('en-IN')} members checked, none out of place`
          }
          context.summary(
            `${stuck} product${stuck === 1 ? '' : 's'} inside collections they no longer qualify for (${perCollection.join(', ')}). Remove them from the collection page in admin — "manually included products".`,
          )
          return { detail: `${stuck} of ${checked.toLocaleString('en-IN')} members fail their collection's rules`, warning: true }
        },
      },
    ],
  }
}
