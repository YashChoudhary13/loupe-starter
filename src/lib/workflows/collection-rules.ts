/**
 * D122 — evaluates Shopify automated-collection rules against a product.
 * Pure. Covers exactly the rule shapes the store uses (TAG, TITLE,
 * VARIANT_INVENTORY, VARIANT_PRICE); anything else returns `null` so the
 * caller reports "not evaluated" instead of guessing.
 */

export interface CollectionRule {
  readonly column: string
  readonly relation: string
  readonly condition: string
}

export interface RuleSet {
  readonly appliedDisjunctively: boolean
  readonly rules: readonly CollectionRule[]
}

export interface MemberProduct {
  readonly id: string
  readonly handle: string
  readonly title: string
  readonly tags: readonly string[]
  readonly totalInventory: number
  readonly maxPrice: number
}

export type RuleVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string }

function compareText(actual: string, relation: string, condition: string): boolean | null {
  const a = actual.toLowerCase()
  const c = condition.toLowerCase()
  switch (relation) {
    case 'EQUALS':
      return a === c
    case 'NOT_EQUALS':
      return a !== c
    case 'CONTAINS':
      return a.includes(c)
    case 'NOT_CONTAINS':
      return !a.includes(c)
    case 'STARTS_WITH':
      return a.startsWith(c)
    case 'ENDS_WITH':
      return a.endsWith(c)
    default:
      return null
  }
}

function compareNumber(actual: number, relation: string, condition: string): boolean | null {
  const c = Number.parseFloat(condition)
  if (Number.isNaN(c)) return null
  switch (relation) {
    case 'GREATER_THAN':
      return actual > c
    case 'LESS_THAN':
      return actual < c
    case 'EQUALS':
      return actual === c
    case 'NOT_EQUALS':
      return actual !== c
    default:
      return null
  }
}

/** One rule against one product. `null` = rule shape not understood. */
export function evaluateRule(rule: CollectionRule, product: MemberProduct): boolean | null {
  switch (rule.column) {
    case 'TAG': {
      const has = product.tags.some((tag) => tag.trim().toLowerCase() === rule.condition.trim().toLowerCase())
      if (rule.relation === 'EQUALS') return has
      if (rule.relation === 'NOT_EQUALS') return !has
      return null
    }
    case 'TITLE':
      return compareText(product.title, rule.relation, rule.condition)
    case 'VARIANT_INVENTORY':
      return compareNumber(product.totalInventory, rule.relation, rule.condition)
    case 'VARIANT_PRICE':
      return compareNumber(product.maxPrice, rule.relation, rule.condition)
    default:
      return null
  }
}

function describe(rule: CollectionRule): string {
  switch (rule.column) {
    case 'VARIANT_INVENTORY':
      return 'sold out'
    case 'TAG':
      return `tag "${rule.condition}" ${rule.relation === 'EQUALS' ? 'missing' : 'present'}`
    case 'VARIANT_PRICE':
      return `price not ${rule.relation.toLowerCase().replace('_', ' ')} ${rule.condition}`
    default:
      return `${rule.column} ${rule.relation} ${rule.condition} fails`
  }
}

/** Returns the rules a product cannot be judged against (unsupported shapes). */
export function unsupportedRules(ruleSet: RuleSet): readonly CollectionRule[] {
  const probe: MemberProduct = { id: '', handle: '', title: '', tags: [], totalInventory: 0, maxPrice: 0 }
  return ruleSet.rules.filter((rule) => evaluateRule(rule, probe) === null)
}

/** Whether a product belongs, and if not, why — in the operator's words. */
export function judgeMember(ruleSet: RuleSet, product: MemberProduct): RuleVerdict {
  const failed: string[] = []
  let passed = 0
  for (const rule of ruleSet.rules) {
    const verdict = evaluateRule(rule, product)
    if (verdict === true) passed += 1
    else if (verdict === false) failed.push(describe(rule))
  }
  if (ruleSet.appliedDisjunctively) {
    return passed > 0 ? { ok: true } : { ok: false, reason: failed.join(', ') }
  }
  return failed.length === 0 ? { ok: true } : { ok: false, reason: failed.join(', ') }
}
