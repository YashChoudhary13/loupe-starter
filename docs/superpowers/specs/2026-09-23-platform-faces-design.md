# Qimati platform — one app, four faces, a home dashboard with an AI that reads and asks

*2026-09-23. Owner request: "At qimati-eng.site we create our main dashboard … with a small AI
interface [that] will have all the context about our server and apps status … one app will be
Loupe which will contain only listing stuff, one app would be QC … qc.qimati-eng.site, third app
would be something like Fulfillment … and in future we'll keep introducing the apps." Later the
same day: "make sure the AI agent cannot write anything in Shopify store, website, orders. Only
read and control a bit of WhatsApp bot."*

## Problem

Loupe grew from a listing console into the place where orders are QC'd (D128) and, on branch
`claude/dispatch`, where tracking numbers are pushed (D135). Three different jobs, three kinds of
user, one menu and one look. The owner also has no single place that says whether the VPS
services, the WhatsApp bot, DTDC, Supabase and Shopify are all working, and wants to ask that in
plain words.

## Decisions taken with the owner

| Question | Answer |
|---|---|
| Structure | **One codebase, one deploy, one login, one database, one Shopify app**, wearing four faces chosen by hostname. Separate deployments only if isolation is ever needed |
| Faces | Home `qimati-eng.site` · QC `qc.qimati-eng.site` · Fulfilment `ship.qimati-eng.site` · Loupe `loupe.qimati-eng.site` |
| Screens | Home: health lights, numbers, chat. Loupe: Console, Upload, Identify, Restock, Tracking, Prompts, Models, Workflows. QC: Order QC, Shortages, Labels. Fulfilment: Dispatch (later DTDC booking and serviceability) |
| Access | One Google sign-in against `app_users`; every signed-in user sees every app. Per-user app access is a later addition |
| AI scope | Reads live facts; **never writes** to the store, website, products, discounts or orders; three WhatsApp-bot actions, each behind a confirm tap |
| Model | A text model with tool calling through OpenRouter, one setting. Jev (`typesafe/jev-latest`, a typed-decision model, no text generation) is not used in version one |
| Look | Loupe's design system stays the base; one palette per face from the owner's three images. Home white/orange/deep green; QC soft pink/cream; Fulfilment teal/sand; Loupe unchanged |
| Dispatch | Ships with the platform as the Fulfilment face. The branch starts from `claude/dispatch` (`4c3ab5b`); its rollout steps fold into this one |

## Design

### 1. Faces

A face is a name, a hostname, a palette and a set of allowed screens:

```ts
// src/lib/faces/faces.ts
export const FACES = {
  home:  { host: 'qimati-eng.site',       label: 'Qimati',      screens: ['/home'] },
  loupe: { host: 'loupe.qimati-eng.site', label: 'Loupe',       screens: ['/console', '/upload', '/identify', '/restock', '/tracking', '/prompts', '/models', '/workflows'] },
  qc:    { host: 'qc.qimati-eng.site',    label: 'Order QC',    screens: ['/qc', '/labels'] },
  ship:  { host: 'ship.qimati-eng.site',  label: 'Fulfilment',  screens: ['/dispatch'] },
} as const
```

`faceForHost(host)` is pure: exact host match, with `localhost`/`127.0.0.1` mapped by a
`FACE_DEV` env override for local work; an unknown host is `loupe` so a misconfigured DNS record
never exposes a blank page. `screenAllowed(face, pathname)` is a prefix test on the screen list;
`/api/*`, `/login`, `/health` and static assets are allowed on every face.

**`src/proxy.ts`** (Next 16's name for middleware) runs on every request: it computes the face,
sets the `x-face` request header, and for a page path not allowed on this face returns a 307 to
the same path on the owning face's host. `/` on each face redirects to that face's first screen.
The `(shell)` layout reads `x-face`, renders the face's menu (its own screens plus an "Apps"
switcher listing the other three faces) and sets `data-face` on `<html>`. Server pages do not
change; the sidebar's hard-coded list becomes the face's list.

Dev: `FACE_DEV=home npm run dev` shows one face; without it every screen is allowed, as today.

### 2. One sign-in for four hosts

- The session cookie, the OAuth handshake cookie and the denied cookie gain
  `domain: '.qimati-eng.site'` in production (`secureCookies()` true); unchanged in dev.
- Google keeps one redirect URI, `${AUTH_BASE_URL}/api/auth/google/callback`, where
  `AUTH_BASE_URL` becomes `https://qimati-eng.site`. `/api/auth/google/start` records the caller's
  origin in the signed handshake cookie; the callback redirects to `${origin}/` only when the
  origin is one of the four face hosts (tested), else to Home.
- `/api/auth/signout` clears the domain cookie, so signing out anywhere signs out everywhere.
- Every page still calls `requireOperator()`; nothing about authorisation changes.

### 3. Home dashboard

`/home` on the Home face. Server-rendered, `revalidate = 60`.

**Health lights.** A probe is `{ key, label, kind, target }` in `src/lib/home/probes.config.ts`;
adding one is one entry. Kinds:

| Kind | What runs | Green / amber / red |
|---|---|---|
| `http` | GET `target`, 5 s timeout, no redirects followed beyond one | 2xx–3xx under 2 s / 2xx–3xx over 2 s or 4xx / timeout, 5xx, network error |
| `n8n` | `GET {N8N_URL}/api/v1/workflows/{id}` and the last 5 executions | active and last execution succeeded / active with a failed execution in the last 24 h / inactive or unreachable |
| `supabase` | `select 1` through the service client, timed | under 1 s / under 3 s / error |
| `shopify` | `shop { name }` through the existing client, timed; the response's rate-limit headers | under 1.5 s and headroom above 20 % / slower or headroom below 20 % / error |

Version-one probes: Loupe (`https://loupe.qimati-eng.site/health`), Packaging
(`https://packaging.qimati-eng.site/`), LinkedIn (`https://linkedin.qimati-eng.site/`), n8n main
bot workflow, n8n order-shipped workflow, n8n finance-report workflow, DTDC portal
(`https://customer.dtdc.in/`), DTDC connector endpoint (`https://pxapi.dtdc.in/`), Supabase,
Shopify. The DTDC lights are labelled "reachable" because the portal has no API and the connector
cannot be observed from Loupe. Workflow ids come from env (`HOME_N8N_WORKFLOWS`, a JSON map of
label to id), never from source.

Probes run in parallel server-side on each render with the timeouts above; results are cached
in memory for 30 s per process. `home_probe_state (probe_key pk, status, detail, since,
checked_at)` records only the last **change** per probe, so each light can say "red since 03:12".
Every change also writes an `events` row (`home.probe_changed`).

**Numbers**, cached 60 s: orders today (IST, created, not cancelled), paid unfulfilled, awaiting
QC (paid unfulfilled with no passed QC), awaiting tracking (open dispatch parcels), open
shortages. Shopify reads reuse `listQcOrders`' query shape; Loupe-side counts are one query each.

### 4. The AI

**Route** `POST /api/home/chat`, signed-in operators only, streaming. Request: the tab's message
history (capped at 20 turns, 6 000 tokens) plus the new message. The system prompt states the
identity, the date and time in IST, the hard rules below, and the current lights and numbers as a
compact table, so most questions need no tool call.

**Model**: `HOME_CHAT_MODEL` (default `anthropic/claude-haiku-4.5`) through OpenRouter with the
existing `OPENROUTER_API_KEY`. Per turn: at most 6 tool calls, 4 000 output tokens; per user: 60
turns an hour. A cost line per turn is written to `events` (`home.chat_turn`: model, tokens).

**Read tools** — each is a function that builds its own query from typed parameters; the model
never supplies query text:

| Tool | Parameters | Source |
|---|---|---|
| `get_status` | — | the probe cache and numbers |
| `list_orders` | `filter` ∈ {unfulfilled, awaiting_qc, awaiting_tracking, today, on_hold}, `limit` ≤ 50 | Shopify read |
| `low_stock` | `threshold` ≤ 20, `limit` ≤ 50 | Shopify read (`inventoryQuantity` per variant) |
| `qc_summary` | `days` ≤ 30 | `listRecentPasses`, `listShortages` |
| `dispatch_summary` | `days` ≤ 30 | `listParcels` |
| `bot_status` | — | n8n workflow list and last executions |
| `bot_executions` | `workflow` ∈ configured labels, `limit` ≤ 20 | n8n executions |

**Read-only Shopify, enforced twice.** Tools receive a `ReadOnlyShopifyClient` wrapper whose
`graphql()` rejects any document containing `mutation` before sending, and every tool's query is a
constant string in source. There is no tool for the website, theme, products, discounts,
customers or orders as writes, and `list_orders` returns name, date, financial and fulfilment
status, totals and item count only — no customer name, phone or address goes to the model.

**Actions** — three, all through the WhatsApp bot, all confirm-gated:

| Action | Parameters | What it calls |
|---|---|---|
| `send_finance_report` | `from`, `to` (ISO dates, ≤ 92 days, not future) | n8n webhook `BOT_REPORT_WEBHOOK_URL` with header `X-Loupe-Secret` |
| `send_staff_text` | `text` (≤ 900 chars) | n8n webhook `BOT_STAFF_TEXT_WEBHOOK_URL`, same header; the bot sends to its own staff allowlist, never to a number the model supplies |
| `send_list_as_text` | `list` (the rows a read tool just returned) plus a title | formats the rows to text and calls the staff-text webhook |

The model may only **propose** an action: it returns a tool call, the server does not execute it
but streams a confirm card carrying the action, its parameters and a one-time token (signed,
bound to the user and expiring in 5 minutes). Tapping Confirm calls `POST /api/home/action` with
that token; the server executes, logs `home.action` (actor, action, parameters, result) and
streams the outcome back into the chat. A card can be confirmed once. Until the two webhooks
exist in the bot (a separate change with its own approval), the actions are hidden from the model
and the card shows "not connected yet".

**Memory**: the tab. Nothing about a conversation is stored server-side; the `events` rows hold
cost and actions only.

### 5. Look

`data-face` on `<html>` selects one of four token sets in `globals.css` (surface, ink, chip,
accent, accent-2). Components, spacing, `rounded-*` scales and the phone layouts (D129, D131) are
shared and unchanged; the QC scanner flow is untouched. New components, Home only: `HealthLight`,
`NumberTile`, `ChatPanel` with its `ConfirmCard`. No charts in version one.

### 6. Units

| Unit | Purpose | Depends on |
|---|---|---|
| `src/lib/faces/faces.ts` | face table, `faceForHost`, `screenAllowed`, `faceHome` | — |
| `src/proxy.ts` | host → face header, screen redirects | faces |
| `src/lib/auth/cookies.ts`, `api/auth/google/*` | domain cookie, origin-bound return | existing auth |
| `src/lib/home/probes.config.ts`, `probes.ts` | probe table, runner with injected fetch/clock, cache, state table, events | Supabase, Shopify client |
| `src/lib/home/numbers.ts` | the five counts | Shopify, qc, dispatch stores |
| `src/lib/home/tools.ts` | typed read tools, `ReadOnlyShopifyClient` | Shopify client, qc/dispatch readers, n8n client |
| `src/lib/home/n8n.ts` | tiny n8n API client (workflows, executions, webhooks) | env |
| `src/lib/home/actions.ts` | action registry, confirm tokens, execution, logging | n8n client, events |
| `src/app/api/home/chat/route.ts`, `action/route.ts` | streaming chat, confirm endpoint | tools, actions, OpenRouter |
| `src/app/(shell)/home/page.tsx`, `src/components/home/*` | lights, tiles, chat panel, confirm card | above |
| `src/components/console/Sidebar.tsx` | per-face menu and Apps switcher | faces |
| `supabase/migrations/<stamp>_home_probe_state.sql` | one table, RLS deny-all, service role | — |
| `deploy/loupe.nginx.conf` | four server names | — |

### 7. Testing

- `faces`: every host, unknown host, dev override, allowed and forbidden paths, `/` redirect target.
- `proxy`: request on the wrong host → 307 to the owning host with the same path and query; API and static paths untouched.
- Auth: origin recorded and returned only for the four hosts; a foreign origin returns to Home; cookies carry the domain only when secure.
- Probes: each kind against injected fetch and clock: green, amber, red, timeout; state row written only on change; `events` row per change; cache reuse inside 30 s.
- Tools: every read tool builds its documented query; `ReadOnlyShopifyClient` rejects `mutation`; `list_orders` output contains no customer fields; parameter bounds enforced.
- Actions: a proposal never executes; a token is single-use, user-bound, expires; an action without its webhook configured is refused; the log row is written.
- Render: the home page with mixed lights, a confirm card, the per-face sidebar.
- Live, at rollout only, with the owner present.

### 8. Not in version one

Per-user app access; Jev; charts; server-side chat history; pause/resume of the bot; DTDC API
booking; the two bot webhooks themselves (a WhatsApp-bot change with its own approval; until then
the chat is read-only in practice).

### 9. Rollout — each step with the owner's go-ahead, in this order

1. Owner adds `read_merchant_managed_fulfillment_orders` and `write_merchant_managed_fulfillment_orders` to Loupe's Shopify app and re-approves the install (Dispatch, D135).
2. DNS: Cloudflare A records for `qimati-eng.site`, `qc.qimati-eng.site`, `ship.qimati-eng.site` to the VPS, proxied like `loupe.`.
3. Google console: `https://qimati-eng.site/api/auth/google/callback` added as an authorised redirect URI.
4. Server: certbot for the three hosts; `AUTH_BASE_URL=https://qimati-eng.site`; new env `N8N_URL`, `N8N_API_KEY`, `HOME_N8N_WORKFLOWS`, `HOME_CHAT_MODEL`; `NEXT_PUBLIC_*` untouched. `deploy/loupe.nginx.conf` carries the names.
5. Migrations: `20260921100000_dispatch.sql`, then the probe-state table, via `scripts/apply-migration.ts`.
6. Merge to `main` and push (deploys within a minute). The branch carries D134 and the material script from `claude/qc-v2`.
7. Live: all lights green or honestly amber; one chat question answered from live numbers; sign in on `qc.`, land on `ship.` without a second sign-in; one Dispatch parcel pushed with the owner watching, then a grouped parcel of two.
8. Later, separately: the two bot webhooks, then the chat's actions appear.
