import sharp from 'sharp'

import { EnhancementError } from './errors'

export interface PreparedImage {
  readonly buffer: Buffer
  readonly mediaType: 'image/jpeg' | 'image/png'
  readonly width: number
  readonly height: number
  readonly originalWidth: number
  readonly originalHeight: number
}

export interface ImageDimensions {
  readonly width: number
  readonly height: number
}

function dimensions(
  width: number | undefined,
  height: number | undefined,
  operation: string,
): ImageDimensions {
  if (!width || !height) {
    throw new EnhancementError(`The image dimensions could not be read while ${operation}.`, {
      stage: 'input',
      code: 'image_dimensions_missing',
      retryable: false,
    })
  }
  return { width, height }
}

export async function prepareModelInput(input: Buffer): Promise<PreparedImage> {
  try {
    const metadata = await sharp(input, { failOn: 'error' }).metadata()
    const oriented = metadata.autoOrient ?? dimensions(metadata.width, metadata.height, 'reading it')

    const base = sharp(input, { failOn: 'error' })
      .autoOrient()
      .resize(1024, 1024, {
        fit: 'inside',
        withoutEnlargement: true,
      })

    const output = metadata.hasAlpha
      ? await base.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
      : await base.jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer({
          resolveWithObject: true,
        })

    return {
      buffer: output.data,
      mediaType: metadata.hasAlpha ? 'image/png' : 'image/jpeg',
      width: output.info.width,
      height: output.info.height,
      originalWidth: oriented.width,
      originalHeight: oriented.height,
    }
  } catch (error) {
    if (error instanceof EnhancementError) throw error
    throw new EnhancementError(
      'The source image is corrupt or cannot be decoded. Export it again as JPEG, PNG or WebP.',
      {
        stage: 'input',
        code: 'unsupported_or_corrupt_image',
        retryable: false,
        detail: error,
      },
    )
  }
}

export async function readImageDimensions(input: Buffer): Promise<ImageDimensions> {
  try {
    const metadata = await sharp(input, { failOn: 'error' }).metadata()
    return dimensions(metadata.width, metadata.height, 'validating the generated result')
  } catch (error) {
    if (error instanceof EnhancementError) throw error
    throw new EnhancementError('The image model returned an unreadable image.', {
      stage: 'image',
      code: 'malformed_image_response',
      retryable: false,
      detail: error,
    })
  }
}

/**
 * Curated image models share a square editing contract but not a pixel-size
 * contract. Keep Loupe's storage/output dimensions stable without stretching a
 * non-square response: only a genuinely square result may be resized.
 */
export async function normaliseGeneratedImage(
  input: Buffer,
  target: ImageDimensions,
): Promise<Buffer> {
  try {
    const metadata = await sharp(input, { failOn: 'error' }).metadata()
    const actual = dimensions(
      metadata.width,
      metadata.height,
      'normalising the generated result',
    )

    if (actual.width * target.height !== actual.height * target.width) {
      throw new EnhancementError(
        `The image model returned ${actual.width}x${actual.height}; Loupe requires the ${target.width}x${target.height} aspect ratio.`,
        {
          stage: 'image',
          code: 'image_aspect_ratio_not_honoured',
          retryable: false,
          detail: { requested: target, actual },
        },
      )
    }

    if (
      actual.width === target.width &&
      actual.height === target.height &&
      metadata.format === 'png'
    ) {
      return input
    }

    return await sharp(input, { failOn: 'error' })
      .resize(target.width, target.height, { fit: 'fill' })
      .png({ compressionLevel: 9 })
      .toBuffer()
  } catch (error) {
    if (error instanceof EnhancementError) throw error
    throw new EnhancementError('The image model returned an unreadable image.', {
      stage: 'image',
      code: 'malformed_image_response',
      retryable: false,
      detail: error,
    })
  }
}

/**
 * The grid needs a small preview, not another full render. WebP quality is
 * reduced until the file is close to (and never materially above) ~50 KB.
 */
export async function makeThumbnail(input: Buffer): Promise<Buffer> {
  let best: Buffer | null = null
  for (const quality of [82, 74, 66, 58, 50, 42]) {
    const candidate = await sharp(input, { failOn: 'error' })
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality, effort: 5 })
      .toBuffer()
    best = candidate
    if (candidate.byteLength <= 65_000) return candidate
  }
  if (!best) {
    throw new EnhancementError('The generated thumbnail could not be created.', {
      stage: 'input',
      code: 'thumbnail_failed',
      retryable: false,
    })
  }
  return best
}
