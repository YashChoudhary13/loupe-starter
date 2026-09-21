# Dispatch — stage tracking numbers, then push fulfilments to Shopify

*2026-09-21. Owner request: "a dashboard … order ID list, the ones which are to be fulfilled like
how we get on order QC. In front of every order ID a blank field to write the tracking ID and
stage it. Like how we do in code before pushing: we stage the orders and click push after
selecting all … the Shopify orders will be fulfilled with the tracking ID and the carrier, which
auto detects the company." Later the same day: "a small + icon which gives us an option to add
one more order ID in case two order IDs go together."*

## Problem

Tracking numbers are typed into Shopify Admin one order at a time. A chat-based Excel round trip
was built on 11 September 2026 (`WhatsApp Bot/docs/tracking-sheet/`) and never deployed; the owner
has since decided a conversation cannot carry this job. Loupe already lists the orders being
packed (`/qc`), has operator sign-in, an audit trail and a phone layout, so the job belongs here.

## Decisions taken with the owner

| Question | Answer |
|---|---|
| Which orders are listed | Orders with a fulfilment order currently **In progress** in Shopify, any day |
| QC | A badge per order (checked / not checked). Informational; it never blocks a push |
| Shopify access | Add fulfilment scopes to **Loupe's own** Shopify app; do not borrow the bot's app |
| Customer notification | Unchanged from today: Shopify emails on fulfilment, the bot sends its WhatsApp `order_shipped_pdf` message |
| Who may use it | Any active `app_users` operator may stage and push; every push records who did it |
| Orders that travel together | A `+` on a row adds further orders to the same parcel; they share one tracking number and carrier |

## Design

**`/dispatch`** — sidebar entry "Dispatch", directly after "Order QC". ("Tracking" already names
the pipeline page.)

```
[ ] QC  Order          Customer        Carrier        Tracking ID      Status
[x] ✓   Qimati5830 [+] Maskyeti Sol.   DTDC ▾         X1234567890      staged
        └ Qimati5899 ✗ [×]  same parcel
[ ] ✗   Qimati5901 [+] R. Sharma       —    ▾         ____________     —
                                  [Select all staged]   [Push 1 parcel · 2 orders]
```

Below `md` each row becomes a card, following D129/D131.

### The list

One Shopify query, reusing the QC order search (`status:open`, unfulfilled or partial, paid /
partially paid / partially refunded), extended with `fulfillmentOrders(first: 10) { nodes { id
status } }`. An order is listed when at least one of its fulfilment orders has status
`IN_PROGRESS`. Pages are followed to the end, capped at ten pages (300 open orders); hitting the
cap shows a notice rather than a silently short list. Shopify rejects
`fulfillment_status:in_progress` as an order search term (verified 11 September), which is why
the filter runs on the returned fulfilment orders.

The QC badge comes from the existing `qcOrderStatuses` / `listRecentPasses` readers.

### Staging

Two tables (RLS enabled with zero policies, service role only, like every Loupe table):

- `dispatch_parcels` — `id`, `shop_domain`, `tracking_number`, `carrier`, `carrier_source`
  (`auto` | `manual`), `staged_by`, `staged_at`, `pushed_by`, `pushed_at`.
- `dispatch_parcel_orders` — `parcel_id`, `order_id` (Shopify gid), `order_name`, `position`
  (0 is the row the parcel was started from), `status` (`staged` | `pushing` | `fulfilled` |
  `failed`), `fulfillment_id`, `error`, `request_id`, `push_started_at`, `finished_at`.

A partial unique index on `(shop_domain, order_id) where status <> 'fulfilled'` keeps an order in
at most one open parcel. A tracking number is saved when its field loses focus or Enter is pressed — a scanner gun ends
every scan with Enter — and focus then moves to the next row's field. Clearing the
field empties the tracking number; the parcel row itself is deleted only when it also has no
grouped orders and was never pushed, so clearing a number never silently ungroups a parcel. The
screen calls a row "staged" when its parcel has both a tracking number and a carrier. Staged rows
survive a refresh and are shared between the packer's phone and the owner's screen. The same rows
are the 30-day "Recently pushed" history.

Every transition writes an `events` row: `dispatch.staged`, `dispatch.unstaged`, `dispatch.grouped`,
`dispatch.ungrouped`, `dispatch.discarded`, `dispatch.pushed`, `dispatch.failed`.

### Carrier detection

`detectCarrier(tracking)` in `src/lib/dispatch/carrier.ts`, a pure function. Input is trimmed,
inner spaces removed, upper-cased, and must be 6–30 characters of `[0-9A-Z]`.

| Pattern | Carrier (exact Shopify company string) |
|---|---|
| `^ER[0-9A-Z]+$` | `India Post` |
| `^[XD][0-9A-Z]+$` | `DTDC` |
| `^[0-9]+$` | `Tirupati Courier` |
| anything else | none — the operator must choose |

The owner said a `D` number is DTDC "sometimes", so detection only pre-fills the select. A manual
choice sets `carrier_source = 'manual'` and later edits to the number no longer overwrite it. A
parcel without a carrier cannot be selected for push. `DTDC` and `India Post` are company names
Shopify recognises and links itself. No tracking URL is sent for `Tirupati Courier` in this
version: the bot already falls back to the order status page when a fulfilment has no URL. Add a
URL template when the owner supplies the carrier's tracking page.

The same tracking number on two different open parcels is flagged on both rows with a "group
these" shortcut; it does not block, because the fix is one tap.

### Grouping (`+`)

`+` opens a search over the other listed orders, same customer first. Choosing one moves it
under the row as a child and removes it from the main list; `×` returns it. Only listed (In
progress) orders can be added, so every order in a parcel passes the same checks. A child whose
customer or shipping address differs from the first order shows an amber warning, not a block.
A parcel may hold any number of orders.

### Push

A confirm sheet lists every parcel → order → carrier → tracking number and states that customers
will be notified and that this cannot be recalled. Then, per parcel, in order:

1. **Re-read every order in the parcel** (`order` + `fulfillmentOrders` with `status`,
   `supportedActions`, `assignedLocation { location { id } }`, line items with
   `remainingQuantity`). Each must be open, not cancelled, not on hold, and have at least one
   `IN_PROGRESS` fulfilment order that supports `CREATE_FULFILLMENT` with a positive remaining
   quantity. If any order fails, **no order in that parcel is fulfilled**; the row names the
   order and the reason.
2. **Fulfil each order** with one `fulfillmentCreate` covering every eligible In-progress
   fulfilment order of that order, `trackingInfo { company, number }`, `notifyCustomer: true`.
   `OPEN`, `ON_HOLD` and `SCHEDULED` fulfilment orders are left alone.
3. **Read the fulfilment back** and require `SUCCESS` with exactly the sent company and number
   before marking the order `fulfilled`.

Mutations are never retried blindly. On a timeout or an unreadable response the order is
re-read: a matching fulfilment means success, none means `failed` with "Shopify did not confirm;
nothing was fulfilled — push again". Before its mutation an order moves `staged → pushing` in one
conditional update that also stores `request_id` and `push_started_at`; a double press or a
second operator finds the row already `pushing` and waits for that attempt instead of starting
another. A row still `pushing` after two minutes (Loupe restarted mid-push) is settled by
re-reading the order, never by sending the mutation again unseen: the list shows it as failed ("the
last push was interrupted"), and the next push starts with the usual fresh read, which finds the
fulfilment if it landed.

The carrier, number and order ids the confirm sheet showed travel with the push and are checked
against the parcel before anything is read from Shopify; if another device changed any of them since
the sheet was drawn, nothing is sent and the operator is told to reload and check.

If the first order of a parcel is fulfilled and a later one fails, the first stays fulfilled and
the failed order stays staged under the same tracking number for another push. Other parcels
continue regardless. A pushed parcel is then frozen: its number and carrier are what a customer was
already told, so they can no longer be edited and no further order can be added — the remaining
order is either pushed again with that same number, or discarded and staged afresh.

An order that already carries an active fulfilment with the same company and number counts as
done (someone fulfilled it in Shopify Admin meanwhile). One with a *different* tracking number and nothing left In progress is
a failure with that number shown, never an overwrite.

### After a push

Fulfilled orders leave the list on the next read because they are no longer In progress.
Staged work whose order has left the list (fulfilled or un-marked in Shopify meanwhile) stays
visible with a "Discard this staged number" link, so it can never block the order silently.
"Recently pushed" shows 30 days: order, carrier, tracking number, who, when. Nothing else is
needed for the customer messages: Shopify's email and the bot's fulfilled-orders poll both react
to the fulfilment itself.

## Shopify access

The Loupe app gains `read_merchant_managed_fulfillment_orders` and
`write_merchant_managed_fulfillment_orders`. The owner adds them in the Shopify Dev Dashboard and
re-approves the install; nothing changes in `.env`. Until then `/dispatch` shows one sentence
naming the two scopes, in the style of `qcShopifyError`. `read_locations` is not required:
`assignedLocation.location.id` is readable without it (verified 11 September).

## Units

| Unit | Purpose | Depends on |
|---|---|---|
| `src/lib/dispatch/carrier.ts` | normalise a tracking number, detect the carrier | nothing |
| `src/lib/shopify/dispatch-orders.ts` | list In-progress orders; read one order for push; `fulfillmentCreate`; read-back | `ShopifyClient` |
| `src/lib/dispatch/plan.ts` | pure: order snapshot + parcel → fulfil / already done / refuse, with the reason | types only |
| `src/lib/dispatch/push.ts` | push one parcel: pre-check, claim, fulfil, re-read, record; all I/O injected | `plan.ts`, types |
| `src/lib/dispatch/store.ts` | parcels and parcel orders in Supabase: stage, group, discard, lists, push-row claims, events | `carrier.ts`, `push.ts` types |
| `src/lib/dispatch/rows.ts` | pure: listed orders + open parcels → screen rows, duplicate numbers | types only |
| `src/app/(shell)/dispatch/page.tsx`, `actions.ts` | server page and actions (`requireOperatorForAction`); one parcel per push call | the units above |
| `src/components/dispatch/DispatchScreen.tsx` | table / cards, staging, grouping, confirm sheet, results | actions |
| `supabase/migrations/<stamp>_dispatch.sql` | the two tables, index, RLS | — |

## Testing

- `carrier.ts`: every prefix rule, lower-case and spaced input, too short, illegal characters,
  manual override surviving an edit.
- `plan.ts`: eligible; cancelled; on hold; no In-progress fulfilment order; zero remaining;
  already fulfilled with the same number; already fulfilled with a different number; a partial
  order where only the In-progress remainder is fulfilled.
- `push.ts` with an in-memory store and a fake Shopify: a parcel of two where the second fails the
  pre-check (nothing fulfilled); second mutation fails after the first succeeded; timeout then
  re-read finds the fulfilment; double push joins one attempt; duplicate order in two parcels is
  refused by the index.
- Migration proof on a local Postgres, as for the QC migrations.
- No automated test fulfils a real order. The first live push is one real parcel with the owner
  watching: Shopify order timeline, customer email, bot WhatsApp message.

## Not in this version

Two parcels for one order; editing or cancelling tracking after a push (done in Shopify Admin);
DTDC API booking (no API key yet — when it arrives it fills the tracking field, the push stays
the same); Excel import; reminders. The 11 September chat flow and its Python service stay
undeployed; its safety rules are carried over above.

## Rollout

1. Owner adds the two scopes to the Loupe Shopify app.
2. Apply the migration (`scripts/apply-migration.ts`), then push `main`. This branch starts from
   `claude/qc-v2` (`9a2cb93`), so D134 and the material script ship with it if they have not
   already.
3. One real parcel pushed with the owner watching, then a grouped parcel of two.
