export interface DraftLabelItem {
  readonly id: string
  readonly title: string
  readonly sku: string | null
  readonly barcode: string | null
  readonly copies: number
}

export interface DraftLabelOffer {
  readonly draftId: string
  readonly sku: string
  readonly labelsPrinted: boolean
  readonly items: readonly DraftLabelItem[]
}

/** Copies follow saved stock. Printed is only set when the operator chooses Print. */
export function draftLabelCopies(stock: number): number {
  if (!Number.isInteger(stock) || stock < 0 || stock > 500) {
    throw new Error('Saved stock must be a whole number of 0–500 units.')
  }
  return stock === 0 ? 1 : stock
}

export function nextLabelsPrinted(currentlyPrinted: boolean, decision: 'print' | 'cancel'): boolean {
  return currentlyPrinted || decision === 'print'
}
