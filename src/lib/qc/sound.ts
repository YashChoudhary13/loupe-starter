/** Scan feedback tones, synthesized in the browser. No audio assets, no autoplay before a user gesture. */
export type QcTone = 'accept' | 'reject' | 'passed'

const TONES: Record<QcTone, { freq: number; ms: number; gap: number }[]> = {
  accept: [{ freq: 1046, ms: 70, gap: 20 }, { freq: 1568, ms: 110, gap: 0 }],
  reject: [{ freq: 220, ms: 180, gap: 60 }, { freq: 196, ms: 260, gap: 0 }],
  passed: [{ freq: 784, ms: 90, gap: 30 }, { freq: 988, ms: 90, gap: 30 }, { freq: 1319, ms: 220, gap: 0 }],
}

let context: AudioContext | undefined

/** Resolves false when the browser has no audio (or blocked it), so callers can fall back to vibration only. */
export async function playQcTone(tone: QcTone): Promise<boolean> {
  try {
    const Ctor = typeof window !== 'undefined' ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined
    if (!Ctor) return false
    context ??= new Ctor()
    if (context.state === 'suspended') await context.resume()
    if (context.state !== 'running') return false
    let at = context.currentTime
    for (const note of TONES[tone]) {
      const osc = context.createOscillator()
      const gain = context.createGain()
      osc.type = tone === 'reject' ? 'square' : 'sine'
      osc.frequency.value = note.freq
      gain.gain.setValueAtTime(0.0001, at)
      gain.gain.exponentialRampToValueAtTime(tone === 'reject' ? 0.25 : 0.4, at + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + note.ms / 1000)
      osc.connect(gain).connect(context.destination)
      osc.start(at); osc.stop(at + note.ms / 1000 + 0.02)
      at += (note.ms + note.gap) / 1000
    }
    return true
  } catch { return false }
}

export function vibrateQc(tone: QcTone): void {
  try { navigator.vibrate?.(tone === 'accept' ? 60 : tone === 'passed' ? [60, 40, 60, 40, 120] : [90, 60, 90]) } catch { /* unsupported */ }
}

/** Which tone an RPC outcome deserves; null for neutral history events. */
export function toneForOutcome(outcome: string | undefined): QcTone | null {
  if (!outcome) return null
  if (outcome === 'accepted' || outcome === 'removed' || outcome === 'short') return 'accept'
  if (outcome === 'passed') return 'passed'
  if (['rejected', 'extra', 'wrong', 'conflict', 'stale', 'blocked', 'incomplete', 'extras'].includes(outcome)) return 'reject'
  return null
}
