import sharp from 'sharp'

export const PHASH_HEX_LENGTH = 16
export const DUPLICATE_DISTANCE_THRESHOLD = 8

const SAMPLE_SIZE = 32
const LOW_FREQUENCY_SIZE = 8

const COSINES = Array.from({ length: LOW_FREQUENCY_SIZE }, (_, frequency) =>
  Array.from({ length: SAMPLE_SIZE }, (_, position) =>
    Math.cos(((2 * position + 1) * frequency * Math.PI) / (2 * SAMPLE_SIZE)),
  ),
)

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted[middle] ?? 0
}

/**
 * Deterministic 64-bit perceptual hash of the source photograph.
 *
 * Orientation is applied before sampling. Alpha is flattened onto white so a
 * transparent PNG and the same image saved as JPEG do not diverge merely because
 * one decoder exposes an alpha channel.
 */
export async function perceptualHash(input: Buffer): Promise<string> {
  const pixels = await sharp(input)
    .rotate()
    .flatten({ background: '#ffffff' })
    .greyscale()
    .resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: 'fill' })
    .raw()
    .toBuffer()

  if (pixels.length !== SAMPLE_SIZE * SAMPLE_SIZE) {
    throw new Error(`pHash expected ${SAMPLE_SIZE * SAMPLE_SIZE} pixels, got ${pixels.length}.`)
  }

  const coefficients: number[] = []
  for (let v = 0; v < LOW_FREQUENCY_SIZE; v += 1) {
    for (let u = 0; u < LOW_FREQUENCY_SIZE; u += 1) {
      let coefficient = 0
      for (let y = 0; y < SAMPLE_SIZE; y += 1) {
        const cosY = COSINES[v]?.[y] ?? 0
        for (let x = 0; x < SAMPLE_SIZE; x += 1) {
          coefficient += (pixels[y * SAMPLE_SIZE + x] ?? 0) *
            (COSINES[u]?.[x] ?? 0) * cosY
        }
      }
      coefficients.push(coefficient)
    }
  }

  // DC is overall brightness, not structure. Exclude it from both the median
  // and the bitset so exposure changes do not manufacture a difference.
  const threshold = median(coefficients.slice(1))
  const bitValues: number[] = [0]
  for (let index = 1; index < coefficients.length; index += 1) {
    bitValues.push((coefficients[index] ?? 0) > threshold ? 1 : 0)
  }
  return Array.from({ length: PHASH_HEX_LENGTH }, (_, index) => {
    const offset = index * 4
    const nibble =
      (bitValues[offset] ?? 0) * 8 +
      (bitValues[offset + 1] ?? 0) * 4 +
      (bitValues[offset + 2] ?? 0) * 2 +
      (bitValues[offset + 3] ?? 0)
    return nibble.toString(16)
  }).join('')
}

export function isPerceptualHash(value: string): boolean {
  return /^[0-9a-f]{16}$/i.test(value)
}

export function perceptualHashDistance(left: string, right: string): number {
  if (!isPerceptualHash(left) || !isPerceptualHash(right)) {
    throw new Error('pHash distance requires two 16-character hexadecimal hashes.')
  }

  let distance = 0
  for (let index = 0; index < PHASH_HEX_LENGTH; index += 1) {
    let xor =
      Number.parseInt(left[index] ?? '0', 16) ^
      Number.parseInt(right[index] ?? '0', 16)
    while (xor > 0) {
      xor &= xor - 1
      distance += 1
    }
  }
  return distance
}
