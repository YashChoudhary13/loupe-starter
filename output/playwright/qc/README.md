# Order QC iPad review

Branch: `codex/qc-ipad`, based on `origin/main` at `1149888`. No push or deployment.

All screenshots use fictional orders and locally generated jewellery illustrations. The preview bundles the actual QC components, list page and app shell with in-browser API doubles. It does not load `.env`, contact Shopify or Supabase, or run a QC command against a real order. Fonts come from the existing Next build, with Arial as a fallback when no build is available.

## Screenshots

- [Order list, 1180 × 820](list-ipad.png)
- [Order with an attention message, 1180 × 820](order-ipad.png)
- [Accepted scan and 96px photo, 1180 × 820](scan-ipad.png)
- [Accepted scan, smallest iPad layout, 1024 × 768](scan-ipad-small.png)
- [Phone scan controls, 390 × 844](order-phone.png)
- [Phone item list, 390 × 844](order-phone-items.png)
- [Passed order on hold](passed-hold-ipad.png)
- [Passed order ready to ship](passed-ready-ipad.png)
- [Before: page jumped back to the scan field](before-after-hand.png)

## Evidence

[browser-proof.json](browser-proof.json) contains the viewport measurements, action outcomes and exact before/after scroll positions. At 1180 × 820:

| Action | Before | After |
| --- | ---: | ---: |
| Baseline By hand (page scroll) | 2290 | 0 |
| Baseline Tick removed (page scroll) | 3413 | 0 |
| New By hand (right pane) | 2204 | 2204 |
| New Tick removed (right pane) | 2204 | 2204 |
| New Mark short / undo / reset | 2204 | 2204 |
| New By hand, visible pointer click | 4170 | 4170 |
| New automatic 30-second refresh | 4170 | 4170 |
| New Complete QC | 1631 | 1631 |

The controls above the bottom viewport were triggered with DOM clicks on the real buttons, deliberately avoiding Playwright's automatic scroll-into-view. A visible pointer click was also checked. Every action's resulting message was asserted; a no-op button cannot pass this check. The page, screen and left controls stayed at scroll position zero. A rejected scan kept the same message and `role="alert"` after the automatic refresh.

Checked 1024 × 768, 1180 × 820, 1366 × 1024, 1440 × 900 and 390 × 844: no horizontal overflow, iPad controls fit, amber messages are 16px. The 96 × 96 last-scan image is fully visible at 1024 × 768. Order rows measured at least 90.5px tall.

[page-cost.json](page-cost.json) records the separate authorized **read-only** production query: 250 requested, 68 open orders returned, no next page; requested cost 13 / actual cost 5, throttle 1995 / 2000 remaining, restore rate 100. The existing status lookup accepted all 68 IDs and returned 37 saved sessions. Missing sessions correctly mean Not checked. No mutation was sent. The list now requests 250; if pagination is needed, both counts say “on this page”. No guessed unit counts were added.

## Reproduce without live credentials

```sh
node scripts/qc-preview.mjs
# In another terminal, using an available Playwright CLI installation:
playwright-cli -s=qc-ipad open http://127.0.0.1:4178/qc --browser=chrome
playwright-cli -s=qc-ipad run-code --filename tests/fixtures/qc-browser-checks.txt
```

The fixture runner listens on loopback only. `/qc/90001?ready` permits fixture completion, `?passed` shows a held pass, `?passed&shipping` shows ready to ship, and `?history` opens the saved record. The browser script needs about 40 seconds because it waits for an actual periodic refresh.

Verification on this branch:

```text
npx vitest run tests/qc
Test Files  7 passed (7)
Tests       43 passed (43)
npm run typecheck       exit 0
npm run lint            exit 0
npx next build --webpack exit 0
git diff --check        exit 0
```

Three pre-existing lint blockers were corrected separately: types in the temporary media script (never executed), the LiveActivity quiet ref synchronized in an effect, and a documented lint exception for the existing typed `createElement` test. Only QC tests were run, as instructed.

Not verified: physical iPad Safari, the Bluetooth scanner gun, camera hardware or a real packing session. Review these screenshots before considering deployment.
