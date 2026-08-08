'use client'

import { useCallback, useRef } from 'react'

import type { QueueTile } from '@/lib/console/types'
import { cn } from '@/lib/utils'

/**
 * The queue.
 *
 * Roving tabindex rather than twenty-plus tab stops: the whole grid is one stop,
 * and the arrow keys move inside it. That is the accessible listbox pattern and
 * it is also the only way the keyboard path stays usable at the density DESIGN.md
 * asks for — tabbing past forty tiles to reach the editor is not a keyboard-first
 * tool.
 *
 * Every tile is a thumbnail. The full image is never loaded here; the
 * enhancement worker writes a ~50 KB WebP beside each version precisely so this
 * grid costs about a megabyte instead of fifty.
 */

export interface QueueGridProps {
  readonly tiles: readonly QueueTile[]
  readonly selectedPhotoIds: ReadonlySet<string>
  readonly openDraftId: string | null
  readonly onTogglePhoto: (intakeFileId: string) => void
  readonly onOpenDraft: (draftId: string) => void
  readonly focusIndex: number
  readonly onFocusIndexChange: (index: number) => void
  readonly registerTile: (index: number, node: HTMLButtonElement | null) => void
  readonly ariaLabel?: string
  readonly emptyMessage?: string
}

export function QueueGrid({
  tiles,
  selectedPhotoIds,
  openDraftId,
  onTogglePhoto,
  onOpenDraft,
  focusIndex,
  onFocusIndexChange,
  registerTile,
  ariaLabel = 'Photographs and drafts waiting for an operator',
  emptyMessage = 'Nothing is waiting. Enhanced photographs appear here as the worker finishes them.',
}: QueueGridProps) {
  const gridRef = useRef<HTMLDivElement>(null)

  const move = useCallback(
    (next: number) => {
      if (tiles.length === 0) return
      const clamped = Math.max(0, Math.min(tiles.length - 1, next))
      onFocusIndexChange(clamped)
      const node = gridRef.current?.querySelectorAll<HTMLButtonElement>('[data-tile]')[clamped]
      node?.focus()
    },
    [tiles.length, onFocusIndexChange],
  )

  /** Columns are computed from the rendered layout, so Up/Down follow what is on screen. */
  const columnCount = useCallback(() => {
    const nodes = gridRef.current?.querySelectorAll<HTMLButtonElement>('[data-tile]')
    if (!nodes || nodes.length === 0) return 1
    const top = nodes[0].offsetTop
    let count = 0
    for (const node of nodes) {
      if (node.offsetTop !== top) break
      count += 1
    }
    return Math.max(1, count)
  }, [])

  return (
    <div
      ref={gridRef}
      id="console-queue"
      role="listbox"
      aria-multiselectable
      aria-label={ariaLabel}
      className="loupe-scroll grid min-h-0 flex-1 auto-rows-max content-start grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2.5 overflow-y-auto pr-1"
      onKeyDown={(event) => {
        const columns = columnCount()
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          move(focusIndex + 1)
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault()
          move(focusIndex - 1)
        } else if (event.key === 'ArrowDown') {
          event.preventDefault()
          move(focusIndex + columns)
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          move(focusIndex - columns)
        } else if (event.key === 'Home') {
          event.preventDefault()
          move(0)
        } else if (event.key === 'End') {
          event.preventDefault()
          move(tiles.length - 1)
        }
      }}
    >
      {tiles.map((tile, index) => {
        const selected =
          tile.kind === 'photo' ? selectedPhotoIds.has(tile.id) : openDraftId === tile.id

        return (
          <button
            key={`${tile.kind}:${tile.id}`}
            data-tile
            data-tile-kind={tile.kind}
            data-tile-id={tile.id}
            ref={(node) => registerTile(index, node)}
            type="button"
            role="option"
            aria-selected={selected}
            tabIndex={index === focusIndex ? 0 : -1}
            onFocus={() => onFocusIndexChange(index)}
            onClick={() =>
              tile.kind === 'photo' ? onTogglePhoto(tile.id) : onOpenDraft(tile.id)
            }
            title={tile.label}
            className={cn(
              'relative aspect-square overflow-hidden rounded-tile border-2 bg-chip transition-transform',
              selected ? 'border-ink' : 'border-transparent',
              'hover:-translate-y-0.5',
            )}
          >
            {tile.thumb ? (
              // eslint-disable-next-line @next/next/no-img-element -- presigned, short-lived, private-bucket URL: Next's optimiser would cache it past its expiry.
              <img
                src={tile.thumb.url}
                alt=""
                loading="lazy"
                decoding="async"
                className="absolute inset-0 size-full object-cover"
              />
            ) : (
              <span className="absolute inset-0 grid place-items-center text-[10px] text-muted-foreground">
                no image
              </span>
            )}

            <span className="absolute bottom-2 left-2 max-w-[calc(100%-16px)] truncate rounded-pill bg-white/[0.92] px-2 py-0.5 text-[10px] font-medium">
              {tile.kind === 'draft' ? (tile.reservedSku ?? tile.categoryName ?? 'Product') : tile.label}
            </span>

            {tile.imageCount > 1 ? (
              <span className="absolute right-2 top-2 grid size-[17px] place-items-center rounded-full bg-ink text-[9px] font-semibold text-white">
                {tile.imageCount}
              </span>
            ) : null}

            {tile.attention ? (
              <span
                className="absolute right-2 top-2 size-2 rounded-full bg-amber ring-2 ring-white"
                title={tile.attention}
                aria-label={tile.attention}
              />
            ) : null}
          </button>
        )
      })}

      {tiles.length === 0 ? (
        <p className="col-span-full py-10 text-center text-[12.5px] text-muted-foreground">
          {emptyMessage}
        </p>
      ) : null}
    </div>
  )
}
