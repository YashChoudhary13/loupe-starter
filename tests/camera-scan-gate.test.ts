import { describe, expect, it } from 'vitest'
import { CameraScanGate, type CameraFrame } from '@/lib/qc/camera-scan-gate'

const code = (value = 'KD1333-C-GOLD-S-7'): CameraFrame => ({ kind: 'code', value })
const empty: CameraFrame = { kind: 'empty' }
const unreadable: CameraFrame = { kind: 'unreadable' }
function scan(gate: CameraScanGate, start = 0, value?: string) {
  expect(gate.observe(code(value), start).code).toBeUndefined()
  return gate.observe(code(value), start + 200)
}
function clear(gate: CameraScanGate, start: number, paused = false) {
  return Array.from({ length: 10 }, (_, i) => gate.observe(empty, start + i * 100, paused)).at(-1)!
}

describe('continuous camera scan gate', () => {
  it('waits for a stable code before counting and latches immediately', () => {
    const gate = new CameraScanGate()
    expect(gate.observe(code(), 0).state).toBe('steady')
    expect(gate.observe(code(), 100).code).toBeUndefined()
    expect(gate.observe(code(), 200).code).toBe('KD1333-C-GOLD-S-7')
    for (let t = 201; t < 30000; t += 100) expect(gate.observe(code(), t).code).toBeUndefined()
  })
  it('allows the same variant on the next pouch after a clear interval', () => {
    const gate = new CameraScanGate(); scan(gate)
    expect(clear(gate, 300).state).toBe('ready')
    expect(scan(gate, 1300).code).toBe('KD1333-C-GOLD-S-7')
  })
  it('also requires removal before a different code can count', () => {
    const gate = new CameraScanGate(); scan(gate)
    for (let t = 300; t < 3000; t += 100) expect(gate.observe(code('OTHER'), t).code).toBeUndefined()
    expect(clear(gate, 3000).state).toBe('ready')
    expect(scan(gate, 4000, 'OTHER').code).toBe('OTHER')
  })
  it('does not rearm from brief decode failures or unreadable frames', () => {
    const gate = new CameraScanGate(); scan(gate)
    for (let t = 300; t < 1000; t += 100) gate.observe(empty, t)
    expect(gate.observe(unreadable, 1000).state).toBe('remove')
    for (let t = 1100; t < 1900; t += 100) expect(gate.observe(empty, t).state).toBe('remove')
    expect(gate.observe(code(), 1900).code).toBeUndefined()
  })
  it('ignores frames while QC is pending and requires fresh clearance after it resumes', () => {
    const gate = new CameraScanGate(); scan(gate)
    expect(clear(gate, 300, true).state).toBe('paused')
    expect(gate.observe(code('OTHER'), 1300, true).code).toBeUndefined()
    expect(gate.observe(code('OTHER'), 1400).state).toBe('remove')
    expect(clear(gate, 1500).state).toBe('ready')
    expect(scan(gate, 2500, 'OTHER').code).toBe('OTHER')
  })
  it('cannot treat a suspended decoder or hidden tab as a clear interval', () => {
    const gate = new CameraScanGate(); scan(gate)
    gate.observe(empty, 300)
    expect(gate.observe(empty, 10000).state).toBe('remove')
    expect(gate.observe(code(), 10100).code).toBeUndefined()
    gate.pause()
    expect(gate.observe(code(), 10200).code).toBeUndefined()
  })
  it('works with slower decoding while still requiring four clear frames', () => {
    const gate = new CameraScanGate()
    gate.observe(code(), 0)
    expect(gate.observe(code(), 600).code).toBe('KD1333-C-GOLD-S-7')
    expect(gate.observe(empty, 1200).state).toBe('remove')
    expect(gate.observe(empty, 1800).state).toBe('remove')
    expect(gate.observe(empty, 2400).state).toBe('remove')
    expect(gate.observe(empty, 3000).state).toBe('ready')
    expect(scan(gate, 3600).code).toBe('KD1333-C-GOLD-S-7')
  })
  it('discards a partly recognised code after interruption or another code', () => {
    const gate = new CameraScanGate()
    gate.observe(code(), 0); gate.observe(unreadable, 100)
    expect(gate.observe(code(), 200).code).toBeUndefined()
    expect(gate.observe(code('OTHER'), 300).code).toBeUndefined()
    expect(gate.observe(code(), 400).code).toBeUndefined()
    expect(gate.observe(code(), 2000).code).toBeUndefined()
    expect(gate.observe(code(), 2200).code).toBe('KD1333-C-GOLD-S-7')
  })
})
