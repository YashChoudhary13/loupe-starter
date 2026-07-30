import 'server-only'

import { supabaseServer } from '@/lib/supabase/server'

export type PromptKind = 'describe' | 'image'

export interface PromptVersion {
  readonly id: string
  readonly name: string
  readonly kind: PromptKind
  readonly body: string
  readonly model: string
  readonly isDefault: boolean
  readonly createdBy: string | null
  readonly createdAt: string
  readonly archivedAt: string | null
}

export interface PromptLibrary {
  readonly describe: readonly PromptVersion[]
  readonly image: readonly PromptVersion[]
}

export async function loadPromptLibrary(): Promise<PromptLibrary> {
  const { data, error } = await supabaseServer()
    .from('prompts')
    .select('id, name, kind, body, model, is_default, created_by, created_at, archived_at')
    .in('kind', ['describe', 'image'])
    .order('created_at', { ascending: false })

  if (error) throw new Error(`prompts: ${error.message}`)

  const versions = (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    kind: row.kind as PromptKind,
    body: row.body as string,
    model: row.model as string,
    isDefault: row.is_default as boolean,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: row.created_at as string,
    archivedAt: (row.archived_at as string | null) ?? null,
  }))

  return {
    describe: versions.filter((prompt) => prompt.kind === 'describe'),
    image: versions.filter((prompt) => prompt.kind === 'image'),
  }
}
