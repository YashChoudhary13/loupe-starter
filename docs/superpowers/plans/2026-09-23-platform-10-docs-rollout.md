# Qimati Platform — Implementation Plan, part 10 of 10 (decisions, docs, full verification, rollout)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Read part 1 (`2026-09-23-platform-1-faces-auth.md`) first: its **Global Constraints** bind this task. Task 14 runs after Tasks 1–13 are complete and reviewed.

---

### Task 14: Decisions, CLAUDE.md, full verification, the progress entry, the rollout list

**Files:**
- Modify: `docs/DECISIONS.md` (append D136, D137), `CLAUDE.md`, `docs/PROGRESS.md` (new top entry)

- [ ] **Step 1: Record the decisions.** Append to `docs/DECISIONS.md`:

```markdown
### D136 — One app, four faces by hostname; one sign-in on `.qimati-eng.site` (2026-09-23)

Owner: a home dashboard at `qimati-eng.site`, QC and Fulfilment as their own apps, Loupe trimmed to listing, more apps later. Built as **one codebase, one deploy, one login, one database, one Shopify app** wearing four faces. `src/lib/faces/faces.ts` maps `qimati-eng.site` → Home (`/home`), `loupe.` → Loupe (Console, Upload, Identify, Restock, Tracking, Prompts, Models, Workflows), `qc.` → Order QC (`/qc`, `/labels`), `ship.` → Fulfilment (`/dispatch`). `src/proxy.ts` (Next 16's name for middleware) sets `x-face` from the Host header and answers a screen that belongs to another face with a 307 to that face's host, same path and query; `/` goes to the face's first screen; `/api/*`, `/login`, `/health` and assets are served everywhere; an unknown host is Loupe in production, a dev machine is unrestricted unless `FACE_DEV` names a face. The shell reads the header for its menu (the face's own screens plus an Apps switcher to the other three hosts) and `<html data-face>` selects one of four token sets in `globals.css` on the same components — Loupe unchanged, Home warm white / orange / deep green, QC pink / cream, Fulfilment teal / sand. Sign-in: the session, handshake and denied cookies carry `domain=.qimati-eng.site` when `AUTH_BASE_URL` is https on that domain; Google keeps one redirect URI on the Home host; the start route records the face whose host began the sign-in and the callback returns there; sign-out clears the domain cookie and the pre-platform host-only one. Found while planning: the QC scan and both Labels routes accepted only the `AUTH_BASE_URL` origin and would have refused every scan on `qc.`, so they now accept every face origin (`isOwnOrigin`); `scripts/apply-migration.ts` accepts the Home origin too, because the rollout changes `AUTH_BASE_URL` before the migrations run; R2's CORS origin stays `https://loupe.qimati-eng.site` (uploads happen on Loupe), so `npm run r2:cors` needs `--origin` if it is ever re-run. Rejected: one deployment per app (nothing needs isolation yet); per-user app access (a later addition).

### D137 — Home: probes with a change log, five cached numbers, a read-only assistant whose only actions are confirm-gated bot calls (2026-09-23)

Health lights are a table (`src/lib/home/probes.config.ts`; adding one is one entry): `http` (GET, one redirect followed by hand, 5 s; 2xx–3xx under 2 s green, slower or 4xx amber, 5xx / timeout / network red), `n8n` (active with no failed run in 24 h green, a failure in 24 h amber, inactive or unreachable red; ids from `HOME_N8N_WORKFLOWS`, never source), `supabase` (a head count on `app_users`: under 1 s green, under 3 s amber) and `shopify` (`shop { name }`: under 1.5 s with over 20 % throttle headroom green — read from the cost extension in the response body, because GraphQL carries no rate-limit headers). Probes run in parallel, cached 30 s per process; `home_probe_state` stores only the last change so a light can say "red since 03:12", and every change writes `home.probe_changed`. Numbers (60 s cache): orders today (IST day, `-status:cancelled`) and paid unfulfilled through `ordersCount`; awaiting QC is the open paid list (capped at 300, shown as "N+") minus passed QC sessions; awaiting tracking is `listParcels().open`; open shortages is `listShortages().open`. `/home` is `force-dynamic` like every authenticated screen; the in-process caches, not ISR, bound the cost. The assistant (`HOME_CHAT_MODEL`, default `anthropic/claude-haiku-4.5`, through OpenRouter with the existing key) has seven read tools whose queries are constants in `shopify-reads.ts`, reached only through `readOnlyShopify()`, which refuses any document containing `mutation`; no tool requests a customer, email, phone or address field, and no tool can write. Per turn: at most 6 tool calls, 4 000 output tokens, 20 turns / 24 000 characters of history from the tab; 60 turns per user per hour; one `home.chat_turn` event with model, tokens and cost. The model is called without streaming — status lines, confirm cards and the answer are streamed to the browser as NDJSON — which keeps tool-call handling trivial; token-by-token streaming can be added inside `runChatTurn` later. The three actions (`send_finance_report`, `send_staff_text`, `send_list_as_text`) stay hidden until `BOT_REPORT_WEBHOOK_URL` / `BOT_STAFF_TEXT_WEBHOOK_URL` and `BOT_WEBHOOK_SECRET` exist; the model can only propose one, which becomes a card carrying a token signed with `AUTH_SESSION_SECRET`, bound to the user, valid five minutes, spendable once (per-process nonce memory, one Node process); `POST /api/home/action` runs it, posts to n8n with `X-Loupe-Secret`, and writes `home.action`. Rejected: Jev (a typed-decision model, no text); server-side chat history; charts; any tool that writes.
```

- [ ] **Step 2: CLAUDE.md.** Four edits:

1. Directly under the `**Stack:**` line add:
```markdown
**One app, four faces (D136):** the same deploy answers on `qimati-eng.site` (Home: health lights,
numbers, the read-only assistant), `loupe.qimati-eng.site` (listing), `qc.qimati-eng.site` (Order QC,
Labels) and `ship.qimati-eng.site` (Dispatch). `src/proxy.ts` picks the face from the Host header and
redirects a screen to the host that owns it; the face table is `src/lib/faces/faces.ts`. One Google
sign-in with a `.qimati-eng.site` cookie covers all four. `FACE_DEV=home npm run dev` shows one face
locally; without it every screen is allowed.
```
2. In "Everything that knows the public URL" replace the sentence with: "`AUTH_BASE_URL` is the Home origin (`https://qimati-eng.site`) and `CRON_BASE_URL` stays the Loupe host, both in the server `.env`; the four face hosts are constants in `src/lib/faces/faces.ts` and `deploy/loupe.nginx.conf`; the `loupe_cron_base_url` vault secret (`npm run cron:configure` on the server); Shopify webhook callbacks (shopify-reconcile re-registers them); the R2 CORS origin stays `https://loupe.qimati-eng.site` (`npm run r2:cors --origin https://loupe.qimati-eng.site`); the Google OAuth redirect URI `https://qimati-eng.site/api/auth/google/callback` (Google Cloud console, by hand); `LOUPE_BASE_URL` in `worker/.env` on the GPU laptop."
3. At the end of "What it does" add:
```markdown
**Home** (`/home` on `qimati-eng.site`, D137) shows a health light per service (Loupe, Packaging,
LinkedIn, the bot's n8n workflows, DTDC reachability, Supabase, Shopify), five numbers (orders today,
paid unfulfilled, awaiting QC, awaiting tracking, open shortages) and an assistant that answers from
those facts and seven read tools. **The assistant never writes** to Shopify, the website, products,
discounts, customers or orders; its only actions are three WhatsApp-bot calls behind a confirm card,
hidden until the bot's webhooks exist.
```
4. In "Environment", after the paragraph on `SUPABASE_SERVICE_ROLE_KEY`, add: "Home needs `N8N_URL`, `N8N_API_KEY`, `HOME_N8N_WORKFLOWS` (JSON label → id) and optionally `HOME_CHAT_MODEL`; the bot actions need `BOT_REPORT_WEBHOOK_URL`, `BOT_STAFF_TEXT_WEBHOOK_URL`, `BOT_WEBHOOK_SECRET` and stay hidden without them. `FACE_DEV` is dev-only."

- [ ] **Step 3: Full verification.** Run and keep the output for the progress entry:

```bash
npx vitest run tests/faces.test.ts tests/proxy.test.ts tests/faces-origin.test.ts tests/qc-route.test.ts tests/label-print-route.test.ts tests/prepare-codes-route.test.ts tests/auth-cookies.test.ts tests/auth-routes.test.ts tests/auth-session.test.ts tests/face-shell-render.test.ts tests/app-shell-render.test.ts tests/face-theme.test.ts tests/home-n8n.test.ts tests/home-probes.test.ts tests/shopify-client.test.ts tests/home-shopify-reads.test.ts tests/home-numbers.test.ts tests/home-probe-store.test.ts tests/home-tools.test.ts tests/home-actions.test.ts tests/home-chat.test.ts tests/home-routes.test.ts tests/home-screen-render.test.ts tests/dispatch-carrier.test.ts tests/dispatch-orders.test.ts tests/dispatch-plan.test.ts tests/dispatch-push.test.ts tests/dispatch-push-loop.test.ts tests/dispatch-store.test.ts tests/dispatch-actions.test.ts tests/dispatch-rows.test.ts tests/dispatch-screen-render.test.ts tests/qc-orders.test.ts tests/qc-screen-render.test.ts
npx tsx scripts/verify-home-local-db.ts
npx tsx scripts/verify-dispatch-local-db.ts
npm run typecheck && npm run lint; npm run build
wc -l src/lib/faces/*.ts src/proxy.ts src/lib/home/*.ts src/components/home/*.tsx src/app/api/home/*/route.ts src/components/console/Sidebar.tsx src/lib/auth/cookies.ts
```
Expected: every test file PASS; `home schema proof: 9 checks passed`; `dispatch schema proof: 9 checks passed`; typecheck clean; lint shows exactly the 5 baseline errors in `scripts/tmp-promote-worn.ts`, `src/components/live/LiveActivity.tsx`, `tests/app-shell-render.test.ts` and nothing else; `next build` compiles and lists `/home`, `/api/home/chat`, `/api/home/action` and the proxy; every file under 500 lines.

- [ ] **Step 4: Write the `docs/PROGRESS.md` entry** at the top, using the file's template. Title `## 2026-09-23 — Platform: four faces, one sign-in, Home with lights, numbers and a read-only assistant (D136, D137)`. Under **Built**, one line per unit (faces + proxy; own origins; cookies + sign-in; shell + palettes + nginx; n8n; probes + table + proof; reads + numbers + server; tools; actions; chat; routes; screen; docs). Under **Verified** paste the real output of Step 3. Under **Not finished** list every rollout step below as not done, plus: no `npm run dev` look at any face, no live chat turn, no live probe, the bot webhooks do not exist, the `tests/schema.test.ts` `TABLES` assertion has not been run against production (it would fail until the migration is applied). Under **Surprises** record what the task reviews changed (from the SDD ledger) and the two planning finds (origin checks, apply-migration origin). Under **Next session should start with** name rollout step 1.

- [ ] **Step 5: Commit**

```bash
git add docs/DECISIONS.md docs/PROGRESS.md CLAUDE.md
git commit -m "docs(platform): D136 faces and one sign-in, D137 Home probes, numbers and the read-only assistant; progress entry"
```

- [ ] **Step 6: Rollout — the owner's steps, in this order, each with an explicit go-ahead at the time. Stop and ask before each; do not perform any of them from a task.**

1. **Shopify scopes (Dispatch, D135).** Owner adds `read_merchant_managed_fulfillment_orders` and `write_merchant_managed_fulfillment_orders` to Loupe's Shopify app in the Dev Dashboard and re-approves the install. Verify with a read-only `currentAppInstallation { accessScopes { handle } }` query; both handles must be listed.
2. **DNS.** Cloudflare A records for `qimati-eng.site`, `qc.qimati-eng.site` and `ship.qimati-eng.site` to the VPS, proxied like `loupe.`.
3. **Google console.** Add `https://qimati-eng.site/api/auth/google/callback` to the OAuth client's authorised redirect URIs (keep the Loupe one).
4. **Server.** (a) In `~/loupe/shared/.env` set `AUTH_BASE_URL=https://qimati-eng.site` and add `N8N_URL`, `N8N_API_KEY`, `HOME_N8N_WORKFLOWS`, `HOME_CHAT_MODEL`; do **not** set the three `BOT_*` variables; **do not restart** — the deploy in step 6 restarts with the new values (restarting the old code first would point Google's callback at a host nginx does not serve yet). Mirror the same changes into the local `.env.railway`. (b) Install the branch's `deploy/loupe.nginx.conf` by hand once (`sudo install -m 644 … /etc/nginx/sites-available/loupe && sudo nginx -t && sudo systemctl reload nginx`) so the three new names answer the ACME challenge. (c) `sudo certbot certonly --webroot -w /var/www/html --cert-name loupe.qimati-eng.site --expand -d loupe.qimati-eng.site -d qimati-eng.site -d qc.qimati-eng.site -d ship.qimati-eng.site`, then `sudo systemctl reload nginx`. The certificate paths do not change, so the deploy's own install of the same file is a no-op.
5. **Migrations**, from this worktree with the production env mirror: `npx tsx scripts/apply-migration.ts 20260921100000_dispatch.sql <env file> output/platform/dispatch-migration.json` then `npx tsx scripts/apply-migration.ts 20260923100000_home_probe_state.sql <env file> output/platform/home-migration.json`. Confirm all three tables exist and `anon` cannot read them.
6. **Deploy.** Merge `claude/platform` into `main` and push — production deploys within a minute. The branch carries D134, the material script and Dispatch (D135). Watch `~/loupe/shared/autodeploy.log` and `journalctl -u loupe -f`; the health check on :3000 must pass.
7. **Live, owner present.** All lights green or honestly amber (the Loupe light probes `/health`, which counts every table and probes Google — amber over 2 s is honest, not broken); one chat question answered from live numbers, and its `home.chat_turn` row visible; sign in on `qc.`, then open `ship.` — no second sign-in; scan one QC label on `qc.` (the origin fix) and print one label; sign out on `loupe.` and confirm the old host-only cookie is gone; one Dispatch parcel pushed with the owner watching, then a grouped parcel of two (also call `claim` twice on one row and confirm the second returns false — the D135 note).
8. **Later, separately.** The two bot webhooks in n8n (their own change and approval), then the three `BOT_*` variables on the server, `sudo systemctl restart loupe`, and the chat's actions appear.
9. **Memory vault.** Update `/Users/yash/Desktop/Qimati Memory/systems/loupe.md` (faces, Home, D136/D137, the new scopes), `operations/credential-register.md` (key names only: `N8N_URL`, `N8N_API_KEY`, `HOME_N8N_WORKFLOWS`, `HOME_CHAT_MODEL`, the three `BOT_*`), and one `log.md` entry with the evidence from step 7.
