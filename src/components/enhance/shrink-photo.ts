/**
 * A phone camera hands over 12–16 MB per photograph; on mobile data that is a minute of upload each.
 * The enhancer works from a 4,096 px long edge (what the WhatsApp "HD" photos of every earlier batch
 * were), so the browser shrinks a large JPEG to that before it leaves the phone: about a fifth of the
 * bytes, the same detail the renders were built on. Anything it cannot decode goes up untouched.
 */
const MAX_EDGE = 4096
const QUALITY = 0.9
const LEAVE_ALONE_BELOW = 3_000_000

// One decode at a time: a 50 MP photograph is ~200 MB as a bitmap, and three at once can kill a phone tab.
let turn: Promise<unknown> = Promise.resolve()

/** `maxEdge` and `leaveAloneBelow` are the enhancer's by default; Find's parcel photographs (D173) ask for 2576 px and no lower limit. */
export function shrinkPhoto(file: File, maxEdge = MAX_EDGE, leaveAloneBelow = LEAVE_ALONE_BELOW): Promise<File> {
  const run = turn.then(() => shrink(file, maxEdge, leaveAloneBelow))
  turn = run.catch(() => undefined)
  return run
}

async function shrink(file: File, maxEdge: number, leaveAloneBelow: number): Promise<File> {
  if (file.type !== 'image/jpeg' || file.size <= leaveAloneBelow) return file
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    try {
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(bitmap.width * scale)
      canvas.height = Math.round(bitmap.height * scale)
      const context = canvas.getContext('2d')
      if (!context) return file
      context.imageSmoothingQuality = 'high'
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY))
      if (!blob || blob.size >= file.size) return file
      return new File([blob], file.name, { type: 'image/jpeg', lastModified: file.lastModified })
    } finally {
      bitmap.close()
    }
  } catch {
    return file
  }
}

const THUMB_EDGE = 320

/**
 * D170: a small JPEG of the photograph for the batch grid (about 15 KB), made on the phone so the
 * grid of a hundred photographs never loads a hundred full files. Null when the browser cannot decode it.
 */
export function photoThumb(file: File): Promise<Blob | null> {
  const run = turn.then(() => thumb(file))
  turn = run.catch(() => undefined)
  return run
}

async function thumb(file: File): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    try {
      const scale = Math.min(1, THUMB_EDGE / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const context = canvas.getContext('2d')
      if (!context) return null
      context.imageSmoothingQuality = 'high'
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72))
    } finally {
      bitmap.close()
    }
  } catch {
    return null
  }
}

/**
 * D179: the upload file and the tile's thumbnail from ONE decode, made in a worker. Before this a photograph was
 * decoded twice on the page (once to shrink, once more for the thumbnail) and the tile showed the full file, so sixty
 * picked photographs held sixty full-size previews: the phone ran out of memory and every later photograph failed.
 * The worker matters as much: a page encodes a canvas in its idle time, and a page that is drawing nothing (the
 * operator opened another section, or the tab is in the background) has almost none. Measured in Chrome: 0.1 s a
 * photograph in a worker, 2.2 s on a page that stands still.
 */
export function preparePhoto(file: File): Promise<{ file: File; thumb: Blob | null }> {
  const run = turn.then(() => prepare(file))
  turn = run.catch(() => undefined)
  return run
}

interface Prepared { readonly id: number; readonly big: Blob | null; readonly thumb: Blob | null }

// Plain JavaScript on purpose: it is handed to the worker as text, so no bundler has to know about it.
const WORKER = `
const jpeg = (bitmap, edge, quality) => {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height))
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)))
  const context = canvas.getContext('2d')
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas.convertToBlob({ type: 'image/jpeg', quality })
}
onmessage = async ({ data: { id, file, shrink, maxEdge, quality, thumbEdge } }) => {
  let big = null, thumb = null
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    try {
      thumb = await jpeg(bitmap, thumbEdge, 0.72)
      if (shrink) big = await jpeg(bitmap, maxEdge, quality)
    } finally { bitmap.close() }
  } catch {}
  postMessage({ id, big, thumb })
}`

let worker: Worker | null | undefined
let asked = 0

function inWorker(file: File, shrink: boolean): Promise<Prepared | null> {
  if (worker === undefined) {
    try {
      worker = typeof OffscreenCanvas === 'undefined' ? null : new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })))
    } catch { worker = null }
  }
  const w = worker
  if (!w) return Promise.resolve(null)
  const id = ++asked
  return new Promise((resolve) => {
    const done = (answer: Prepared | null) => { w.removeEventListener('message', heard); w.removeEventListener('error', broke); resolve(answer) }
    const heard = (event: MessageEvent<Prepared>) => { if (event.data.id === id) done(event.data) }
    // A worker that cannot start (an old browser, a blocked blob) is not tried again; the page does the work itself.
    const broke = () => { worker = null; done(null) }
    w.addEventListener('message', heard); w.addEventListener('error', broke)
    w.postMessage({ id, file, shrink, maxEdge: MAX_EDGE, quality: QUALITY, thumbEdge: THUMB_EDGE })
  })
}

async function prepare(file: File): Promise<{ file: File; thumb: Blob | null }> {
  const wanted = file.type === 'image/jpeg' && file.size > LEAVE_ALONE_BELOW
  const made = await inWorker(file, wanted)
  // No worker here: the two older functions, one after the other. Slower, same result.
  if (!made) return { file: await shrink(file, MAX_EDGE, LEAVE_ALONE_BELOW), thumb: await thumb(file) }
  if (!made.big || made.big.size >= file.size) return { file, thumb: made.thumb }
  return { file: new File([made.big], file.name, { type: 'image/jpeg', lastModified: file.lastModified }), thumb: made.thumb }
}
