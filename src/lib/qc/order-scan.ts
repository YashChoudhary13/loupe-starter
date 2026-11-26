/** The barcode on a packing slip is the order's own name (D180): `Qimati8796`. A scan of that shape on any Order QC
 * screen opens the order; anything else is a pouch code as before. No product barcode or SKU has this shape. */
export const orderScan = (code: string): string | null => /^#?(qimati\d{3,8})$/i.exec(code.trim())?.[1] ?? null
/** The list page opens the order by itself when the search is a slip scan with exactly one hit. */
export const orderScanHref = (name: string) => `/qc?q=${encodeURIComponent(name)}`
