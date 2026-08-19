'use client'

import { useMemo, useState } from 'react'

import { useCategorySettingAction } from '@/app/(shell)/prompts/actions'
import {
  composeClientPair,
  PROMPT_CATEGORY_CORES,
  PROMPT_MEASUREMENTS,
  promptSetting,
  settingsForCategory,
} from '@/lib/prompts/matrix'
import { cn } from '@/lib/utils'

/**
 * D104 — prompts as two human choices instead of a version-history wall.
 *
 * Step 1: which kind of piece (the category core carries every hard-won
 * protection rule for that construction). Step 2: which scene (a pure
 * background/light paragraph from the owner's reference boards). Step 3:
 * whether the finished photograph carries dimension callouts read off a ruler
 * placed beside the piece in the raw upload. The viewer below shows the exact
 * describer and image prompt the combination produces — what "Use for new
 * batches" will make current.
 */
export function PromptMatrix({ activePairSlug }: { activePairSlug: string | null }) {
  const activeParts = activePairSlug?.split('--') ?? []
  const [categorySlug, setCategorySlug] = useState<string>(activeParts[0] ?? '')
  const [settingSlug, setSettingSlug] = useState<string>(activeParts[1] ?? '')
  // An unmeasured pair has no third slug part, which is exactly what 'plain' is.
  const [measurementSlug, setMeasurementSlug] = useState<string>(activeParts[2] ?? 'plain')

  const settings = categorySlug ? settingsForCategory(categorySlug) : []
  const pair = useMemo(
    () =>
      categorySlug && settingSlug
        ? composeClientPair(categorySlug, settingSlug, measurementSlug)
        : null,
    [categorySlug, settingSlug, measurementSlug],
  )
  const isActive = pair !== null && activePairSlug === pair.slug

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-card bg-surface p-5">
        <h2 className="loupe-label">1 · Category prompt</h2>
        <p className="mt-1 text-[11.5px] text-muted-foreground">
          How the piece is protected and posed — scale, construction, what may never be invented.
        </p>
        <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2">
          {PROMPT_CATEGORY_CORES.map((core) => (
            <button
              key={core.slug}
              type="button"
              aria-pressed={core.slug === categorySlug}
              title={core.note}
              onClick={() => {
                setCategorySlug(core.slug)
                setSettingSlug('')
              }}
              className={cn(
                'rounded-panel px-3.5 py-3 text-left transition-all duration-150',
                core.slug === categorySlug
                  ? 'bg-ink text-white shadow-sm'
                  : 'bg-chip text-ink-soft hover:-translate-y-0.5 hover:bg-[#ebebeb]',
              )}
            >
              <div className="text-[12.5px] font-medium">{core.label}</div>
              <div
                className={cn(
                  'mt-1 line-clamp-2 text-[10.5px] leading-snug',
                  core.slug === categorySlug ? 'text-white/70' : 'text-muted-foreground',
                )}
              >
                {core.note}
              </div>
            </button>
          ))}
        </div>
      </section>

      {categorySlug ? (
        <section className="rounded-card bg-surface p-5">
          <h2 className="loupe-label">2 · Setting</h2>
          <p className="mt-1 text-[11.5px] text-muted-foreground">
            The scene: surface, palette, light. Ordered by what flatters{' '}
            {PROMPT_CATEGORY_CORES.find((core) => core.slug === categorySlug)?.label.toLowerCase()}.
          </p>
          <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
            {settings.map((setting) => (
              <button
                key={setting.slug}
                type="button"
                aria-pressed={setting.slug === settingSlug}
                onClick={() => setSettingSlug(setting.slug)}
                className={cn(
                  'rounded-panel px-3.5 py-3 text-left transition-all duration-150',
                  setting.slug === settingSlug
                    ? 'bg-ink text-white shadow-sm'
                    : 'bg-chip text-ink-soft hover:-translate-y-0.5 hover:bg-[#ebebeb]',
                )}
              >
                <div className="text-[12.5px] font-medium">{setting.label}</div>
                <div
                  className={cn(
                    'mt-1 line-clamp-2 text-[10.5px] leading-snug',
                    setting.slug === settingSlug ? 'text-white/70' : 'text-muted-foreground',
                  )}
                >
                  {setting.note}
                </div>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {categorySlug && settingSlug ? (
        <section className="rounded-card bg-surface p-5">
          <h2 className="loupe-label">3 · Measurements</h2>
          <p className="mt-1 text-[11.5px] text-muted-foreground">
            Whether the finished photograph carries dimension callouts. Measured needs a ruler
            or scale bar lying beside the piece in the raw photograph, flat and in the same
            plane; the describer reads it and the image stage prints those figures.
          </p>
          <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
            {PROMPT_MEASUREMENTS.map((measurement) => (
              <button
                key={measurement.slug}
                type="button"
                aria-pressed={measurement.slug === measurementSlug}
                onClick={() => setMeasurementSlug(measurement.slug)}
                className={cn(
                  'rounded-panel px-3.5 py-3 text-left transition-all duration-150',
                  measurement.slug === measurementSlug
                    ? 'bg-ink text-white shadow-sm'
                    : 'bg-chip text-ink-soft hover:-translate-y-0.5 hover:bg-[#ebebeb]',
                )}
              >
                <div className="text-[12.5px] font-medium">{measurement.label}</div>
                <div
                  className={cn(
                    'mt-1 text-[10.5px] leading-snug',
                    measurement.slug === measurementSlug
                      ? 'text-white/70'
                      : 'text-muted-foreground',
                  )}
                >
                  {measurement.note}
                </div>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {pair ? (
        <section className="rounded-card bg-surface p-5">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <h2 className="text-[14px] font-medium">
                {pair.label}
              </h2>
              <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                {promptSetting(settingSlug)?.note}
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {isActive ? (
                <span className="rounded-pill bg-green/10 px-3 py-1.5 text-[11px] font-medium text-green">
                  ✓ current for new batches
                </span>
              ) : (
                <form action={useCategorySettingAction}>
                  <input type="hidden" name="category" value={categorySlug} />
                  <input type="hidden" name="setting" value={settingSlug} />
                  <input type="hidden" name="measurement" value={measurementSlug} />
                  <button
                    type="submit"
                    className="rounded-pill bg-ink px-4 py-2 text-[12px] font-medium text-white transition-colors hover:bg-[#242428]"
                  >
                    Use for new batches
                  </button>
                </form>
              )}
            </div>
          </div>

          <div className="mt-4 grid gap-3.5 xl:grid-cols-2">
            <div>
              <h3 className="loupe-label">Describer prompt</h3>
              <pre className="loupe-scroll mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-panel bg-chip p-3.5 font-mono text-[10.5px] leading-relaxed text-ink-soft">
                {pair.describeBody}
              </pre>
            </div>
            <div>
              <h3 className="loupe-label">Image prompt</h3>
              <pre className="loupe-scroll mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-panel bg-chip p-3.5 font-mono text-[10.5px] leading-relaxed text-ink-soft">
                {pair.imageBody}
              </pre>
            </div>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            “Use for new batches” makes this pair current for everything uploaded from now on —
            Drive and Upload alike. Photographs given their own prompts in Upload keep them.
            Everything already enhanced stays unchanged.
          </p>
        </section>
      ) : null}
    </div>
  )
}
