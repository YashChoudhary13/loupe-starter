/**
 * Every table in the public schema, in the order a human wants to read them.
 * Kept here so /health cannot silently stop covering a table someone adds.
 * tests/schema.test.ts asserts this list matches the database exactly.
 */
export const TABLES = [
  'categories',
  'sku_counters',
  'materials',
  'colours',
  'colour_usage',
  'product_drafts',
  'intake_files',
  'manual_uploads',
  'image_versions',
  'image_redo_jobs',
  'duplicate_reviews',
  'product_draft_images',
  'product_draft_variants',
  'prompts',
  'events',
  'app_users',
  'sync_state',
  'shopify_reconciliation_runs',
  'shopify_reconciliation_issues',
  'shopify_reconciliation_dismissals',
] as const

export type TableName = (typeof TABLES)[number]
