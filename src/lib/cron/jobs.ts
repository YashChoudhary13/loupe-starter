import 'server-only'

export async function runShopifyReconciliationCron() {
  // Draft sync runs FIRST. A draft published from Shopify's own admin should be
  // compared as a published product in this same run; a draft deleted there
  // should disappear from Loupe before the tracking snapshot is rebuilt.
  const { promotePublishedInShopify } = await import('@/lib/reconciliation/promote')
  const { runShopifyReconciliation } = await import('@/lib/reconciliation/server')

  // Keep the push channel alive (D102). Idempotent; a failure here changes
  // nothing about the nightly check, which is the backstop for exactly the
  // case where webhooks are broken.
  let webhooks
  try {
    const { ensureShopifyWebhooks } = await import('@/lib/shopify/webhooks')
    webhooks = await ensureShopifyWebhooks()
  } catch (cause) {
    webhooks = { error: cause instanceof Error ? cause.message : String(cause) }
  }

  let promotion
  try {
    promotion = await promotePublishedInShopify('supabase-pg-cron')
  } catch (cause) {
    // Promotion is an enhancement to reconciliation, not a precondition for it.
    // A failure here must not stop the drift check that the business actually
    // depends on.
    promotion = { error: cause instanceof Error ? cause.message : String(cause) }
  }

  const reconciliation = await runShopifyReconciliation('supabase-pg-cron')

  return { webhooks, promotion, reconciliation }
}
