# Design system

Visual reference: **`design/console-mockup.html`** and **`design/tracking-mockup.html`**. Open them in a browser before building any screen. They are the source of truth for look and feel; this file is the source of truth for values.

Build with **shadcn/ui + Tailwind**, themed to the tokens below. Do not accept shadcn's default look — every component gets these tokens.

---

## Tokens

| Token | Value | Use |
|---|---|---|
| `--bg` | `#EDEDED` | Page background |
| `--surface` | `#FFFFFF` | Cards |
| `--ink` | `#0A0A0A` | Primary text, active states, primary buttons |
| `--ink-soft` | `#4A4A4E` | Body text inside components |
| `--muted` | `#8E8E93` | Labels, secondary text, placeholders |
| `--chip` | `#F4F4F4` | Inactive chips, inputs, secondary buttons |
| `--amber` | `#B8862B` | **The only accent.** "Needs attention" and nothing else |
| `--green` | `#2F7A4F` | Success ticks in timelines only |

**Radii:** cards `24px` · inner panels `18px` · thumbnails `16px` · inputs `14px` · **everything interactive `999px`**

**Type:** Inter. Body `13px`. Page title `26px/500`, tracking `-0.025em`. Section labels `10px`, uppercase, letter-spacing `0.11em`, colour `--muted`. Numbers in stat pills `15px/600`.

---

## Rules

**Pill geometry is the signature.** Nav items, chips, buttons, inputs, badges, segmented controls — all fully rounded. If something interactive has square corners, it's wrong.

**Black means active.** Selected chip, current nav item, primary button, the "will publish as" card. Grey means available. There is no third state and no hover colour beyond a slight darkening.

**One accent, used once per screen.** Amber marks things needing human attention. Adding a second accent colour erodes the first — if something else needs emphasis, use black.

**The photograph is the only colour.** Never introduce colour into chrome, charts or backgrounds. The entire point of the monochrome scheme is that jewellery photos are the sole colour on screen.

**Density over airiness.** The visual reference is a portfolio piece with eight data points on a full screen. This tool shows twenty-plus thumbnails and gets driven hard. Keep the visual language; tighten the spacing.

**Charts:** thin single-weight strokes, no fills, no gridlines, no axis furniture. A legend is a small dot, a label, and a right-aligned value.

---

## Components

- **Stat pill** — white pill, bold number + muted label. One dark variant per row for the primary figure. Optional leading amber dot.
- **Chip** — grey pill; black when selected. `ghost` variant (dashed border) for "+ add".
- **Tile** — square, `16px` radius, 2px transparent border that turns `--ink` when selected. Bottom-left white pill for the category label; top-right black circle for image count.
- **Feature card** — black card for the single most important thing on screen. In the console that is the resolved `SKU · title · handle`.
- **Row (tracking)** — 1px light border, `18px` radius, border turns `--ink` when expanded. Thumbnail, monospace filename, status pill, right-aligned age, plain-English reason, action pills.
- **Status pills** — `FAILED` amber-on-cream, `STALLED` grey, `RUNNING` black.

---

## Interaction

**Keyboard first.** The operator processes hundreds of products. Selecting a tile focuses the price field. `Enter` publishes and advances to the next item. Category is reachable without the mouse.

**Sticky actions.** Publish never scrolls out of view — it stays pinned at the bottom of the detail panel.

**Visible focus rings on everything.** The visual reference is a static image and shows none. Without them the keyboard path is unusable. Use a 2px inset `--ink` ring.

**Sticky defaults.** Category and material carry over from the previous item. After the first necklace in a batch, the operator's entire action is: glance, type price, `Enter`.

---

## Language

Error messages are written for the operator, not the developer. Say what happened and what to do:

> **The file is a HEIC.** The enhancer needs JPEG or PNG. Ask the photographer to change the camera setting to Most Compatible.

The raw API error goes behind a "Details" expander for whoever debugs it. `HTTP 415 UNSUPPORTED_MEDIA_TYPE` alone is never acceptable as user-facing text.
