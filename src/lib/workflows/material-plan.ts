import { buildSeo, type SeoFields } from '@/lib/publish/seo'

/**
 * D122 — the material-consistency planner. Pure: takes the catalogue, returns
 * what to write and what to report. Ported from the 4 Sep 2026 audit script
 * (Qimati SEO, implementation/material-audit-2026-09-04) with the same rule:
 * the description is the truth, because it is the only field an operator
 * types on purpose after "Duplicate product"; tags, metafield and SEO follow.
 *
 * A description naming no material or two is reported, never guessed.
 */

export const MATERIALS = ['316L', '304', 'Brass'] as const
export type Material = (typeof MATERIALS)[number]

/** SEO fields written before this date were reviewed by hand; leave them. */
export const SEO_REGENERATE_SINCE = '2026-08-27'

export interface MaterialProductInput {
  readonly id: string
  readonly handle: string
  readonly title: string
  readonly status: string
  readonly tags: readonly string[]
  /** Visible description text, HTML already stripped. */
  readonly bodyText: string
  readonly createdAt: string
  readonly seoTitle: string
  readonly seoDescription: string
  readonly material: string | null
}

export interface MaterialChange {
  readonly id: string
  readonly handle: string
  readonly material: Material
  readonly tags?: { readonly before: readonly string[]; readonly after: readonly string[] }
  readonly metafield?: { readonly before: string; readonly after: Material }
  readonly seo?: { readonly before: SeoFields; readonly after: SeoFields }
}

export interface MaterialFinding {
  readonly handle: string
  readonly issue: string
}

export interface MaterialPlan {
  readonly active: number
  readonly changes: readonly MaterialChange[]
  /** Products a human must look at: the description names 0 or 2 materials. */
  readonly needsHuman: readonly MaterialFinding[]
  /** Everything not fully consistent, fixable or not, one line each. */
  readonly findings: readonly MaterialFinding[]
}

export function bodyMaterials(text: string): Set<Material> {
  const found = new Set<Material>()
  if (/\b316\s*L?\b/i.test(text)) found.add('316L')
  if (/\b304\b/.test(text)) found.add('304')
  if (/\bbrass\b/i.test(text)) found.add('Brass')
  return found
}

function isMaterialTag(tag: string): boolean {
  const clean = tag.trim().toLowerCase()
  return clean === '316l' || clean === '304' || clean === 'brass'
}

/** Exactly the theme's snippets/product-badge.liquid priority: 316L, else 304, else Brass. */
export function badgeFor(tags: readonly string[]): Material | null {
  return MATERIALS.find((material) => tags.includes(material)) ?? null
}

export function titleNumber(title: string): number | null {
  const match = /\s(\d{2,4})\b/.exec(title)
  return match ? Number.parseInt(match[1], 10) : null
}

function seoNumber(seoTitle: string): number | null {
  const match = /— (\d+)/.exec(seoTitle)
  return match ? Number.parseInt(match[1], 10) : null
}

export function planMaterialFixes(
  products: readonly MaterialProductInput[],
  /** Lower-cased Shopify category tag → SKU prefix, from Loupe's `categories`. */
  prefixByTag: ReadonlyMap<string, string>,
): MaterialPlan {
  const changes: MaterialChange[] = []
  const needsHuman: MaterialFinding[] = []
  const findings: MaterialFinding[] = []
  let active = 0

  for (const product of products) {
    if (product.status !== 'ACTIVE' || product.handle.startsWith('zz-')) continue
    active += 1

    const inBody = bodyMaterials(product.bodyText)
    const materialTags = product.tags.filter(isMaterialTag)
    const badge = badgeFor(product.tags)
    const metafield = product.material ?? ''

    if (inBody.size !== 1) {
      if (inBody.size > 0 || materialTags.length > 0 || metafield) {
        const issue =
          inBody.size > 1
            ? `description names two materials (${[...inBody].join(', ')})`
            : 'no material in the description'
        needsHuman.push({ handle: product.handle, issue })
        findings.push({ handle: product.handle, issue })
      }
      continue
    }

    const material = [...inBody][0]
    const issues: string[] = []
    let change: MaterialChange = { id: product.id, handle: product.handle, material }

    if (badge !== material || materialTags.length !== 1 || materialTags[0] !== material) {
      issues.push(`badge/tags ${badge ?? 'none'} ≠ description ${material}`)
      const after = [...product.tags.filter((tag) => !isMaterialTag(tag)), material]
      change = { ...change, tags: { before: product.tags, after } }
    }
    if (metafield && metafield !== material) {
      issues.push(`metafield ${metafield} ≠ description ${material}`)
      change = { ...change, metafield: { before: metafield, after: material } }
    }

    const seoMaterial = /^Wholesale (316L|304|Brass)\b/.exec(product.seoTitle)?.[1] ?? null
    const number = titleNumber(product.title)
    const seoN = seoNumber(product.seoTitle)
    const seoStale =
      !product.seoTitle ||
      (seoMaterial !== null && seoMaterial !== material) ||
      (seoN !== null && number !== null && seoN !== number)
    if (seoStale && product.createdAt.slice(0, 10) >= SEO_REGENERATE_SINCE) {
      const categoryTag = product.tags.map((tag) => tag.trim().toLowerCase()).find((tag) => prefixByTag.has(tag))
      const prefix = categoryTag ? prefixByTag.get(categoryTag) : undefined
      if (prefix && number !== null) {
        const after = buildSeo({ skuPrefix: prefix, skuNumber: number, material })
        if (after.title !== product.seoTitle || after.description !== product.seoDescription) {
          issues.push(product.seoTitle ? `SEO "${product.seoTitle}" ≠ description/title` : 'SEO empty')
          change = {
            ...change,
            seo: { before: { title: product.seoTitle, description: product.seoDescription }, after },
          }
        }
      } else {
        issues.push('SEO stale but category tag or title number unknown')
      }
    }

    if (issues.length > 0) findings.push({ handle: product.handle, issue: issues.join('; ') })
    if (change.tags || change.metafield || change.seo) changes.push(change)
  }

  return { active, changes, needsHuman, findings }
}

export function describeChange(change: MaterialChange): string {
  const parts: string[] = []
  if (change.tags) parts.push(`tags [${change.tags.before.filter(isMaterialTag).join(', ') || 'none'}] → [${change.material}]`)
  if (change.metafield) parts.push(`metafield ${change.metafield.before} → ${change.metafield.after}`)
  if (change.seo) parts.push(`SEO "${change.seo.before.title || '(empty)'}" → "${change.seo.after.title}"`)
  return `${change.handle}: ${parts.join(' · ')}`
}
