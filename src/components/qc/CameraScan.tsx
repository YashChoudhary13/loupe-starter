'use client'

import { useEffect, useRef, useState } from 'react'
import { CameraScanGate, type CameraScanState } from '@/lib/qc/camera-scan-gate'
import type { DecodeHintType as HintType } from '@zxing/library'

const PREFERENCE = 'loupe.qc.camera'
/** Off unless this browser last chose the camera; the 2D scanner gun is the usual tool (D128). */
function preferredOpen(): boolean {
  try { return localStorage.getItem(PREFERENCE) === 'on' } catch { return false }
}
function remember(open: boolean): void {
  try { localStorage.setItem(PREFERENCE, open ? 'on' : 'off') } catch { /* private mode */ }
}

export function CameraScan({ onCode, paused, onOpenChange }: { onCode: (code: string) => void; paused: boolean; onOpenChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [state, setState] = useState<CameraScanState | 'starting'>('starting')
  const video = useRef<HTMLVideoElement>(null)
  const callback = useRef(onCode)
  const pausedRef = useRef(paused)
  const gate = useRef(new CameraScanGate())
  useEffect(() => { callback.current = onCode }, [onCode])
  // Browser-only preference after hydration; server rendering always starts closed.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (preferredOpen()) setOpen(true) }, [])
  useEffect(() => {
    pausedRef.current = paused
    if (paused) gate.current.pause()
  }, [paused])
  useEffect(() => {
    onOpenChange(open)
    return () => onOpenChange(false)
  }, [open, onOpenChange])
  useEffect(() => {
    if (!open) return
    let cancelled = false
    let controls: { stop: () => void } | undefined
    let cameraTrack: MediaStreamTrack | undefined
    const element = video.current
    gate.current = new CameraScanGate()
    const resetGate = () => gate.current.pause()
    const cameraFailed = () => {
      if (cancelled) return
      setError('Camera stopped. Check camera access, then start it again. Your QC counts are saved.')
      setOpen(false)
    }
    document.addEventListener('visibilitychange', resetGate)
    window.addEventListener('blur', resetGate)
    element?.addEventListener('error', cameraFailed)
    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia || !element) throw new Error('Camera scanning needs HTTPS and camera access. You can also use a USB scanner or enter the code.')
        const [{ BrowserMultiFormatReader }, { NotFoundException, ChecksumException, FormatException, BarcodeFormat, DecodeHintType }] = await Promise.all([import('@zxing/browser'), import('@zxing/library')])
        if (cancelled) return
        // Loupe prints QR (default) or Code 128 labels; trying every symbology on each frame only slows small-label decodes.
        const reader = new BrowserMultiFormatReader(new Map<HintType, unknown>([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE, BarcodeFormat.CODE_128]], [DecodeHintType.TRY_HARDER, true]]), { delayBetweenScanAttempts: 100, delayBetweenScanSuccess: 100 })
        // A 0.5 mm QR module is 1–2 px in the browser's default 640×480 stream; ask for 1080p so it is 4–5 px at 15 cm.
        controls = await reader.decodeFromConstraints({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }, element, (result, decodeError, scanner) => {
          if (cancelled) { scanner.stop(); return }
          if (decodeError && !(decodeError instanceof NotFoundException || decodeError instanceof ChecksumException || decodeError instanceof FormatException)) {
            scanner.stop(); cameraFailed(); return
          }
          const track = (element.srcObject as MediaStream | null)?.getVideoTracks()[0]
          if (track?.readyState === 'ended') { scanner.stop(); cameraFailed(); return }
          const frame = result ? { kind: 'code' as const, value: result.getText() } : { kind: decodeError instanceof NotFoundException ? 'empty' as const : 'unreadable' as const }
          const outcome = gate.current.observe(frame, performance.now(), pausedRef.current || document.visibilityState !== 'visible' || !track || track.muted || element.paused || element.readyState < 2)
          setState(outcome.state)
          if (outcome.code) callback.current(outcome.code)
        })
        if (cancelled) { controls.stop(); return }
        cameraTrack = (element.srcObject as MediaStream | null)?.getVideoTracks()[0]
        cameraTrack?.addEventListener('ended', cameraFailed)
        cameraTrack?.addEventListener('mute', resetGate)
        // Continuous focus (Android; iOS focuses by itself) and 2× zoom so a 10 mm label fills the frame from 15 cm, beyond the lens's
        // minimum focus distance. Each advanced set is skipped, not fatal, where the phone cannot satisfy it.
        const zoom = (cameraTrack?.getCapabilities?.() as { zoom?: { min: number; max: number } } | undefined)?.zoom
        const advanced: Record<string, unknown>[] = [{ focusMode: 'continuous' }]
        if (zoom && zoom.max > 1) advanced.push({ zoom: Math.min(2, zoom.max) })
        await cameraTrack?.applyConstraints({ advanced: advanced as MediaTrackConstraintSet[] }).catch(() => undefined)
      } catch (cause) {
        if (!cancelled) { setError(cause instanceof Error ? cause.message : 'Could not open the camera. Check browser camera permission.'); setOpen(false) }
      }
    }
    void start()
    return () => {
      cancelled = true; controls?.stop()
      document.removeEventListener('visibilitychange', resetGate)
      window.removeEventListener('blur', resetGate)
      element?.removeEventListener('error', cameraFailed)
      cameraTrack?.removeEventListener('ended', cameraFailed)
      cameraTrack?.removeEventListener('mute', resetGate)
      const stream = element?.srcObject
      if (typeof MediaStream !== 'undefined' && stream instanceof MediaStream) stream.getTracks().forEach(track => track.stop())
    }
  }, [open])
  const status = paused ? 'Scanning paused — wait for QC or follow the message above.' : {
    starting: 'Opening camera…', ready: 'Ready for the next pouch', steady: 'Hold the label steady…',
    remove: 'Remove this pouch from view. Wait for Ready before the next one.', paused: 'Waiting for a clear camera view…',
  }[state]
  const toggle = () => { setError(''); setState('starting'); remember(!open); setOpen(!open) }
  return <div className="mt-2">
    {!open && <button type="button" disabled={paused} onClick={toggle} className="rounded-pill bg-chip px-3 py-1.5 text-[12px] focus-visible:outline-2 disabled:opacity-40 md:px-4 md:py-2">Use phone camera instead</button>}
    {open && <div className="relative">
      {/* Status and Stop sit on the preview itself at every width, so the camera costs one short band, not three rows. */}
      <p role="status" aria-live="polite" className="absolute left-2 top-2 z-10 max-w-[70%] truncate rounded-pill bg-white/90 px-2.5 py-1 text-[11px] font-medium md:text-[12px]">{status}</p>
      <button type="button" onClick={toggle} aria-label="Stop camera" className="absolute right-2 top-2 z-10 rounded-pill bg-white/90 px-2.5 py-1 text-[11px] focus-visible:outline-2 md:text-[12px]">Stop</button>
      <video ref={video} muted playsInline className="h-36 w-full rounded-panel bg-ink object-cover md:h-44" aria-label="Barcode camera preview" />
    </div>}
    {error && <p role="alert" className="mt-2 text-[12px] text-amber">{error}</p>}
  </div>
}
