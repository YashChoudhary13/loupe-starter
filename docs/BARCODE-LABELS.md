# Loupe labels and order QC

The owner approved implementation and production deployment on 15 September 2026. See the newest `PROGRESS.md` entry for the deployed commit and verification evidence.

## New listings

1. In Console choose **One stock**, **By colour**, **By size**, **Numbered choices**, or **Colour + size**.
2. In Colour + size, add only actual combinations. Gold / 7, Gold / 8 and Silver / 8 are three rows with independent stock. Silver / 7 is not created automatically. Up to 100 choices are supported.
3. Save and wait for the Shopify push. New drafts receive an atomic parent number and a unique SKU for every option; the same value is written into Barcode. Reordering preserves codes and Shopify variant IDs. Renaming an option can require new stickers.
4. Open **Labels**, search the parent SKU, choose copies, and preview/print.

| Option | Example new SKU and Barcode |
| --- | --- |
| Necklace, White | NK1333-C-WHITE |
| Ring, size 7 | RS004-S-7 |
| Ring, Gold, size 7 | RS004-C-GOLD-S-7 |
| Numbered choice 7 | RS004-N-7 |
| No options | ER004 |

Existing drafts keep the legacy policy so retries cannot silently relabel stock. Finish publishing an older draft, then prepare its codes from Labels. Start a new draft for colour–size combinations. Other arbitrary custom option dimensions cannot be created in Console; existing Shopify variants with unusual option names can still receive stable codes in Labels.

## Existing stock

Search the product in **Labels → Prepare codes**. Review the before/after mapping and press **Save these codes to Shopify** when ready to print and replace that product's stickers. This targeted operation updates only variant SKU and Barcode, keeping variant IDs, options, prices, stock and media. It rereads the product before applying and refuses a changed preview or duplicate identities. Existing distinct barcodes are preserved, including manufacturer codes. Unusual historical option names use the Shopify variant number in their suffix.

Prepare one product at a time and relabel its physical stock together. The rollout does not automatically rewrite the entire catalogue. Old printed labels and shared parent SKUs cannot reliably distinguish variants. Open orders continue to match the same Shopify variant IDs; changing their codes invalidates any saved QC checklist. Conflicting product numbers require a deliberate correction in Shopify.

## Printing on pouches

One saleable packed unit gets one sticker. A pair or fixed set sold as one Shopify unit needs one sticker on the package. Twelve identical units need twelve copies of that option's sticker; stock is shown as a reference, not an automatic copy count.

The owner confirmed **38 × 25 mm** labels on 15 September 2026. This is now the default paper size with **QR** selected. Use opaque white adhesive stock. Put the sticker outside a flat part of the plastic pouch, away from folds and seals. Both QR and Code 128 encode the saved Barcode field. Code 128 needs wider labels, often 70 × 30 mm or more. The renderer refuses undersized symbols and keeps clear scan margins. Label length can require wider paper.

Choose matching roll paper, 100% print scale, no browser headers/footers. Print and scan one sticker on a real pouch before printing batches. The label size is confirmed; printer model, resolution and a physical print test are still pending. This is a roll-label layout, not an A4 sticker-sheet template. Missing, duplicate or not-yet-indexed saved codes block printing.

No Retail Barcode Labels subscription is needed. Internal alphanumeric codes are not GS1-issued GTINs and must not be represented as such to sales-channel feeds.

## Order QC

1. Open **Order QC**, find the Shopify order, and open its checklist.
2. Check the whole remaining shipping order together. It includes remaining units at other locations; this is not a per-location shipment checklist.
3. With a 2D USB/Bluetooth scanner, focus the code field and configure Enter after every scan. Alternatively tap **Start camera scanning** once, allow camera access, and bring each pouch in front of the camera. It stays open while Loupe checks each scan. After acceptance, move the pouch into the checked box and leave the camera view clear for about a second until **Ready for the next pouch** appears. This also allows successive pouches with the same code. Use **Stop camera** when finished; decoding stays on the device.
4. Wait for acceptance, then move that pouch into the checked area. Each accepted scan adds one saleable unit. Wrong variants, ambiguous codes and extras are rejected. A completed row is ticked and crossed out.
5. Use **Complete QC** only when all quantities are checked. This saves the checker and time. Fulfillment remains a separate Shopify action.

Repeated readable frames are suppressed. Scanning pauses during an unconfirmed request, order verification or a correction, without closing the camera. Brief missed reads do not rearm it; a clear interval and a stable new read are required. An unreadable or obscured label can still resemble an empty view, so the physical scan-and-move procedure remains necessary.

Counts and audit history survive reloads. Network retries retain the same request ID and cannot double count. Recount starts a new checklist and preserves previous history; undo requires a reason and removes one of the checker's own accepted scans. Concurrent scans are serialized; scans from a checklist that was reset cannot count toward its replacement.

Shopify is checked on every action, when reopening the screen and every 30 seconds while visible. Changes to variant identity, codes or remaining quantities invalidate saved progress. Cancellation, held/scheduled whole orders, custom/deleted variants and empty shipping orders block completion. The order list says **Previously passed · recheck** until the order is opened and reverified. Shopify and Loupe are separate systems: edits after the last verification require another check before fulfillment.

Repeated variant labels do not identify individual physical pieces. Scanning the same pouch twice can count as two units if the order still needs two. The physical scan-and-move procedure is essential; unit serial numbers would be a different system.

## Deployment and verification

Production is the Qimati VPS at https://loupe.qimati-eng.site. The configured Supabase connector account lists an older Loupe project; the current runtime project was verified from the server environment. Use the existing authenticated PostgreSQL deployment connection for this release, not that older project.

1. Apply `20260915080000_variant_barcode_scheme.sql`, `20260915081237_order_qc_sessions.sql`, then `20260915081241_colour_size_combinations.sql` transactionally. The initial default stays legacy during rollout.
2. Deploy the compatible app and verify health.
3. Apply `20260915083506_activate_variant_codes.sql` to opt newly created drafts into unique codes. Existing rows retain their policy.

Rollback: keep schema and saved identities. A compatible prior release is required for new-policy drafts; do not restore a publisher that ignores their codes. Never drop QC history or convert existing new-policy rows to legacy.

Safe local proofs: `scripts/verify-combinations-local-db.ts` (schema-only pre-change fixture, sparse save/reload/reorder, invalid rows, allocator concurrency), `scripts/verify-qc-local-db.ts` (scan cap, races, UUID retries, reset generation, audit, RLS). Both create private temporary PostgreSQL instances and never read `.env`. Focused unit tests cover identity, payloads, reconciliation, label rendering/decoding, routes and QC. Do not run the old broad integration suite against live credentials: its helpers reset counters.

`scripts/verify-variant-barcodes-live.ts` is an explicit opt-in probe creating one zero-stock Shopify DRAFT and deleting only that test product after verifying codes and IDs across reordering. It does not create or alter customer orders. Camera permission/device behavior and a physical printer/scanner still need testing on the team's hardware.

## Sources

- Shopify [ProductVariantSetInput](https://shopify.dev/docs/api/admin-graphql/2026-07/input-objects/ProductVariantSetInput) and [targeted bulk variant update](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/productVariantsBulkUpdate).
- Local rendering: [bwip-js](https://bwip-js.metafloor.com/). Camera decoding: [ZXing browser](https://github.com/zxing-js/browser).
- QR labels preserve [DENSO WAVE's four-module quiet zone](https://www.qrcode.com/en/howto/code.html).
