'use client'

import { useEffect, useRef, useState } from 'react'

/** One deliberate camera activation counts at most one package, even across repeated frames. */
export function CameraScan({ onCode }: { onCode: (code: string) => void }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const video = useRef<HTMLVideoElement>(null)
  const callback = useRef(onCode)
  useEffect(() => { callback.current = onCode }, [onCode])
  useEffect(() => {
    if (!open) return
    let cancelled = false
    let consumed = false
    let controls: { stop: () => void } | undefined
    const element = video.current
    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia || !element) throw new Error('Camera scanning needs HTTPS and camera access. You can also use a USB scanner or enter the code.')
        const { BrowserMultiFormatReader } = await import('@zxing/browser')
        if (cancelled) return
        controls = await new BrowserMultiFormatReader().decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } }, audio: false }, element, (result, _error, scanner) => {
          if (cancelled || consumed || !result) return
          consumed = true; scanner.stop(); setOpen(false)
          callback.current(result.getText())
        })
        if (cancelled || consumed) controls.stop()
      } catch (cause) {
        if (!cancelled) { setError(cause instanceof Error ? cause.message : 'Could not open the camera. Check browser camera permission.'); setOpen(false) }
      }
    }
    void start()
    return () => {
      cancelled = true; controls?.stop()
      const stream = element?.srcObject
      if (stream instanceof MediaStream) stream.getTracks().forEach(track => track.stop())
    }
  }, [open])
  return <div className="mt-3">
    <button type="button" onClick={() => { setError(''); setOpen(!open) }} className="rounded-pill bg-chip px-4 py-2 text-[12px] focus-visible:outline-2">{open ? 'Close camera' : 'Scan one pouch with camera'}</button>
    {open && <div className="mt-3 max-w-md"><video ref={video} muted playsInline className="aspect-[4/3] w-full rounded-panel bg-ink object-cover" aria-label="Barcode camera preview" /><p className="mt-2 text-[12px] text-ink-soft">Point at one QR or barcode. After acceptance, move that pouch and tap again for the next one.</p></div>}
    {error && <p role="alert" className="mt-2 text-[12px] text-amber">{error}</p>}
  </div>
}
