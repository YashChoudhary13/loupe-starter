/**
 * Proves the service_role key cannot be reached from a client component.
 *
 *   npm run verify:isolation
 *
 * Three steps, because the obvious check on its own is close to worthless:
 *
 *   CONTROL  — build a client component that uses the PUBLISHABLE key, and
 *              confirm that key really does get inlined into .next/static.
 *              Without this, "the service_role key is not in the bundle" might
 *              only mean the scan is looking in the wrong place.
 *
 *   NEGATIVE — in that same build, confirm the SERVICE_ROLE key is absent.
 *
 *   ACTIVE   — build a client component that imports the server-only module and
 *              require the build to FAIL. `import 'server-only'` is a guarantee
 *              only if something actually enforces it.
 *
 * CLAUDE.md hard rule 7. This tool publishes to a live store.
 *
 * NOTE: the probe route must NOT be named with a leading underscore — the App
 * Router treats `_folder` as a private folder, excludes it from routing, and the
 * probe would never be bundled at all. That produces a false pass.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { config } from 'dotenv'

config({ path: '.env', quiet: true })
config({ path: '.env.local', override: true, quiet: true })

const ROOT = process.cwd()
const PROBE_DIR = join(ROOT, 'src/app/isolation-probe')
const CLIENT_ASSET_ROOT = join(ROOT, '.next/static')

function build(): { ok: boolean; output: string } {
  try {
    return {
      ok: true,
      output: execFileSync('npx', ['next', 'build'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
      }),
    }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, output: `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message ?? ''}` }
  }
}

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else yield full
  }
}

function findInClientAssets(needle: string): string[] {
  const hits: string[] = []
  for (const file of walk(CLIENT_ASSET_ROOT)) {
    if (readFileSync(file, 'utf8').includes(needle)) hits.push(relative(ROOT, file))
  }
  return hits
}

function writeProbe(source: string): void {
  mkdirSync(PROBE_DIR, { recursive: true })
  writeFileSync(join(PROBE_DIR, 'page.tsx'), source)
}

function cleanUp(): void {
  rmSync(PROBE_DIR, { recursive: true, force: true })
  // Also drop Next's generated route types. STEP 3 builds with the probe route
  // present, which makes `.next/types/validator.ts` import
  // `src/app/isolation-probe/page.js`; deleting only the probe leaves that import
  // dangling and `npm run typecheck` then fails with TS2307 on a file nobody wrote.
  // Next regenerates the directory on the next build or dev run.
  rmSync(join(ROOT, '.next/types'), { recursive: true, force: true })
}

function fail(msg: string): never {
  cleanUp()
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()
if (!serviceKey) fail('SUPABASE_SERVICE_ROLE_KEY is not set — nothing to check for.')
if (!publishableKey) fail('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set — no control available.')

cleanUp()

// ---------------------------------------------------------------------------
console.log('STEP 1 — control: a client component using the publishable key')
console.log('─'.repeat(74))

writeProbe(`'use client'
// Temporary. Written by scripts/verify-secret-isolation.ts, deleted again below.
import { supabaseBrowser } from '@/lib/supabase/browser'

export default function IsolationProbe() {
  return <button onClick={() => void supabaseBrowser()}>probe</button>
}
`)

console.log('  building …')
const withBrowserClient = build()
if (!withBrowserClient.ok) {
  fail(`The build failed with a legitimate browser-client component.\n${withBrowserClient.output.slice(-3000)}`)
}

const publishableHits = findInClientAssets(publishableKey)
console.log(`  publishable key found in ${publishableHits.length} client asset(s)`)
if (publishableHits.length === 0) {
  fail(
    'The publishable key was NOT inlined into any client asset.\n' +
      '  The scan is therefore not proving anything about what does or does not ship.',
  )
}
console.log(`    e.g. ${publishableHits[0]}`)
console.log('  control passes — the scan does see values that reach the browser ✓')

// ---------------------------------------------------------------------------
console.log('\nSTEP 2 — the same build must NOT contain any server-side secret')
console.log('─'.repeat(74))

const assetCount = [...walk(CLIENT_ASSET_ROOT)].length
console.log(`  scanned ${assetCount} client asset(s) under .next/static`)

// The service_role key, and its signature segment alone in case something
// re-encodes the JWT.
const serviceNeedles = [serviceKey, serviceKey.split('.')[2] ?? ''].filter((n) => n.length > 20)
const serviceLeaks = serviceNeedles.flatMap(findInClientAssets)
console.log('  searched for the full service_role key and its signature segment alone')
if (serviceLeaks.length > 0) {
  fail(`service_role key found in client assets:\n    ${[...new Set(serviceLeaks)].join('\n    ')}`)
}
console.log('  service_role key:      NOT PRESENT ✓')

// Phase 2. src/lib/shopify/* deliberately does not carry `import 'server-only'`
// (scripts and vitest both run in plain Node, where that shim throws), so the
// guarantee has to be demonstrated rather than declared. This tool publishes to a
// live store — the Shopify client secret reaching a browser is the worst leak here.
const shopifySecret = process.env.SHOPIFY_CLIENT_SECRET?.trim()
if (shopifySecret && shopifySecret.length > 12) {
  const shopifyLeaks = findInClientAssets(shopifySecret)
  if (shopifyLeaks.length > 0) {
    fail(
      `SHOPIFY_CLIENT_SECRET found in client assets:\n    ${[...new Set(shopifyLeaks)].join('\n    ')}`,
    )
  }
  console.log('  SHOPIFY_CLIENT_SECRET: NOT PRESENT ✓')
} else {
  console.log('  SHOPIFY_CLIENT_SECRET: not set — nothing to check for')
}

// Phase 3A. The base64 service-account document contains the private signing key,
// and CRON_SECRET authorises every automated intake endpoint. Both are runtime
// server values even though neither resembles a JWT.
//
// Phase 4 adds two more. GOOGLE_OAUTH_CLIENT_SECRET completes the sign-in
// exchange, and AUTH_SESSION_SECRET signs the session cookie — anyone holding it
// can mint a cookie for any operator, so it is strictly worse to leak than the
// cookie itself.
for (const [name, secret] of [
  ['GOOGLE_SERVICE_ACCOUNT_JSON', process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim()],
  ['CRON_SECRET', process.env.CRON_SECRET?.trim()],
  ['GOOGLE_OAUTH_CLIENT_SECRET', process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim()],
  ['AUTH_SESSION_SECRET', process.env.AUTH_SESSION_SECRET?.trim()],
] as const) {
  if (secret && secret.length > 12) {
    const leaks = findInClientAssets(secret)
    if (leaks.length > 0) {
      fail(`${name} found in client assets:\n    ${[...new Set(leaks)].join('\n    ')}`)
    }
    console.log(`  ${name}: NOT PRESENT ✓`)
  } else {
    console.log(`  ${name}: not set — nothing to check for`)
  }
}

// ---------------------------------------------------------------------------
console.log('\nSTEP 3 — a client component importing the server-only module must fail the build')
console.log('─'.repeat(74))

writeProbe(`'use client'
// Temporary. This import MUST fail the build.
import { supabaseServer } from '@/lib/supabase/server'

export default function IsolationProbe() {
  return <button onClick={() => void supabaseServer()}>probe</button>
}
`)

console.log('  wrote a client component that imports @/lib/supabase/server')
console.log('  building …')
const withServerClient = build()
cleanUp()

if (withServerClient.ok) {
  fail(
    'The build SUCCEEDED with a client component importing the service-role client.\n' +
      "  `import 'server-only'` is not being enforced — the key can reach the browser.",
  )
}

console.log('  build FAILED, as required ✓')

const excerpt = withServerClient.output
  .split('\n')
  .filter((l) => l.trim() && /error|server-only|server component|supabase\/server|isolation-probe/i.test(l))
  .slice(0, 8)
  .map((l) => `    ${l.trim()}`)
  .join('\n')
console.log(excerpt)

if (!/server-only|Server Component|server module/i.test(withServerClient.output)) {
  fail(
    'The build failed, but not obviously because of server-only.\n' +
      '  Confirm the reason is the import boundary and not an unrelated error.',
  )
}

console.log('\n✓ All three steps passed. The service_role key cannot reach a client component.\n')
