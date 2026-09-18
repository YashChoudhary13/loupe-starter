'use client'

import { useEffect, useRef, useState } from 'react'
import { CameraScanGate, type CameraScanState } from '@/lib/qc/camera-scan-gate'

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
        const [{ BrowserMultiFormatReader }, { NotFoundException, ChecksumException, FormatException }] = await Promise.all([import('@zxing/browser'), import('@zxing/library')])
        if (cancelled) return
        const reader = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 100, delayBetweenScanSuccess: 100 })
        controls = await reader.decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } }, audio: false }, element, (result, decodeError, scanner) => {
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
  return <div className="mt-3">
    <button type="button" disabled={!open && paused} onClick={() => { setError(''); setState('starting'); remember(!open); setOpen(!open) }} className="rounded-pill bg-chip px-4 py-2 text-[12px] focus-visible:outline-2 disabled:opacity-40">{open ? 'Stop camera' : 'Use phone camera instead'}</button>
    {open && <div className="mt-3 max-w-md"><p role="status" aria-live="polite" className="mb-2 rounded-panel bg-chip p-3 text-[13px] font-medium">{status}</p><video ref={video} muted playsInline className="aspect-[4/3] w-full rounded-panel bg-ink object-cover" aria-label="Barcode camera preview" /><p className="mt-2 text-[12px] text-ink-soft">The camera stays on. Show one label, wait for acceptance, then move the pouch into the checked box. Leave the view clear for about a second before the next pouch, even if its code is the same.</p></div>}
    {error && <p role="alert" className="mt-2 text-[12px] text-amber">{error}</p>}
  </div>
}
