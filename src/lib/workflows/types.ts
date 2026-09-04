/**
 * D122 — the /workflows catalogue and the run record the browser renders.
 *
 * Client-safe: no server imports. The step list here is what a card shows
 * before its first run; once a run exists the row's own `steps` are shown.
 */

export type WorkflowKey =
  | 'material'
  | 'reconciliation'
  | 'copy_rules'
  | 'collections'

export type StepStatus = 'pending' | 'running' | 'done' | 'warning' | 'failed' | 'skipped'

export interface StepState {
  readonly key: string
  readonly label: string
  readonly status: StepStatus
  /** One live line: "page 12/36", "142 of 196 written", or the step's outcome. */
  readonly detail: string | null
  readonly startedAt: string | null
  readonly finishedAt: string | null
}

export interface ResultSection {
  readonly title: string
  readonly rows: readonly string[]
}

export interface WorkflowRunView {
  readonly id: string
  readonly workflow: WorkflowKey
  readonly status: 'running' | 'succeeded' | 'failed'
  readonly startedBy: string
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly steps: readonly StepState[]
  readonly summary: string | null
  readonly error: string | null
  readonly log: readonly string[]
  readonly sections: readonly ResultSection[]
}

export interface WorkflowDefinition {
  readonly key: WorkflowKey
  readonly title: string
  readonly description: string
  /** What Run actually changes in Shopify or Loupe; "Report only" when nothing. */
  readonly writes: string
  readonly steps: readonly { readonly key: string; readonly label: string }[]
}

export const WORKFLOWS: readonly WorkflowDefinition[] = [
  {
    key: 'material',
    title: 'Material consistency',
    description:
      'Every product states its material four times: the 316L / 304 / Brass tag that drives the image badge, the description, the custom.material metafield and the SEO title. Admin "Duplicate product" copies three of them from the source and the operator retypes only the description, so they drift apart. The description is the truth; the other three are made to follow it.',
    writes: 'Rewrites tags, metafield and SEO fields on products whose description disagrees. Before and after values are kept in the run.',
    steps: [
      { key: 'pull', label: 'Pull the catalogue' },
      { key: 'plan', label: 'Compare description with tag, metafield and SEO' },
      { key: 'write', label: 'Write the fixes' },
      { key: 'verify', label: 'Read back and verify' },
    ],
  },
  {
    key: 'reconciliation',
    title: 'Full reconciliation',
    description:
      'Checks Shopify against what Loupe published: keeps the webhooks registered, reflects drafts published or deleted in Shopify admin, records product drift for Tracking, moves published photographs out of Drive RAW, raises the per-category SKU counters if Shopify is ahead, and lists duplicate SKUs and copied handles.',
    writes: 'Registers missing webhooks, updates draft status in Loupe, moves Drive files, raises SKU counters. Never edits a Shopify product.',
    steps: [
      { key: 'webhooks', label: 'Shopify webhooks' },
      { key: 'drafts', label: 'Reflect Shopify-side draft changes' },
      { key: 'drift', label: 'Compare published products' },
      { key: 'drive', label: 'Tidy Drive RAW' },
      { key: 'counters', label: 'SKU counters' },
      { key: 'duplicates', label: 'Duplicate SKUs and copied handles' },
    ],
  },
  {
    key: 'copy_rules',
    title: 'Copy rules scan',
    description:
      'Finds product descriptions and SEO fields carrying wording the store has banned — absolutes, manufacturing claims, bare "18kt gold", and the seven pre-August phrasings. Admin duplicates resurrect old text.',
    writes: 'Report only, except a description that is still the old "Made with premium … (Surgical Grade)" boilerplate, which is replaced with the standard six bullets for its material.',
    steps: [
      { key: 'pull', label: 'Pull the catalogue' },
      { key: 'scan', label: 'Scan descriptions and SEO' },
      { key: 'fix', label: 'Replace old boilerplate' },
    ],
  },
  {
    key: 'collections',
    title: 'Collection membership audit',
    description:
      'Lists products that sit inside an automated collection although they fail its rules — sold-out pieces still showing, products whose tag no longer matches. These are admin "manually included" products; there is no API to remove them, so the report names them for the admin collection page.',
    writes: 'Report only.',
    steps: [
      { key: 'rules', label: 'Read collection rules' },
      { key: 'members', label: 'Check every member against its rules' },
    ],
  },
]

export function workflowDefinition(key: WorkflowKey): WorkflowDefinition {
  const found = WORKFLOWS.find((workflow) => workflow.key === key)
  if (!found) throw new Error(`Unknown workflow ${key}`)
  return found
}
