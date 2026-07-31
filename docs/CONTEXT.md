# Business and Operating Context

## THE IDEA

Qimati is a wholesale jewellery store in Jaipur — B2B, with approximately 1,600 products, mostly priced around ₹75–₹750 per piece and sold to retailers who resell them.

The process being replaced works like this:

1. A photographer shoots the jewellery.
2. The photographs are sent through WhatsApp.
3. One person enhances every photograph across five ChatGPT tabs.
4. That same person manually types every Shopify listing.

Qimati adds roughly 300 products per month.

The main problem is not simply that this process is slow. The larger problem is that the entire listing operation runs through one person. When that person is unavailable, nothing is listed.

The manual process has already damaged the live catalogue:

- Two different products carry SKU `RS221`.
- `RS218`, `RS220` and `RS222` are missing from the sequence.
- Product descriptions pasted from WhatsApp still contain WhatsApp CSS classes.
- Public product URLs contain `-copy` because new products are created by duplicating old ones.

Loupe replaces this process.

Of the approximately twelve fields needed for a product listing, exactly two require human judgement:

- category;
- price.

Everything else can be derived.

The target operator workflow is:

1. Look at the enhanced image.
2. Click the category.
3. Type the price.
4. Press Enter.

The target is approximately ten seconds per product instead of several minutes.

The all-in operating budget is approximately ₹5,000 per month.

The earlier business estimate was approximately:

```text
$0.089 per product
$0.076 image generation
$0.013 description
```

The latest Phase 3B production evidence measured description calls somewhat higher, approximately `$0.01462–$0.01597`. Preserve both facts: one is the original business estimate and the other is the latest measured evidence.

Buyers influence one design decision in particular.

Qimati’s customers are retailers. They zoom into photographs to judge build quality before staking their own reputation with their customers. This is why image **FIDELITY** outranks every aesthetic instruction in the enhancement prompt.

A model that quietly adds a chain link, stone, engraving, clasp or setting detail can cost real orders.

The jewellery itself must remain faithful even when the background and presentation are changed.

Everything currently runs against a test Shopify store:

```text
qimti.myshopify.com
```

The public live business is:

```text
qimati.in
```

Live-store cutover is Phase 7 and has not happened.

Do not point this project at the live store during an earlier phase.

## WHERE IT IS

Phases 1, 2, 3A, 3B, 4, 5 and 6 are complete, verified and deployed.

### Phase 1

Schema, seed data and the atomic SKU counter.

The counter was proven under 100-way concurrency.

### Phase 2

Shopify publishing path.

Publishing is idempotent by reserved handle and was verified against the test store.

### Phase 3A

Google Drive intake, reconciliation and lease sweeping.

Worker ownership is fenced with UUID lease tokens.

### Phase 3B

Durable two-call enhancement:

1. Describe with `gpt-5.6-sol`.
2. Generate with `gpt-image-2`.

Descriptions are cached on the intake row. Exact resolved image prompts and exact model strings are stored with every image version.

### Phase 3C — separate incomplete amendment

Bounded presentation classification and category-appropriate composition using the existing describe call.

This is a narrow amendment inserted before the operator console.

It must not become an unbounded creative-direction system.

### Remaining roadmap

```text
7 — parallel live-store run and cutover
```

Phase 7 is the next full phase. Phase 3C remains separately incomplete on its descriptor
cost gate; completing Phases 5 and 6 did not silently approve a different production model.

Two items were deliberately deferred into Phase 4 because they require published intake rows, which nothing produces until the console exists:

- moving processed Drive files into `/Processed`;
- writing the stored `product_description` as Shopify image alt text.

Moving a Drive file is housekeeping only. It must never become a state transition or source of processing truth.

## HOW THIS PROJECT IS WORKED

Every completed phase has uncovered a real defect through verification rather than code inspection.

This is the project standard, not an accident.

### Verify behaviour, not intentions

Examples already found:

- Postgres `lpad` truncates as well as pads.  
  `lpad('1000', 3, '0')` returns `'100'`. The original SKU implementation would therefore have issued the 1000th necklace as `NK100`, colliding with an existing product. The live necklace sequence was only around thirty products away.

- Shopify `productSet` requires `productOptions` whenever variants are supplied.  
  A single test product passed because it had colour variants. The twenty-way publish verification caught the actual failure when every colourless product failed.

- A lease deadline does not prevent a stale worker from overwriting its replacement.  
  UUID ownership tokens were added so every completion proves that the worker still owns the lease.

- Raw environment-variable presence checks are insufficient.  
  A multiline Google service-account JSON value was truncated to `{` by dotenv while still passing a truthiness check. Credentials now undergo structural validation.

- Provider contracts must be verified against real requests.  
  OpenRouter rejected a bare data-URL string for `input_references`; the accepted request requires a typed `image_url` object.

- A successful but over-cost description result could accidentally survive into the image prompt.  
  Live cost-path review found and corrected the state so rejected description text is cleared before the worker continues.

- A crash after an immutable R2 upload must not result in another paid generation call.  
  Deterministic storage keys and metadata checks were verified through recovery tests.

- Passing unit tests are not enough.  
  Database functions are inspected and exercised against the deployed database because mocks do not reveal PL/pgSQL ambiguity, enum-resolution mistakes, changed privileges or manual database drift.

The working rule is:

> “It ran” is not evidence.

Evidence means things such as:

- an actual database read-back;
- the actual Shopify product ID;
- the exact stored resolved prompt;
- the actual provider-reported cost;
- the number of provider calls before and after a retry;
- the exact concurrency result;
- an R2 checksum;
- a screenshot or retained contact sheet;
- proof that a stale worker was rejected;
- proof that client bundles contain no server secrets.

Every state transition must be auditable.

Every phase must update `docs/PROGRESS.md`.

Every decision not already specified by the phase prompt must be recorded in `docs/DECISIONS.md`.

Never weaken a test merely to make the phase green. First determine whether the test found a product defect, an infrastructure defect or a defect in the test itself.

## OPEN QUESTIONS

The following business facts remain unresolved and must not be guessed:

1. The exact Shopify tag for Nose Pins.
2. SKU prefix, title pattern and Shopify tag for:
   - Watches
   - Hand Chains
   - Jewellery Box
   - Bags
   - Hair Accessories
   - Indian Jewellery
   - Brass
3. The live Shopify store currency must be confirmed before cutover. D49 settles the
   application rule: Loupe writes no currency and performs no conversion; Shopify's target
   store configuration is authoritative. The USD test-store mismatch is accepted.
4. Default stock per category must be confirmed.
5. **Settled by D50.** Loupe writes clean per-product `descriptionHtml`, keeps
   `custom.material`, permits a one-off custom material, and offers a rare plain-text
   description override. The unmade theme dependency from D6 is removed.
6. At live cutover, `seed:counters` must be run against the live store while publishing is quiet.
7. The expected live maxima should be sanity-checked:
   ```text
   NK 970
   ER 453
   BK 317
   CB 352
   RS 224
   AK 087
   ```
8. The `$0.006` description-cost target introduced by Phase 3C is materially below the latest measured Phase 3B cost. The request must be verified at the provider boundary before assuming that the reasoning setting is missing.

Do not block Phase 3C on unrelated live-cutover questions.
