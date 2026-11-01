'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The full-size review of a photograph.
 *
 * This exists because of who Qimati sells to: retailers zoom into a photograph
 * to judge build quality before staking their own reputation on the piece
 * (docs/CONTEXT.md). The operator is the last person who can catch a generated
 * image that has invented a chain link or a stone, and they cannot do that in a
 * 4:3 panel beside the price field.
 *
 * Two details that are load-bearing rather than cosmetic:
 *
 *   1. Escape must close the lightbox and NOTHING ELSE. The console already
 *      listens for Escape on `window` to abandon a photograph selection, so a
 *      naive listener here would close the image AND silently discard what the
 *      operator had selected. This listener runs in the capture phase and calls
 *      stopImmediatePropagation(), so while the lightbox is open it is the only
 *      thing that sees the key.
 *   2. Focus returns to whatever opened it. The queue is driven by keyboard
 *      (Phase 4 criterion 16); dropping focus to <body> on close would strand a
 *      keyboard operator mid-product.
 */

export interface LightboxImage {
  /** The exact stored bytes, ~2 MB for a render. Shown only after **Full size**. */
  readonly url: string
  /**
   * The 1280 px preview of the same version (D165), what the lightbox opens on.
   * Stable URL, so after the first open the browser has it. Absent for the
   * screens that still pass presigned URLs; `url` is shown directly then.
   */
  readonly previewUrl?: string | null
  /** The queue-grid thumbnail, shown blurred while the preview downloads. */
  readonly thumbUrl: string | null
  readonly alt: string
  readonly caption: string
}

export interface ImageLightboxProps {
  readonly images: readonly LightboxImage[]
  /** Index into `images`, or null when closed. */
  readonly index: number | null
  readonly onClose: () => void
  readonly onIndexChange: (index: number) => void
  /** One action for the image on screen (Identify: pick this candidate); omitted when there is none. */
  readonly action?: { readonly label: string; readonly onClick: () => void } | null
}

export function ImageLightbox({ images, index, onClose, onIndexChange, action }: ImageLightboxProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const returnFocusTo = useRef<Element | null>(null)
  /** Which URL has finished downloading; keyed by URL, not index. */
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)
  /** The image (by its full URL) whose exact bytes the operator asked for. */
  const [fullFor, setFullFor] = useState<string | null>(null)
  /** The full URL that failed to load; the button says so and offers it again. */
  const [fullFailed, setFullFailed] = useState<string | null>(null)
  const open = index !== null && images.length > 0
  const current = open ? images[index] : undefined

  const step = useCallback(
    (delta: number) => {
      if (index === null || images.length < 2) return
      onIndexChange((index + delta + images.length) % images.length)
    },
    [images.length, index, onIndexChange],
  )

  useEffect(() => {
    if (!open) return

    returnFocusTo.current = document.activeElement
    closeRef.current?.focus({ preventScroll: true })

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        // Capture phase + stopImmediatePropagation: the console's own Escape
        // handler must not also clear the operator's selection.
        event.stopImmediatePropagation()
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        step(1)
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        step(-1)
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = previousOverflow
      const target = returnFocusTo.current
      if (target instanceof HTMLElement && target.isConnected) {
        target.focus({ preventScroll: true })
      }
    }
  }, [onClose, open, step])

  /** The neighbours' previews are stable URLs: fetched once here, they open from cache. A caller with no previews (presigned originals) gets no prefetch. */
  useEffect(() => {
    if (index === null || images.length < 2) return
    for (const delta of [-1, 1]) {
      const neighbour = images[(index + delta + images.length) % images.length]
      if (neighbour.previewUrl) new Image().src = neighbour.previewUrl
    }
  }, [images, index])

  if (!open || !current) return null

  const hasPreview = Boolean(current.previewUrl) && current.previewUrl !== current.url
  const showFull = !hasPreview || fullFor === current.url
  const display = showFull ? current.url : current.previewUrl!
  // What sits underneath until `display` has loaded: the preview under the full file, the thumb under the preview.
  const under = showFull && hasPreview ? current.previewUrl! : current.thumbUrl

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-black/92 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`${current.caption} — full size`}
      onClick={onClose}
    >
      <div className="flex shrink-0 items-center gap-3 px-5 py-4 text-white">
        <p className="min-w-0 truncate font-mono text-[12px] text-white/70">{current.caption}</p>
        {images.length > 1 ? (
          <span className="shrink-0 rounded-pill bg-white/10 px-2.5 py-1 text-[11px] text-white/70">
            {index + 1} of {images.length}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {hasPreview ? (
            <button
              type="button"
              disabled={showFull}
              onClick={(event) => {
                event.stopPropagation()
                setFullFor(current.url)
              }}
              className="rounded-pill bg-white/10 px-3.5 py-1.5 text-[12px] text-white transition-colors hover:bg-white/20 focus:outline-none focus-visible:shadow-[0_0_0_2px_white] disabled:text-white/60 disabled:hover:bg-white/10"
            >
              {!showFull ? (fullFailed === current.url ? 'Full size did not load · Try again' : 'Full size') : loadedUrl === current.url ? 'Full size shown' : 'Loading full size…'}
            </button>
          ) : null}
          {action ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                action.onClick()
              }}
              className="rounded-pill bg-white px-3.5 py-1.5 text-[12px] font-medium text-black transition-colors hover:bg-white/90 focus:outline-none focus-visible:shadow-[0_0_0_2px_white]"
            >
              {action.label}
            </button>
          ) : null}
          <button
            // Inside the editor's <form>, whose submit publishes the product.
            type="button"
            ref={closeRef}
            onClick={onClose}
            className="rounded-pill bg-white/10 px-3.5 py-1.5 text-[12px] text-white transition-colors hover:bg-white/20 focus:outline-none focus-visible:shadow-[0_0_0_2px_white]"
          >
            Close · Esc
          </button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-5 pb-5">
        {images.length > 1 ? (
          <LightboxArrow side="left" onClick={() => step(-1)} />
        ) : null}

        <div className="relative h-full w-full">
          {under && under !== display && loadedUrl !== display ? (
            // eslint-disable-next-line @next/next/no-img-element -- Loupe's own authenticated image route (D165); the optimiser would re-encode a private picture.
            <img
              src={under}
              alt=""
              aria-hidden
              className={`absolute inset-0 m-auto max-h-full max-w-full object-contain${under === current.thumbUrl ? ' blur-[1.5px]' : ''}`}
              onClick={(event) => event.stopPropagation()}
            />
          ) : null}
          {/* eslint-disable-next-line @next/next/no-img-element -- Loupe's own authenticated image route (D165); the optimiser would re-encode a private picture. */}
          <img
            src={display}
            alt={current.alt}
            onLoad={() => setLoadedUrl(display)}
            onError={() => {
              // A failed full file goes back to the preview; the button offers it again.
              if (!hasPreview || display !== current.url) return
              setFullFor(null)
              setFullFailed(current.url)
            }}
            className="absolute inset-0 m-auto max-h-full max-w-full object-contain"
            // The backdrop closes; the image itself must not.
            onClick={(event) => event.stopPropagation()}
          />
        </div>

        {images.length > 1 ? <LightboxArrow side="right" onClick={() => step(1)} /> : null}
      </div>
    </div>
  )
}

function LightboxArrow({
  side,
  onClick,
}: {
  readonly side: 'left' | 'right'
  readonly onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={side === 'left' ? 'Previous photograph' : 'Next photograph'}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={`absolute top-1/2 z-10 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-[18px] text-white transition-colors hover:bg-white/20 focus:outline-none focus-visible:shadow-[0_0_0_2px_white] ${
        side === 'left' ? 'left-4' : 'right-4'
      }`}
    >
      {side === 'left' ? '‹' : '›'}
    </button>
  )
}
