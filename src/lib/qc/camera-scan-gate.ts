export type CameraFrame = { kind: 'code'; value: string } | { kind: 'empty' | 'unreadable' }
export type CameraScanState = 'ready' | 'steady' | 'remove' | 'paused'

/** Decoder-level repeat protection; an unreadable label is not proof of pouch removal. */
export class CameraScanGate {
  private needsClear = false
  private clearSince: number | null = null
  private clearFrames = 0
  private candidate: string | null = null
  private candidateSince = 0
  private lastFrameAt: number | null = null

  private resetMeasurements() {
    this.clearSince = null
    this.clearFrames = 0
    this.candidate = null
  }

  pause() {
    this.needsClear = true
    this.resetMeasurements()
  }

  observe(frame: CameraFrame, now: number, paused = false): { state: CameraScanState; code?: string } {
    // Suspended tabs and delayed frames cannot prove a continuously clear view.
    if (this.lastFrameAt !== null && (now - this.lastFrameAt > 1500 || now < this.lastFrameAt)) this.resetMeasurements()
    this.lastFrameAt = now
    if (paused) { this.pause(); return { state: 'paused' } }

    if (this.needsClear) {
      this.candidate = null
      if (frame.kind !== 'empty') { this.resetMeasurements(); return { state: 'remove' } }
      this.clearSince ??= now
      this.clearFrames++
      if (now - this.clearSince >= 900 && this.clearFrames >= 4) {
        this.needsClear = false
        this.resetMeasurements()
        return { state: 'ready' }
      }
      return { state: 'remove' }
    }

    if (frame.kind !== 'code') { this.candidate = null; return { state: 'ready' } }
    if (this.candidate !== frame.value) {
      this.candidate = frame.value
      this.candidateSince = now
      return { state: 'steady' }
    }
    if (now - this.candidateSince < 150) return { state: 'steady' }

    // Latch synchronously, before React can render the pending server request.
    this.pause()
    return { state: 'remove', code: frame.value }
  }
}
