# SEO roadmap for qimati.in

Written 2026-08-09 from a live audit of www.qimati.in (homepage, robots.txt, /collections/all).
Audience: a solo beginner developer. Phases are ordered by impact-per-hour; do them in order.

## Where the site stands today (audited 2026-08-09)

Working already, leave alone:
- Site is live, crawlable, standard Shopify robots.txt with `Sitemap: https://www.qimati.in/sitemap.xml`.
- Cart/checkout/filter-parameter URLs correctly disallowed; Shopify manages canonicals and the
  sitemap automatically.

Problems found, in rough order of severity:
1. **Product titles carry zero search keywords.** `Anklets 003 (Single Piece)`, `Necklace 970` —
   nobody searches those. This is the single biggest gap, and it must NOT be fixed by renaming
   products (see "Hard constraints" below). Shopify has separate per-product SEO fields for this.
2. **Every product shares the same six-bullet description** — near-duplicate content across the
   whole catalogue, ~300 more per month. Google devalues pages it can't tell apart.
3. **Homepage title tag is weak**: "QIMATI India's Top Premium Jewellery Wholesaler – Qimati"
   (brand twice, no location, no category keywords). No visible H1 on the homepage.
4. Navigation contains the misspelling "Jewllery".
5. Collection pages have no intro copy — they are the pages that *can* rank (products are numbered;
   collections carry the keywords), and today they're bare product grids.
6. Old catalogue damage: `-copy` handles from hand-duplicated products (e.g.
   `rings-224set-of-10-different-rings-for-750-copy`). Cosmetic, low priority, risky to change.

## Hard constraints — read before touching anything in Shopify admin

These come from CLAUDE.md and will silently break the business if ignored:

- **Never rename product titles or "tidy" tags for SEO.** Collections are tag-driven and the exact
  existing tag strings (including casing, and the all-caps `NEWEST` tag) are load-bearing. A tidier
  tag publishes fine and silently drops the product out of its collection. SEO never requires
  touching either: Shopify's per-product **Search engine listing** (SEO page title + meta
  description) is a separate field from the product title.
- **Don't change handles of Loupe-published products.** Publishing is idempotent by handle, and the
  nightly reconciliation compares handles; an admin-side handle change surfaces as drift. Shopify
  does auto-create a redirect, so fixing an old *pre-Loupe* `-copy` handle is safe for Google — but
  do it deliberately, one at a time, and never on a product Loupe manages.
- Expectation setting: SEO compounds over **3–6 months**. qimati.in will not rank for "jewellery";
  it can realistically own long-tail wholesale/B2B terms like *wholesale artificial jewellery
  Jaipur*, *anti tarnish jewellery wholesale India*, *stainless steel jewellery wholesaler*,
  *imitation jewellery supplier for resellers*. Validate exact terms with Google autocomplete and
  the free Keyword Planner before writing copy around them.

## Phase A — Measurement first (one afternoon, no code)

You cannot improve what you cannot see. Do this before any optimisation.

1. **Google Search Console**: verify the domain (DNS TXT record is the clean method), submit
   `https://www.qimati.in/sitemap.xml`. This is where you'll see what queries you appear for,
   which pages are indexed, and any crawl errors.
2. **Bing Webmaster Tools**: one click to import the verified GSC property.
3. Note baseline numbers (indexed pages, impressions, clicks) somewhere — GSC only shows 16 months
   of history and you'll want a "before" picture.
4. Shopify's built-in analytics already shows traffic sources; that's enough to start. GA4 is
   optional and can wait.

## Phase B — On-page basics in Shopify admin (a weekend, no code)

1. **Homepage** (Online Store → Preferences): title ≈60 chars, meta description ≈155.
   Example shape: `Wholesale Artificial Jewellery Supplier in Jaipur | Qimati` and a description
   mentioning anti-tarnish, minimum order ₹1,000, pan-India shipping — whatever is true and typed
   the way a buyer would search.
2. **Fix the "Jewllery" misspelling** in navigation.
3. **Collection pages — the highest-value 2–3 hours of this whole plan.** For each of the ~12
   collections: keyword-bearing SEO title (`Wholesale Necklaces — Anti-Tarnish, Gold & Silver
   Plated | Qimati`), a unique meta description, and 100–200 words of real intro copy on the page
   (materials on offer, wholesale terms, who it's for). Collections are where category-level
   searches should land.
4. **Bestseller products by hand** (top 20–30 only): fill the per-product *Search engine listing*
   title/description, and add descriptive image alt text. Do not scale this by hand — Phase D
   automates it for everything new.
5. Confirm the theme renders exactly one H1 on the homepage (theme editor; usually a heading
   setting on the first section).

## Phase C — Technical check (an evening, mostly verification)

Shopify does most technical SEO for you; verify rather than build.

1. Run 2–3 product pages through Google's **Rich Results Test**. Modern themes emit Product
   JSON-LD (price, availability) automatically; if the theme doesn't, that's a theme-level fix
   worth making so listings get price/stock rich snippets.
2. **PageSpeed Insights** on homepage + one collection + one product. On Shopify the usual wins
   are: remove unused apps (each injects JS), lazy-load below-the-fold images, avoid giant hero
   images. Don't chase a perfect score; fix anything egregious.
3. Check `https://www.qimati.in/sitemap.xml` loads and GSC reports pages as indexed, not
   "Discovered – currently not indexed" (if the latter persists for months it's usually a
   content-quality signal — Phase D is the cure).

## Phase D — Loupe automation: the actual competitive advantage

~300 products/month flow through Loupe, and **Loupe already pays for and caches a factual 60–100
word AI description of every photo** (`intake_files`, describe stage). Nobody hand-writing listings
can match per-product unique content at this volume; today that asset is only used for image
generation. Extend the publish path (`productSet` accepts an `seo` input and per-media alt text):

1. **SEO page title** per product, templated from data Loupe already has:
   `{category keyword phrase} — {material} {colour} | Wholesale | Qimati`
   (e.g. `Anti-Tarnish Gold Necklace — 316L Steel | Wholesale | Qimati`). The visible product
   title (`Necklace 970`) and tags stay exactly as they are.
2. **Meta description** derived from the cached describe-stage paragraph, truncated ~155 chars.
3. **A unique descriptive paragraph in `descriptionHtml`**, from the same cached text, above the
   six standard bullets — this kills the duplicate-content problem at the source. Keep the bullets;
   they carry the material line the business standardised on.
4. **Image alt text** from the cached description on every uploaded media.
5. Category-level keyword phrases (the `{category keyword phrase}` above) belong in the categories
   table as data, not hardcoded — same philosophy as the prompts table.

Guard rails when building it: the describe text is model output — escape it, length-cap it, and let
the operator see/edit the derived SEO fields on the draft like any other field. Record the design
in DECISIONS.md. Backfilling the existing catalogue can come later as a batch job over published
products; the drift reconciler must learn that Loupe-written SEO fields are expected, not drift.

## Phase E — Authority and content (ongoing, ~2–4 hours/month)

Rankings = relevance (Phases B–D) × authority (this phase). Authority is the slow part.

1. **Google Business Profile** for the Jaipur location. For "wholesale jewellery jaipur"-type
   searches the local pack often outranks organic results. Free, high leverage, one evening.
2. **B2B directories where buyers already search**: IndiaMART, TradeIndia, ExportersIndia, Justdial.
   These bring links *and* direct wholesale enquiries.
3. **A small blog aimed at your actual buyer (resellers), not consumers**: "How to start a
   jewellery resale business in India", "304 vs 316L stainless steel jewellery — what resellers
   should know", "What does anti-tarnish actually mean?". One good post a month beats four thin
   ones. Each post internally links to the relevant collections.
4. Instagram/WhatsApp presence doesn't rank pages directly but drives branded searches ("qimati
   jewellery"), which do help.
5. Ask happy resellers for Google reviews on the Business Profile.

## Phase F — Monthly loop (30 minutes/month)

In GSC → Performance: filter queries ranking in positions 8–20 (page one's doorstep). Improve the
matching page's title/copy for that query. Repeat monthly. This tightening loop is most of what a
paid SEO retainer actually does.

## What NOT to do

- Don't buy backlink packages or "guaranteed #1" services — penalties are real and cheap links are
  how you earn them.
- Don't keyword-stuff titles or copy; write for a wholesale buyer, once.
- Don't mass-edit tags, titles, or handles (see hard constraints).
- Don't noindex/block anything unless you fully understand it; the default Shopify robots.txt is
  already correct.
- Don't judge results weekly. Check monthly; judge quarterly.
