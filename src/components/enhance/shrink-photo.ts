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

export function shrinkPhoto(file: File): Promise<File> {
  const run = turn.then(() => shrink(file))
  turn = run.catch(() => undefined)
  return run
}

async function shrink(file: File): Promise<File> {
  if (file.type !== 'image/jpeg' || file.size <= LEAVE_ALONE_BELOW) return file
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    try {
      const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
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
