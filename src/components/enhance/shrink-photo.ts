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
