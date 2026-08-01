import 'server-only'

import { presetLabel, presetRank } from '@/lib/prompts/presets'
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
  /** Set when this version belongs to a saved style preset. */
  readonly presetSlug: string | null
}

/**
 * A style preset is a PAIR — one describer, one image prompt — and both change
 * together. Anything with only one half is not offered, because applying half a
 * preset leaves the two stages describing different products.
 */
export interface PromptPreset {
  readonly slug: string
  readonly name: string
  readonly isActive: boolean
}

export interface PromptLibrary {
  readonly describe: readonly PromptVersion[]
  readonly image: readonly PromptVersion[]
  readonly presets: readonly PromptPreset[]
}

export async function loadPromptLibrary(): Promise<PromptLibrary> {
  const { data, error } = await supabaseServer()
    .from('prompts')
    .select(
      'id, name, kind, body, model, is_default, created_by, created_at, archived_at, preset_slug',
    )
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
    presetSlug: (row.preset_slug as string | null) ?? null,
  }))

  return {
    describe: versions.filter((prompt) => prompt.kind === 'describe'),
    image: versions.filter((prompt) => prompt.kind === 'image'),
    presets: presetsFrom(versions),
  }
}

function presetsFrom(versions: readonly PromptVersion[]): readonly PromptPreset[] {
  const live = (kind: PromptKind) =>
    versions.find((v) => v.kind === kind && v.isDefault && v.archivedAt === null)?.presetSlug ??
    null
  const activeDescribe = live('describe')
  const activeImage = live('image')

  const slugs = new Map<string, { name: string; kinds: Set<PromptKind> }>()
  // Oldest first, so a preset takes its name from its original text rather than
  // from the copy a promotion left behind.
  for (const version of [...versions].reverse()) {
    if (!version.presetSlug) continue
    const entry = slugs.get(version.presetSlug) ?? {
      name: version.kind === 'image' ? version.name : version.presetSlug,
      kinds: new Set<PromptKind>(),
    }
    if (version.kind === 'image' && !entry.kinds.has('image')) entry.name = version.name
    entry.kinds.add(version.kind)
    slugs.set(version.presetSlug, entry)
  }

  return [...slugs.entries()]
    .filter(([, entry]) => entry.kinds.has('describe') && entry.kinds.has('image'))
    .map(([slug, entry]) => ({
      slug,
      name: presetLabel(slug) ?? entry.name,
      isActive: activeDescribe === slug && activeImage === slug,
    }))
    .sort((a, b) => presetRank(a.slug) - presetRank(b.slug) || a.slug.localeCompare(b.slug))
}
