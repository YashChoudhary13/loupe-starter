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
  readonly url: string
  /**
   * The queue-grid thumbnail of the same version, shown while the full file
   * downloads. The full image is a ~2 MB PNG behind a presigned URL that
   * differs on every snapshot, so the browser almost never has it cached —
   * without a placeholder every open is seconds of black.
   */
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
  /** Which full-size URL has finished downloading; keyed by URL, not index. */
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)
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

  if (!open || !current) return null

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
        {action ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              action.onClick()
            }}
            className="ml-auto shrink-0 rounded-pill bg-white px-3.5 py-1.5 text-[12px] font-medium text-black transition-colors hover:bg-white/90 focus:outline-none focus-visible:shadow-[0_0_0_2px_white]"
          >
            {action.label}
          </button>
        ) : null}
        <button
          // Inside the editor's <form>, whose submit publishes the product.
          type="button"
          ref={closeRef}
          onClick={onClose}
          className={`${action ? '' : 'ml-auto '}shrink-0 rounded-pill bg-white/10 px-3.5 py-1.5 text-[12px] text-white transition-colors hover:bg-white/20 focus:outline-none focus-visible:shadow-[0_0_0_2px_white]`}
        >
          Close · Esc
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-5 pb-5">
        {images.length > 1 ? (
          <LightboxArrow side="left" onClick={() => step(-1)} />
        ) : null}

        <div className="relative h-full w-full">
          {current.thumbUrl && current.thumbUrl !== current.url && loadedUrl !== current.url ? (
            // eslint-disable-next-line @next/next/no-img-element -- presigned, short-lived, private-bucket URL.
            <img
              src={current.thumbUrl}
              alt=""
              aria-hidden
              className="absolute inset-0 m-auto max-h-full max-w-full object-contain blur-[1.5px]"
              onClick={(event) => event.stopPropagation()}
            />
          ) : null}
          {/* eslint-disable-next-line @next/next/no-img-element -- presigned, short-lived, private-bucket URL. */}
          <img
            src={current.url}
            alt={current.alt}
            onLoad={() => setLoadedUrl(current.url)}
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
