# Loupe labels and variant codes

Prepared locally on 15 September 2026. This feature is not deployed and has not changed the live catalogue.

## Operator workflow

1. Create a new listing in Loupe and select its colours, sizes or numbered choices. The editor previews a separate SKU for each option.
2. Save and wait for the Shopify push to finish. Loupe reserves the product number and writes each option's SKU into Shopify's Barcode field too.
3. Open **Labels** in the sidebar, or **Open saved labels** in the editor. Search by the parent SKU (e.g. NK1333) or an exact variant SKU.
4. Enter a copy count for each option. Stock is a reference, not a default print count. Twelve identical White units need twelve copies of the White label.
5. For small plastic jewellery pouches, start with **QR, 40 × 25 mm**. This is an adjustable sample size, not a verified fit for Qimati's packaging. Use an opaque white adhesive label on the outside of a flat part of the pouch, away from folds and seals. QR scanning needs a 2D scanner or a compatible phone scanning screen. Code 128 is also available; the longer option codes generally need wider paper, such as 70 × 30 mm.
6. Preview checks the saved Shopify barcode, including collisions with another variant's SKU or barcode. Missing, ambiguous or unconfirmed codes block the print run. Shopify search indexing delays can require a retry.
7. Select the matching paper size in the printer, 100% scale, no margins, and disable browser headers/footers. Print and scan one sticker on a real pouch before printing the batch. The layout is for individual roll labels; it is not an A4 sticker-sheet template.

Label one **saleable packed unit**: a pair or a fixed set sold as one Shopify unit gets one label on that package. Do not assume one earring equals one order unit. Every physical unit of the same option repeats its option code; these are not individual serial numbers.

## Newly confirmed requirement: colour with sizes

The owner confirmed that some products have both colour and size, with different
sizes available for each colour. The current local implementation does **not**
create those combinations: Loupe's editor, saved variant rows and publisher still
support one mode at a time (`none`, `colour`, `size`, `number`). Do not describe
that as support for every variant configuration or deploy it as a complete
solution to this expanded requirement.

Each actual colour–size pair must become one Shopify variant with its own stock,
SKU and matching barcode. For example, Gold/7, Gold/8 and Silver/8 are three
variants; Silver/7 must not be invented if it is not offered. A prospective code
is `RS004-C-GOLD-S-7`; this combined-code generator is not implemented yet.
The editor should allow the operator to select sizes and quantities within each
colour, while publishing Color and Size as separate Shopify options. QC should
match the exact Shopify variant ID, so a right colour with the wrong size is a
rejected item. Support needs to extend the saved model, validation, publishing,
reconciliation and previews together. Existing multi-option Shopify variants can
only be labeled by the current Labels feature if their saved barcodes are already
unique and valid; that does not mean Loupe can create or edit them yet.

## Code policy

| Listing | SKU and Shopify Barcode for new drafts |
| --- | --- |
| Necklace 1333, White | NK1333-C-WHITE |
| Necklace 1333, Green | NK1333-C-GREEN |
| Ring 004, Size 7 | RS004-S-7 |
| Ring 004, numbered choice 7 | RS004-N-7 |
| Earrings 004, no options | ER004 |

The parent number is still allocated by the existing atomic Postgres allocator. Codes derive from option identity, not row position: reordering choices or retrying a publish does not renumber them. Colour aliases follow the existing Shopify colour canonicalizer. Changing an option's meaning/name can change its code and requires new labels. Normalization collisions are blocked; arbitrary custom option names are not guaranteed to be encodable.

QR and Code 128 encode the same saved barcode text. No Retail Barcode Labels app is required. These are internal inventory codes, not GS1-issued UPC/EAN/GTINs. Do not present them as manufacturer GTINs to a marketplace or sales-channel feed.

Existing drafts, including unfinished or failed drafts, remain on `legacy`. The migration does not rewrite their SKUs or barcodes. New rows use `variant-v1`; normal draft editing cannot flip the scheme. Changing older stock needs a separate migration tied to Shopify variant IDs and physical relabeling. The general publisher must not be used as a bulk catalogue repair because it also writes stock, prices, options and media.

## Release and verification

- Worktree: `/Users/yash/Desktop/Qimati-worktrees/loupe-barcode-labels`, branch `codex/loupe-barcode-labels`, based on `aa1db00`.
- Apply `20260915090000_variant_barcode_scheme.sql` before serving the new application. The application selects the new column, so deploying code first breaks draft reads.
- Coordinate a short pause in new listing saves while applying the migration and switching releases: the older application does not know the new default policy.
- Confirm the migration history and current production branch before release. A push to `main` triggers production deployment automatically; no commit, push, migration or deployment was performed in this implementation session.
- Test one new Shopify DRAFT with White and Green, read back both SKU/barcode values, reorder and save again, and verify variant IDs are preserved. Check an older draft remains unchanged. Run these against a designated test product before real labeling.
- Isolated database proof (never reads `.env`): `npx tsx scripts/verify-labels-local-db.ts`. Requires local PostgreSQL binaries, with optional `LOUPE_TEST_PG_BIN`. It starts a temporary Unix-socket-only database and stops it after testing migration defaults and 100 concurrent allocator requests; it does not test the full deployed schema.
- Generate samples locally after `npm run build`: `npx tsx scripts/preview-labels.tsx /tmp/loupe-label-preview`. These samples use fictional fixtures and are visibly marked as samples.
- Rollback requires keeping the new schema and pausing saves of new-policy drafts until a compatible publisher is restored. Do not drop the scheme column or silently revert its rows to legacy.

## Remaining QC work

This change supplies listing identity and label printing. It does not implement an order scanning dashboard or mark orders fulfilled.

The earlier QC demo and setup plan in `QIMATI/output/qc-system` describe the separate order flow. That flow must load current unfulfilled Shopify line items, match exact variant IDs, count one saleable unit per scan, reject unknown/wrong/excess codes, and refuse completion while quantities are short. Changes to the order must invalidate stale progress. QC completion and Shopify fulfillment must remain separate actions.

Repeated option codes cannot tell two identical physical pieces apart. A checker must scan each package once and move it to the checked area; detecting a repeated scan of the same physical piece would require unit serial numbers. The proposed codes do distinguish colours, sizes and numbered options.

Before migrating old stock, prepare a read-only mapping of product/variant IDs, old and proposed codes, existing barcodes and affected open orders. Preserve any manufacturer barcode and stop on conflicting identities. Relabel the physical stock and handle open orders together with that reviewed mapping.

## References

- Shopify permits a barcode string in [ProductVariantSetInput](https://shopify.dev/docs/api/admin-graphql/2026-07/input-objects/ProductVariantSetInput).
- Rendering uses [bwip-js](https://bwip-js.metafloor.com/), version 4.11.4, locally on the server.
- QR printing preserves [DENSO WAVE's four-module quiet zone](https://www.qrcode.com/en/howto/code.html). The proposed 0.5 mm modules still require a real printer/scanner test.
