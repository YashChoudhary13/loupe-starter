'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  beginRawUploadAction,
  finalizeRawUploadAction,
} from '@/app/(shell)/upload/actions'
import {
  PROMPT_CATEGORY_CORES,
  promptSetting,
  settingsForCategory,
} from '@/lib/prompts/matrix'
import { cn } from '@/lib/utils'

import { putUploadedObject } from './put-object'

const DEFAULTS_KEY = 'loupe.upload.defaults.v1'
const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp'])

type FileState = 'pending' | 'uploading' | 'verifying' | 'queued' | 'failed'

interface UploadFile {
  readonly key: string
  readonly file: File
  readonly previewUrl: string
  readonly name: string
  readonly categorySlug: string
  readonly settingSlug: string
  readonly progress: number
  readonly state: FileState
  readonly detail: string | null
}

function readDefaults(): { categorySlug: string; settingSlug: string } {
  try {
    const raw = window.localStorage.getItem(DEFAULTS_KEY)
    if (raw) return JSON.parse(raw) as { categorySlug: string; settingSlug: string }
  } catch {
    // First visit or a locked-down browser — the empty default is fine.
  }
  return { categorySlug: '', settingSlug: '' }
}

/**
 * D103 — raw photographs straight into the AI pipeline, no Google Drive.
 * Each photograph carries its own category + setting prompt choice; leaving
 * the choice empty runs the current default pair, exactly like a Drive drop.
 */
export function UploadScreen() {
  const [files, setFiles] = useState<readonly UploadFile[]>([])
  // Lazy initialiser so the sticky defaults read happens once, client-side,
  // without a cascading second render from an effect.
  const [defaults, setDefaults] = useState(() =>
    typeof window === 'undefined' ? { categorySlug: '', settingSlug: '' } : readDefaults(),
  )
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const previewUrls = useRef(new Set<string>())

  useEffect(() => {
    const urls = previewUrls.current
    return () => {
      for (const url of urls) URL.revokeObjectURL(url)
    }
  }, [])

  const rememberDefaults = useCallback((next: { categorySlug: string; settingSlug: string }) => {
    setDefaults(next)
    try {
      window.localStorage.setItem(DEFAULTS_KEY, JSON.stringify(next))
    } catch {
      // Sticky defaults are a convenience, never a requirement.
    }
  }, [])

  const addFiles = useCallback(
    (incoming: readonly File[]) => {
      const usable = incoming.filter((file) => ACCEPTED.has(file.type))
      if (usable.length === 0) return
      setFiles((current) => [
        ...current,
        ...usable.map((file, index) => {
          const previewUrl = URL.createObjectURL(file)
          previewUrls.current.add(previewUrl)
          return {
            key: `${Date.now()}:${index}:${file.name}`,
            file,
            previewUrl,
            name: file.name,
            categorySlug: defaults.categorySlug,
            settingSlug: defaults.settingSlug,
            progress: 0,
            state: 'pending' as const,
            detail: null,
          }
        }),
      ])
    },
    [defaults],
  )

  const patch = useCallback((key: string, changes: Partial<UploadFile>) => {
    setFiles((current) =>
      current.map((item) => (item.key === key ? { ...item, ...changes } : item)),
    )
  }, [])

  const removeFile = useCallback((key: string) => {
    setFiles((current) => {
      const target = current.find((item) => item.key === key)
      if (target) {
        URL.revokeObjectURL(target.previewUrl)
        previewUrls.current.delete(target.previewUrl)
      }
      return current.filter((item) => item.key !== key)
    })
  }, [])

  const startAll = useCallback(async () => {
    const batch = files.filter((item) => item.state === 'pending' || item.state === 'failed')
    if (batch.length === 0) return
    for (const item of batch) patch(item.key, { state: 'uploading', progress: 0, detail: null })

    const queue = [...batch]
    await Promise.all(
      Array.from({ length: Math.min(3, queue.length) }, async () => {
        for (;;) {
          const item = queue.shift()
          if (!item) return
          try {
            const ticket = await beginRawUploadAction({
              filename: item.file.name,
              mimeType: item.file.type,
              bytes: item.file.size,
            })
            if (!ticket.ok) {
              patch(item.key, { state: 'failed', detail: ticket.error.message })
              continue
            }
            await putUploadedObject(
              ticket.data.uploadUrl,
              item.file,
              ticket.data.contentType,
              (percent) => patch(item.key, { progress: percent }),
            )
            patch(item.key, { state: 'verifying' })
            const finalised = await finalizeRawUploadAction({
              uploadId: ticket.data.uploadId,
              categorySlug: item.categorySlug || null,
              settingSlug: item.categorySlug && item.settingSlug ? item.settingSlug : null,
            })
            if (!finalised.ok) {
              patch(item.key, { state: 'failed', detail: finalised.error.message })
              continue
            }
            patch(item.key, { state: 'queued', progress: 100 })
          } catch (cause) {
            patch(item.key, {
              state: 'failed',
              detail: cause instanceof Error ? cause.message : String(cause),
            })
          }
        }
      }),
    )
  }, [files, patch])

  const pendingCount = files.filter(
    (item) => item.state === 'pending' || item.state === 'failed',
  ).length
  const queuedCount = files.filter((item) => item.state === 'queued').length
  const uploadingCount = files.filter(
    (item) => item.state === 'uploading' || item.state === 'verifying',
  ).length

  return (
    <main className="loupe-scroll flex min-h-0 min-w-0 flex-col gap-3.5 overflow-y-auto pr-1">
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-[26px] font-medium tracking-[-0.025em]">Upload</h1>
          <div className="text-[12px] text-muted-foreground">
            Raw photographs, straight into AI enhancement — no Drive folder needed.
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {queuedCount > 0 ? (
            <Link
              href="/tracking"
              className="rounded-pill bg-chip px-3.5 py-2 text-[11.5px] font-medium text-ink-soft transition-colors hover:bg-[#ebebeb]"
            >
              {queuedCount} in the pipeline — watch in Tracking
            </Link>
          ) : null}
          <button
            type="button"
            disabled={pendingCount === 0 || uploadingCount > 0}
            onClick={() => void startAll()}
            className="rounded-pill bg-ink px-4 py-2 text-[12px] font-medium text-white transition-colors hover:bg-[#242428] disabled:opacity-50"
          >
            {uploadingCount > 0
              ? `Uploading ${uploadingCount}…`
              : `Enhance ${pendingCount > 0 ? pendingCount : ''} ${pendingCount === 1 ? 'photo' : 'photos'}`}
          </button>
        </div>
      </div>

      {/* Batch defaults seed every newly added photograph. */}
      <div className="flex flex-wrap items-center gap-2 rounded-panel bg-surface p-3">
        <span className="loupe-label">Prompts for new photos</span>
        <select
          value={defaults.categorySlug}
          onChange={(event) =>
            rememberDefaults({ categorySlug: event.target.value, settingSlug: '' })
          }
          aria-label="Default category prompt"
          className="rounded-pill bg-chip px-3.5 py-2 text-[12px] text-ink outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset]"
        >
          <option value="">Current default prompts</option>
          {PROMPT_CATEGORY_CORES.map((core) => (
            <option key={core.slug} value={core.slug}>
              {core.label}
            </option>
          ))}
        </select>
        {defaults.categorySlug ? (
          <select
            value={defaults.settingSlug}
            onChange={(event) =>
              rememberDefaults({ ...defaults, settingSlug: event.target.value })
            }
            aria-label="Default setting prompt"
            className="rounded-pill bg-chip px-3.5 py-2 text-[12px] text-ink outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset]"
          >
            <option value="">Pick a setting…</option>
            {settingsForCategory(defaults.categorySlug).map((setting) => (
              <option key={setting.slug} value={setting.slug}>
                {setting.label}
              </option>
            ))}
          </select>
        ) : null}
        <span className="text-[11px] text-muted-foreground">
          Category decides how the piece is protected and posed; setting decides the scene.
          Each photo can still be changed below before enhancing.
        </span>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        className="sr-only"
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []))
          event.target.value = ''
        }}
      />

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          addFiles(Array.from(event.dataTransfer.files ?? []))
        }}
        className={cn(
          'grid min-h-28 place-items-center rounded-card border-2 border-dashed text-[12.5px] transition-colors',
          dragging
            ? 'border-ink bg-chip text-ink'
            : 'border-[#d9d9de] bg-surface text-muted-foreground hover:border-ink-soft hover:text-ink-soft',
        )}
      >
        Drop JPEG, PNG or WebP photographs here — or click to choose. Up to 50 MB each.
      </button>

      {files.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
          {files.map((item) => {
            const settings = item.categorySlug ? settingsForCategory(item.categorySlug) : []
            return (
              <div
                key={item.key}
                className="flex flex-col gap-2.5 rounded-panel bg-surface p-3"
              >
                <div className="flex items-start gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
                  <img
                    src={item.previewUrl}
                    alt={item.name}
                    className="size-20 shrink-0 rounded-tile object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[11px] text-ink-soft">{item.name}</div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {(item.file.size / 1_000_000).toFixed(1)} MB
                    </div>
                    <div className="mt-2">
                      {item.state === 'pending' ? (
                        <span className="rounded-pill bg-chip px-2.5 py-1 text-[10.5px] text-ink-soft">
                          ready to enhance
                        </span>
                      ) : item.state === 'uploading' ? (
                        <span className="flex items-center gap-2">
                          <span className="relative h-1.5 w-24 overflow-hidden rounded-pill bg-chip">
                            <span
                              className="absolute inset-y-0 left-0 rounded-pill bg-ink transition-[width] duration-200"
                              style={{ width: `${item.progress}%` }}
                            />
                          </span>
                          <span className="text-[10.5px] tabular-nums text-muted-foreground">
                            {item.progress}%
                          </span>
                        </span>
                      ) : item.state === 'verifying' ? (
                        <span className="rounded-pill bg-chip px-2.5 py-1 text-[10.5px] text-ink-soft">
                          verifying…
                        </span>
                      ) : item.state === 'queued' ? (
                        <span className="rounded-pill bg-ink px-2.5 py-1 text-[10.5px] font-medium text-white">
                          ✓ queued for AI
                        </span>
                      ) : (
                        <span
                          className="rounded-pill bg-[#faf2e4] px-2.5 py-1 text-[10.5px] text-amber"
                          title={item.detail ?? undefined}
                        >
                          failed — press Enhance to retry
                        </span>
                      )}
                    </div>
                  </div>
                  {item.state === 'pending' || item.state === 'failed' ? (
                    <button
                      type="button"
                      aria-label={`Remove ${item.name}`}
                      onClick={() => removeFile(item.key)}
                      className="grid size-6 shrink-0 place-items-center rounded-full bg-chip text-[11px] text-ink-soft hover:bg-[#e6e6e6]"
                    >
                      ×
                    </button>
                  ) : null}
                </div>

                {item.state === 'pending' || item.state === 'failed' ? (
                  <div className="flex flex-wrap gap-1.5">
                    <select
                      value={item.categorySlug}
                      onChange={(event) =>
                        patch(item.key, { categorySlug: event.target.value, settingSlug: '' })
                      }
                      aria-label={`Category prompt for ${item.name}`}
                      className="min-w-0 flex-1 rounded-pill bg-chip px-3 py-1.5 text-[11px] text-ink outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset]"
                    >
                      <option value="">Default prompts</option>
                      {PROMPT_CATEGORY_CORES.map((core) => (
                        <option key={core.slug} value={core.slug}>
                          {core.label}
                        </option>
                      ))}
                    </select>
                    {item.categorySlug ? (
                      <select
                        value={item.settingSlug}
                        onChange={(event) => patch(item.key, { settingSlug: event.target.value })}
                        aria-label={`Setting prompt for ${item.name}`}
                        className="min-w-0 flex-1 rounded-pill bg-chip px-3 py-1.5 text-[11px] text-ink outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset]"
                      >
                        <option value="">Pick a setting…</option>
                        {settings.map((setting) => (
                          <option key={setting.slug} value={setting.slug} title={setting.note}>
                            {setting.label}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </div>
                ) : item.categorySlug ? (
                  <div className="text-[10.5px] text-muted-foreground">
                    {PROMPT_CATEGORY_CORES.find((core) => core.slug === item.categorySlug)?.label}
                    {item.settingSlug
                      ? ` · ${promptSetting(item.settingSlug)?.label ?? item.settingSlug}`
                      : ''}
                  </div>
                ) : (
                  <div className="text-[10.5px] text-muted-foreground">Default prompts</div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <p className="py-8 text-center text-[12px] text-muted-foreground">
          Photographs you add appear here with their prompt choice before anything runs.
        </p>
      )}
    </main>
  )
}
