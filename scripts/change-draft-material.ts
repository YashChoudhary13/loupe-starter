/**
 * Change the material of Loupe-published DRAFT listings and re-push them through Loupe's own publisher,
 * so tags, the first description bullet, custom.material and the SEO title/description all follow the
 * one material field and the nightly reconciliation sees no drift.
 *
 *   npx tsx scripts/change-draft-material.ts <env-file> <from> <to> <first-sku> <last-sku> <receipt-dir> [--apply]
 *   e.g. … .env.railway 304 316L ER713 ER731 /path/receipts --apply
 *
 * Without --apply: read-only plan (drafts, current Shopify fields, what would change). With --apply: per product,
 * flip product_drafts.material_id (only if still <from>), record an event, run publishDraftForOperator with
 * shopifyStatus DRAFT, then read Shopify back and verify every material-bearing field. A product that is no longer
 * DRAFT in Shopify is skipped: re-pushing as DRAFT would un-publish it. Custom description overrides are refused.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'dotenv'

interface ShopifyProduct { id: string; title: string; status: string; tags: string[]; descriptionHtml: string; seo: { title: string | null; description: string | null }; metafield: { id: string; value: string } | null }

async function main() {
  const [envFile, from, to, first, last, receiptDir, flag] = process.argv.slice(2)
  if (!envFile || !from || !to || !first || !last || !receiptDir) throw new Error('Usage: <env-file> <from> <to> <first-sku> <last-sku> <receipt-dir> [--apply]')
  const apply = flag === '--apply'
  Object.assign(process.env, parse(readFileSync(envFile)))
  const { supabaseServer } = await import('../src/lib/supabase/server')
  const { ShopifyClient } = await import('../src/lib/shopify/client')
  const { publishDraftForOperator } = await import('../src/lib/console/publish')
  const db = supabaseServer()
  const shopify = new ShopifyClient()
  mkdirSync(receiptDir, { recursive: true })

  const prefix = first.match(/^[A-Z]+/)?.[0]
  const a = Number(first.slice(prefix?.length)), b = Number(last.slice(prefix?.length))
  if (!prefix || prefix !== last.match(/^[A-Z]+/)?.[0] || !Number.isInteger(a) || !Number.isInteger(b) || b < a || b - a > 200) throw new Error('Give one prefix and an ascending range of at most 200 numbers.')
  const skus = Array.from({ length: b - a + 1 }, (_, i) => `${prefix}${String(a + i).padStart(3, '0')}`)

  const materials = await db.from('materials').select('*')
  if (materials.error) throw materials.error
  const nameKey = ['name', 'label', 'value', 'material'].find(k => materials.data.some(row => k in row))
  if (!nameKey) throw new Error('materials table has no recognisable name column')
  const material = (name: string) => materials.data.find(row => String(row[nameKey]).trim() === name)
  const fromRow = material(from), toRow = material(to)
  if (!fromRow || !toRow) throw new Error(`Materials must exist: ${from}=${fromRow?.id ?? '∅'} ${to}=${toRow?.id ?? '∅'}`)

  const adminEmail = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase()
  const admin = adminEmail ? await db.from('app_users').select('id, email, name, role').eq('email', adminEmail).eq('active', true).maybeSingle() : null
  if (!admin?.data) throw new Error('SEED_ADMIN_EMAIL must name an active app_users row; the push is attributed to it.')
  const operator = { id: admin.data.id, email: admin.data.email, name: admin.data.name, role: admin.data.role as 'admin' | 'operator' }

  const drafts = await db.from('product_drafts').select('id, reserved_sku, reserved_handle, status, material_id, custom_material, description_override, shopify_product_id, publish_lease_expires_at').in('reserved_sku', skus).order('reserved_sku')
  if (drafts.error) throw drafts.error
  const read = async (id: string): Promise<ShopifyProduct | null> => (await shopify.graphql<{ product: ShopifyProduct | null }>(`query M($id: ID!) { product(id: $id) { id title status tags descriptionHtml seo { title description } metafield(namespace: "custom", key: "material") { id value } } }`, { id })).product

  const receipt: { mode: string; from: string; to: string; skus: string[]; operator: string; rows: Record<string, unknown>[]; startedAt: string; finishedAt?: string } = { mode: apply ? 'apply' : 'plan', from, to, skus, operator: operator.email, rows: [], startedAt: new Date().toISOString() }
  for (const sku of skus) {
    const draft = drafts.data.find(d => d.reserved_sku === sku)
    const row: Record<string, unknown> = { sku }
    receipt.rows.push(row)
    if (!draft) { row.result = 'no Loupe draft'; continue }
    Object.assign(row, { draftId: draft.id, handle: draft.reserved_handle, draftStatus: draft.status, productId: draft.shopify_product_id })
    if (draft.custom_material || draft.description_override) { row.result = 'skipped: custom material or description override — change by hand'; continue }
    if (draft.material_id === toRow.id) { row.result = `already ${to} in Loupe`; }
    else if (draft.material_id !== fromRow.id) { row.result = `skipped: Loupe material is neither ${from} nor ${to}`; continue }
    if (!draft.shopify_product_id) { row.result = 'skipped: never pushed to Shopify'; continue }
    if (draft.publish_lease_expires_at && new Date(draft.publish_lease_expires_at).getTime() > Date.now()) { row.result = 'skipped: a push is in flight'; continue }
    const before = await read(draft.shopify_product_id)
    if (!before) { row.result = 'skipped: Shopify product missing'; continue }
    row.before = { status: before.status, tags: before.tags, material: before.metafield?.value ?? null, seoTitle: before.seo.title, descriptionFirstLine: before.descriptionHtml.split('\n')[1] ?? before.descriptionHtml.slice(0, 120) }
    if (before.status !== 'DRAFT') { row.result = `skipped: Shopify status is ${before.status}; re-pushing as DRAFT would un-publish it`; continue }
    if (!apply) { row.result = row.result ?? `would set Loupe material ${from} → ${to} and re-push tags, description, custom.material, SEO`; continue }

    if (draft.material_id !== toRow.id) {
      const flipped = await db.from('product_drafts').update({ material_id: toRow.id }).eq('id', draft.id).eq('material_id', fromRow.id).select('id')
      if (flipped.error || !flipped.data?.length) { row.result = 'failed: Loupe material did not flip (changed underneath?)'; continue }
      await db.from('events').insert({ entity_type: 'product_draft', entity_id: draft.id, event: 'draft.material_changed', detail: { from, to, sku, script: 'change-draft-material' }, actor: operator.email })
    }
    try { await publishDraftForOperator(draft.id, operator, { allowZeroStock: true, shopifyStatus: 'DRAFT' }) }
    catch (error) { row.result = `failed: push — ${error instanceof Error ? error.message : String(error)}`; continue }
    const after = await read(draft.shopify_product_id)
    const ok = !!after && after.status === 'DRAFT' && after.tags.includes(to) && !after.tags.includes(from) && after.metafield?.value === to
      && after.descriptionHtml.includes(`${to} Stainless Steel`) && !after.descriptionHtml.includes(`${from} Stainless`) && (after.seo.title ?? '').includes(to) && !(after.seo.title ?? '').includes(from)
    row.after = after && { status: after.status, tags: after.tags, material: after.metafield?.value ?? null, seoTitle: after.seo.title, descriptionFirstLine: after.descriptionHtml.split('\n')[1] ?? '' }
    row.result = ok ? 'changed and verified' : 'PUSHED BUT VERIFICATION FAILED — inspect'
    console.log(sku, '→', row.result)
  }
  receipt.finishedAt = new Date().toISOString()
  const file = join(receiptDir, `${apply ? 'apply' : 'plan'}-${receipt.startedAt.replace(/[:.]/g, '-')}.json`)
  writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n')
  console.log('\n' + receipt.rows.map(r => `${r.sku}: ${r.result}`).join('\n'))
  console.log('\nreceipt:', file)
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1) })
