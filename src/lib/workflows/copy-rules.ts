import 'server-only'

import { buildDescriptionHtml, isControlledMaterial } from '@/lib/publish/description'
import { ShopifyClient } from '@/lib/shopify/client'

import { readCatalogue, stripHtml, type CatalogueProduct } from './catalogue'
import { bodyMaterials } from './material-plan'
import { COPY_RULES, scanCopy, type CopyFinding } from './copy-rules-scan'
import type { StepContext, WorkflowProgram } from './runner'

/**
 * D122 — "Copy rules scan". Reads every active product, scans description
 * text and SEO fields against the banned-wording list, and replaces only the
 * pre-26-Aug boilerplate ("Made with premium … (Surgical Grade)") with the
 * standard six bullets for the material it names. Everything else is a report.
 */

const PRODUCT_UPDATE = /* GraphQL */ `
  mutation LoupeWorkflowBodyUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id }
      userErrors { field message }
    }
  }
`

/** The old catalogue boilerplate, recognisable by its opening line. */
export function isOldBoilerplate(text: string): boolean {
  return /made with premium/i.test(text) && /surgical grade/i.test(text)
}

export function copyRulesProgram(): WorkflowProgram {
  const client = new ShopifyClient()
  let products: CatalogueProduct[] = []
  let findings: CopyFinding[] = []
  let boilerplate: CatalogueProduct[] = []

  return {
    steps: [
      {
        key: 'pull',
        label: 'Pull the catalogue',
        async run(context: StepContext) {
          const all = await readCatalogue(client, (count) =>
            context.report(`${count.toLocaleString('en-IN')} products so far`),
          )
          products = all.filter((product) => product.status === 'ACTIVE' && !product.handle.startsWith('zz-'))
          return `${products.length.toLocaleString('en-IN')} active products`
        },
      },
      {
        key: 'scan',
        label: 'Scan descriptions and SEO',
        async run(context: StepContext) {
          findings = []
          boilerplate = []
          for (const product of products) {
            const text = stripHtml(product.descriptionHtml)
            if (isOldBoilerplate(text)) boilerplate.push(product)
            findings.push(
              ...scanCopy(product.handle, [
                ['description', text],
                ['SEO title', product.seoTitle],
                ['SEO description', product.seoDescription],
              ]),
            )
          }
          const perRule = new Map<string, number>()
          for (const finding of findings) perRule.set(finding.rule, (perRule.get(finding.rule) ?? 0) + 1)
          for (const rule of COPY_RULES) {
            const hits = findings.filter((finding) => finding.rule === rule.name)
            if (hits.length > 0) {
              context.section(
                `${rule.name} — ${hits.length}`,
                hits.map((finding) => `${finding.handle} · ${finding.field}: “${finding.snippet}”`),
              )
            }
          }
          const affected = new Set(findings.map((finding) => finding.handle)).size
          if (findings.length === 0) {
            context.summary(`No banned wording on ${products.length.toLocaleString('en-IN')} active products.`)
            return 'Clean'
          }
          const rules = [...perRule.entries()].map(([name, count]) => `${name} ${count}`).join(' · ')
          context.summary(`${affected} product${affected === 1 ? '' : 's'} carry banned wording (${rules}).`)
          return { detail: `${findings.length} hit${findings.length === 1 ? '' : 's'} on ${affected} products — ${rules}`, warning: true }
        },
      },
      {
        key: 'fix',
        label: 'Replace old boilerplate',
        async run(context: StepContext) {
          if (boilerplate.length === 0) return 'No old boilerplate left'
          let written = 0
          const skipped: string[] = []
          const refused: string[] = []
          for (const [index, product] of boilerplate.entries()) {
            await context.report(`${index + 1} of ${boilerplate.length}`)
            const materials = [...bodyMaterials(stripHtml(product.descriptionHtml))]
            if (materials.length !== 1 || !isControlledMaterial(materials[0])) {
              skipped.push(`${product.handle} — names ${materials.length === 0 ? 'no' : 'two'} materials, left alone`)
              continue
            }
            const response = await client.graphql<{ productUpdate: { userErrors: readonly { message: string }[] } }>(
              PRODUCT_UPDATE,
              { product: { id: product.id, descriptionHtml: buildDescriptionHtml(materials[0], null) } },
            )
            if (response.productUpdate.userErrors.length > 0) {
              refused.push(`${product.handle} — ${response.productUpdate.userErrors.map((error) => error.message).join('; ')}`)
            } else {
              written += 1
              context.log(`${product.handle}: old boilerplate replaced with the ${materials[0]} bullets`)
            }
          }
          if (skipped.length > 0) context.section('Old boilerplate left alone', skipped)
          if (refused.length > 0) context.section('Shopify refused', refused)
          const detail = `${written} of ${boilerplate.length} replaced${skipped.length > 0 ? `, ${skipped.length} left alone` : ''}${refused.length > 0 ? `, ${refused.length} refused` : ''}`
          return skipped.length + refused.length > 0 ? { detail, warning: true } : detail
        },
      },
    ],
  }
}
