/**
 * Shopify SEO title and meta description for a Loupe-published product.
 *
 * Same pattern the 26 Aug 2026 catalogue-wide generator wrote (Qimati SEO
 * changelog), so a product published today reads exactly like the 3,000 before
 * it: `Wholesale <material> <Category> — <n> | Qimati` and a one-line meta
 * description that names the material, finish, design number, the per-unit
 * note where the category needs one, and the ₹1,000 prepaid minimum.
 *
 * Without this Shopify falls back to the bare product title ("Earrings 548"),
 * which is what the 28 products published on 27 Aug 2026 went live with.
 */

import { materialDescriptor } from './description'
import { padSkuNumber } from './identity'

export interface SeoFields {
  readonly title: string
  readonly description: string
}

/** Google truncates around here; the cadence line is dropped rather than cut. */
export const SEO_DESCRIPTION_MAX_LENGTH = 160

const NOUN_BY_PREFIX: Readonly<Record<string, string>> = {
  NK: 'Necklace',
  ER: 'Earrings',
  BK: 'Kada Bracelet',
  CB: 'Chain Bracelet',
  RS: 'Ring',
  AK: 'Anklet',
  NP: 'Nose Pin',
  WH: 'Watch',
  HC: 'Hand Chain',
  INJ: 'Pendant Set',
  HA: 'Hair Accessory',
  WC: 'Waist Chain',
}

/** The two return-risk facts the catalogue states in every meta description. */
const UNIT_NOTE_BY_PREFIX: Readonly<Record<string, string>> = {
  ER: ' Sold as a pair.',
  AK: ' Sold singly.',
}

const CADENCE = ' New designs twice a week from Jaipur.'

export interface SeoArgs {
  readonly skuPrefix: string
  readonly skuNumber: number
  /** Controlled name (`304`, `316L`, `Brass`), a one-off custom material, or null. */
  readonly material: string | null
  /** Fallback noun for a category without a known prefix. */
  readonly categoryName?: string | null
}

export function buildSeo(args: SeoArgs): SeoFields {
  const n = padSkuNumber(args.skuNumber)
  const noun = NOUN_BY_PREFIX[args.skuPrefix] ?? args.categoryName?.trim() ?? 'Jewellery'
  const material = args.material?.trim().replace(/\s+/g, ' ') ?? ''
  const steel = material === '304' || material === '316L'
  const descriptor = material ? materialDescriptor(material) : ''

  const title = `Wholesale ${descriptor ? `${descriptor} ` : ''}${noun} — ${n} | Qimati`

  // A custom material gets no finish claim: we do not know what it is coated with.
  const finish = steel
    ? ' with an 18kt gold-colour PVD finish'
    : material === 'Brass'
      ? ' with a gold-colour finish'
      : ''
  const materialWords = steel ? `${material} stainless steel` : material === 'Brass' ? 'brass' : material
  let description =
    `Wholesale ${materialWords ? `${materialWords} ` : ''}${noun.toLowerCase()}${finish}. ` +
    `Design ${n}.${UNIT_NOTE_BY_PREFIX[args.skuPrefix] ?? ''} Minimum order ₹1,000, prepaid.`
  if (description.length + CADENCE.length <= SEO_DESCRIPTION_MAX_LENGTH) description += CADENCE
  return { title, description }
}
