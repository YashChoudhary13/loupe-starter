# Print slips — packing slips from Loupe, marked In progress on the click (D146)

**Problem.** Orders are printed from Shopify fifty slips at a time, and the person printing has to remember to mark each order In progress afterwards. When another task interrupts, the marking is forgotten, Dispatch does not list the order, and nothing says so. The packing list itself (which order to HOLD, CLUB or PACK, and with which other orders) runs on the owner's Mac through Claude, which means a Claude session, a PDF in the Downloads folder, and a second pass to mark orders in Shopify.

**Decision.** One button on the Fulfilment face, `ship.qimati-eng.site/dispatch/print`. It reads every open paid order, runs the packing-list rules (ported line for line from `packing_list.py`, selftest and all), keeps the orders that have no slip yet, records them, tells Shopify the PACK and CLUB orders are In progress, and sends the browser to a slip document that opens the print dialog. No Claude, no model, no file: the rules are code, so the same orders give the same marks every click.

## Flow

1. The page shows the orders that would print, each with its mark and reason, and the recent batches.
2. **Print N slips** posts a plain form to `POST /api/slips` (a route, not a server action, so a page left open across a deploy still works). The server re-reads Shopify, re-runs the rules, inserts one `slip_prints` row per order (`on conflict do nothing`: an order another click took meanwhile is simply left out of this batch), then calls `fulfillmentOrderReportProgress` on every OPEN fulfilment order of every PACK and CLUB order. Held orders are never marked. Each result (`marked`, `already`, `failed`, `not_needed`) is kept on the row.
3. `303` to `GET /api/slips/<batch>?auto=1`: the slips, rendered fresh from Shopify in the layout of Shopify's own packing slip with the mark strip on top, and `window.print()` once the page (and its product photos) has loaded.
4. Later clicks print only orders without a row. A new order's slip still names an older printed sibling with its status (`CLUB → 6420 (In progress)`).
5. **Reprint** on a batch renders the same slips again (render only, no Shopify write). **Retry marking** re-sends the In-progress write for the rows that failed.
6. **Print from Qimati<n>** on the first click: orders below n get a `BASELINE` row (printed before Loupe), so the day-one click does not print the whole backlog again.

## What is stored

`slip_batches` (who, when, count, from-number) and `slip_prints` (order id and name, mark, the strip, the progress result). No customer data: every slip is rendered from Shopify at print time. Audit events `slips.printed`, `slips.reprinted`, `slips.progress_retried` on `events`.

## Rules

Identical to `~/.claude/skills/qimati-packing-list/packing_list.py` on the Mac; `tests/slips-plan.test.ts` carries its selftest cases. The rules' "customer account" key (Shopify customer id, default email, default phone) needs `read_customers`, which the Loupe app lacked until the owner added it on 2026-10-10; with it, Loupe's rows over the live open orders matched the Mac's 45 of 45, including the "how matched" lists.

## Not built

A PDF file (the browser's Save as PDF does it), n8n, a Claude job, server-side Chrome, a one-tap "Mark In progress" for orders released from hold (Dispatch still refuses those until marked).
