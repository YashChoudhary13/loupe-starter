import { PipelineDiagram, type StageView } from '@/components/models/PipelineDiagram'
import { requireOperator } from '@/lib/auth/authorize'
import {
  PIPELINE_STAGES,
  pipelineModelChoices,
} from '@/lib/config/models'
import { DESCRIBE_MODELS, IMAGE_MODELS } from '@/lib/prompts/models'

import { setPipelineModelAction } from './actions'

export const dynamic = 'force-dynamic'

/**
 * D121 — the Models section: the enhancement pipeline drawn as steps, each
 * model stage with a dropdown of its curated choices. Changes persist in
 * `app_config` and apply without a deploy.
 */

const STAGE_COPY: Record<string, { description: string; appliesNote: string }> = {
  art_director_model: {
    description:
      'Looks at the photo and picks the scene by rubric when a setting is on "Auto" — dark pieces to pale grounds, clear-stone rings to black marble, bridal work to velvet, everything else to the house charcoal.',
    appliesNote: 'Applies immediately, on the next Auto upload',
  },
  describe_model: {
    description:
      'Writes the forensic identity record from the photo — exact counts, cuts, attachment, per-strand ledgers. Errors here poison the render, so counting accuracy matters more than price.',
    appliesNote: 'Applies to pairs materialised after the change — the next categorised upload refreshes its pair',
  },
  image_model: {
    description:
      'Re-photographs the exact piece on the chosen scene from the photo, the identity record and the protection prompt. The spend of the pipeline lives here.',
    appliesNote: 'Applies to pairs materialised after the change — the next categorised upload refreshes its pair',
  },
  check_model: {
    description:
      'Compares every fresh render against the source photograph — counts, chain gauge, colours, orientation — and triggers one corrected regeneration when the render drifts.',
    appliesNote: 'Applies immediately, on the next enhancement tick',
  },
}

export default async function ModelsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>
}) {
  await requireOperator()
  const [choices, feedback] = await Promise.all([pipelineModelChoices(), searchParams])

  const stages: StageView[] = PIPELINE_STAGES.map((definition) => {
    const choice = choices.find((row) => row.key === definition.key)
    const copy = STAGE_COPY[definition.key] ?? { description: '', appliesNote: '' }
    return {
      key: definition.key,
      label: definition.label,
      description: copy.description,
      appliesNote: copy.appliesNote,
      model: choice?.model ?? definition.fallback,
      isDefault: choice?.isDefault ?? true,
      updatedBy: choice?.updatedBy ?? null,
      options: definition.kind === 'image' ? IMAGE_MODELS : DESCRIBE_MODELS,
    }
  })

  return (
    <main className="loupe-scroll min-h-0 min-w-0 overflow-y-auto pr-1">
      <header className="mb-4">
        <h1 className="text-[26px] font-medium tracking-[-0.025em]">Models</h1>
        <p className="mt-1 text-[12px] text-muted-foreground">
          The enhancement pipeline, step by step. Every model stage can be retargeted here —
          no deploy needed. Choices are curated; each option shows its price and the evidence
          behind it.
        </p>
      </header>

      {feedback.saved ? (
        <div className="mb-4 rounded-panel bg-chip px-4 py-3 text-[12px]">
          {feedback.saved} model saved.{' '}
          {feedback.saved === 'Describer' || feedback.saved === 'Image model'
            ? 'It applies to the next categorised upload; existing photographs and versions stay unchanged.'
            : 'It applies from the next run; existing results stay unchanged.'}
        </div>
      ) : null}
      {feedback.error ? (
        <div className="mb-4 rounded-panel bg-chip px-4 py-3 text-[12px] text-red-700">
          {feedback.error}
        </div>
      ) : null}

      <PipelineDiagram stages={stages} action={setPipelineModelAction} />
    </main>
  )
}
