/**
 * D122 — the banned-wording list, as regular expressions over visible text.
 * Pure, so it is testable and so the patterns are reviewable in one place.
 *
 * Sources: the sitewide banned list in the Qimati SEO working agreement and
 * the seven product-body wordings replaced on 26–27 Aug 2026. "best", "top"
 * and "leading" are deliberately absent — they match the approved copy
 * ("Extra E-Coating Layer on top").
 */

export interface CopyRule {
  readonly name: string
  readonly pattern: RegExp
}

export const COPY_RULES: readonly CopyRule[] = [
  { name: 'Absolute claim', pattern: /\b100\s?%|\bguaranteed?\b|never tarnish|\bpermanent\b/i },
  { name: 'Superlative', pattern: /india'?s\s+no\.?\s*1\b/i },
  {
    name: 'Manufacturing claim',
    pattern: /\bhandmade\b|\bhand-?crafted\b|\bcrafted\b|\bcraftsmanship\b|\bartisans?\b|\bfactory\b|\bwe make\b|in-house|made-to-order/i,
  },
  // "18kt gold" must always be followed by colour/tone; bare, it reads as purity.
  { name: 'Bare 18kt gold', pattern: /\b18\s*k(?:t)?\s+gold\b(?!\s*[-–]?\s*(?:colou?r|tone))/i },
  { name: 'Waterproof claim', pattern: /\bwaterproof\b|sweat\s*&\s*moisture/i },
  { name: 'Skin-friendly / surgical grade', pattern: /skin[- ]friendly|surgical[- ]grade/i },
  { name: '"ensures" (performance guarantee)', pattern: /\bensures?\b/i },
  { name: '"rare in most brands"', pattern: /rare in most brands/i },
  { name: '"High-margin"', pattern: /high[- ]margin/i },
  { name: '"Gold Tone Plating"', pattern: /gold tone plating/i },
]

export interface CopyFinding {
  readonly handle: string
  readonly field: string
  readonly rule: string
  readonly snippet: string
}

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30)
  const end = Math.min(text.length, index + length + 30)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}

/** Every rule hit across the given (field, text) pairs — one finding per rule per field. */
export function scanCopy(
  handle: string,
  fields: readonly (readonly [field: string, text: string])[],
): CopyFinding[] {
  const findings: CopyFinding[] = []
  for (const [field, text] of fields) {
    if (!text) continue
    for (const rule of COPY_RULES) {
      const match = rule.pattern.exec(text)
      if (!match) continue
      findings.push({ handle, field, rule: rule.name, snippet: snippetAround(text, match.index, match[0].length) })
    }
  }
  return findings
}
