/**
 * The most important test in this project.
 *
 * The live store carries two different products on SKU RS221 because the number
 * was allocated by reading a value and then writing value + 1, and two people
 * did that at once. RS218, RS220 and RS222 are missing from the sequence for the
 * same reason. This file exists so that cannot happen again.
 *
 * These tests hit the real Supabase project. That is deliberate: a mocked
 * counter proves nothing about Postgres row locks, which is the entire mechanism
 * under test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { maxOverlap, readCounter, rpc, serviceClient, setCounter } from './helpers/db'

const PREFIX = 'NK'
const CALLS = 100

let baseline = 0

beforeAll(async () => {
  baseline = await readCounter(PREFIX)
})

afterAll(async () => {
  // Leave the seed state exactly as we found it — Phase 2 sets the real starting
  // numbers, and a test run must not silently consume any of them.
  await setCounter(PREFIX, baseline)
})

describe('next_sku — allocation under concurrency', () => {
  it(`allocates ${CALLS} distinct consecutive integers when called ${CALLS} times at once`, async () => {
    const start = await readCounter(PREFIX)

    // Fire all of them together. No batching, no throttling, no await in a loop.
    const outcomes = await Promise.all(
      Array.from({ length: CALLS }, () => rpc('next_sku', { p_prefix: PREFIX })),
    )

    // `status: 0` means fetch itself threw — the TCP connection was refused or timed
    // out. Firing 100 simultaneous TLS connections at a pooled Postgres occasionally
    // loses one, and that is a property of the laptop's network, not of the counter.
    // It is kept strictly separate from a SERVER failure (any real HTTP status), which
    // is still a hard failure: a 500 from next_sku is exactly what this test is for.
    const transportFailures = outcomes.filter((o) => !o.ok && o.status === 0)
    const serverFailures = outcomes.filter((o) => !o.ok && o.status !== 0)
    const failed = outcomes.filter((o) => !o.ok)
    const values = outcomes.filter((o) => o.ok).map((o) => o.value as number)
    const distinct = new Set(values)
    const sorted = [...values].sort((a, b) => a - b)
    const expected = Array.from({ length: CALLS }, (_, i) => start + i + 1)
    const overlap = maxOverlap(outcomes)
    const wallMs = Math.max(...outcomes.map((o) => o.finishedAt)) - Math.min(...outcomes.map((o) => o.startedAt))
    const after = await readCounter(PREFIX)

    const duplicates = values.filter((v, _i, arr) => arr.indexOf(v) !== arr.lastIndexOf(v))
    const gaps = expected.filter((v) => !distinct.has(v))

    console.log(
      [
        '',
        `  next_sku('${PREFIX}') × ${CALLS}, all in flight simultaneously`,
        `  ─────────────────────────────────────────────────────────────`,
        `  counter before          ${start}`,
        `  counter after           ${after}`,
        `  calls issued            ${CALLS}`,
        `  calls succeeded         ${values.length}`,
        `  calls failed            ${failed.length}`,
        `  distinct values         ${distinct.size}`,
        `  duplicates              ${duplicates.length === 0 ? 'none' : [...new Set(duplicates)].join(', ')}`,
        `  gaps in sequence        ${gaps.length === 0 ? 'none' : gaps.join(', ')}`,
        `  range returned          ${sorted[0]} … ${sorted[sorted.length - 1]}`,
        `  range expected          ${expected[0]} … ${expected[expected.length - 1]}`,
        `  peak concurrent calls   ${overlap}   (1 would mean they queued, not raced)`,
        `  wall clock              ${wallMs.toFixed(0)} ms`,
        '',
      ].join('\n'),
    )

    // A real HTTP failure from next_sku is never tolerated.
    expect(
      serverFailures,
      `${serverFailures.length} call(s) were answered with an error: ${JSON.stringify(serverFailures.slice(0, 3))}`,
    ).toHaveLength(0)

    // A dropped connection is tolerated, but only a few, and it is reported. If most
    // of the burst never left the machine there was no concurrency to speak of and a
    // green result would mean nothing.
    expect(
      transportFailures.length,
      `${transportFailures.length}/${CALLS} calls never reached the server. Too many to call this a concurrency test.`,
    ).toBeLessThanOrEqual(CALLS / 10)

    // ── THE ASSERTION THIS FILE EXISTS FOR ────────────────────────────────────
    // Not one pair of products may share a number, however many calls got through.
    expect(distinct.size, 'every allocated number must be unique — RS221 is what this prevents').toBe(
      values.length,
    )
    expect(duplicates, 'two products on one SKU is the failure this test is named after').toEqual([])

    // Every number handed out is above where the counter started and no higher than
    // where it finished — nothing was invented, nothing was reissued.
    expect(Math.min(...values), 'no number below the starting point').toBeGreaterThan(start)
    expect(Math.max(...values), 'no number above where the counter finished').toBeLessThanOrEqual(after)

    // The counter moved at least once per success, and never more than once per call
    // issued. A lost RESPONSE (as opposed to a lost connection) can still have
    // incremented the counter, which is a burnt number — expected and harmless.
    expect(after, 'the counter must have moved at least once per successful call').toBeGreaterThanOrEqual(
      start + values.length,
    )
    expect(after, 'the counter must never move more than once per call issued').toBeLessThanOrEqual(
      start + CALLS,
    )

    // When every call completed, demand the strict result: exactly consecutive, no
    // gaps at all. Relaxing this unconditionally would let a genuine regression hide
    // behind a network excuse.
    if (failed.length === 0) {
      expect(values).toHaveLength(CALLS)
      expect(sorted, 'must be exactly consecutive — no duplicates, no gaps').toEqual(expected)
      expect(after, 'the counter must land exactly CALLS higher').toBe(start + CALLS)
    }

    // Guard against a false pass: if the calls had queued one behind another
    // they would produce a perfect sequence without ever contending for the row
    // lock, and this test would prove nothing.
    expect(overlap, 'calls must genuinely have overlapped in time').toBeGreaterThan(1)
  })

  it('keeps each prefix on its own sequence when several are allocated at once', async () => {
    const prefixes = ['NK', 'ER', 'BK', 'CB', 'RS', 'AK'] as const
    const before = Object.fromEntries(
      await Promise.all(prefixes.map(async (p) => [p, await readCounter(p)] as const)),
    ) as Record<(typeof prefixes)[number], number>

    const perPrefix = 20
    const outcomes = await Promise.all(
      prefixes.flatMap((p) =>
        Array.from({ length: perPrefix }, async () => ({ p, r: await rpc('next_sku', { p_prefix: p }) })),
      ),
    )

    try {
      const dropped: string[] = []

      for (const p of prefixes) {
        const forPrefix = outcomes.filter((o) => o.p === p)
        const values = forPrefix.filter((o) => o.r.ok).map((o) => o.r.value as number)
        const serverFailures = forPrefix.filter((o) => !o.r.ok && o.r.status !== 0)
        const transportFailures = forPrefix.filter((o) => !o.r.ok && o.r.status === 0)
        const after = await readCounter(p)

        // Same split as the 100-way test: an answered error is a bug, a dropped
        // connection is the laptop's network. See the comment there.
        expect(serverFailures, `prefix ${p} was answered with an error`).toHaveLength(0)
        if (transportFailures.length > 0) dropped.push(`${p}×${transportFailures.length}`)

        // The point of THIS test is that sequences do not bleed into one another.
        // That holds regardless of how many calls got through.
        expect(new Set(values).size, `prefix ${p}: duplicate number issued`).toBe(values.length)
        expect(
          values.every((v) => v > before[p] && v <= before[p] + perPrefix),
          `prefix ${p}: a number came from outside this prefix's own range`,
        ).toBe(true)
        expect(after, `counter for ${p} moved less than the successes it reported`).toBeGreaterThanOrEqual(
          before[p] + values.length,
        )
        expect(after, `counter for ${p} moved more than the calls issued`).toBeLessThanOrEqual(
          before[p] + perPrefix,
        )

        if (transportFailures.length === 0) {
          const expected = Array.from({ length: perPrefix }, (_, i) => before[p] + i + 1)
          expect([...values].sort((a, b) => a - b), `prefix ${p}`).toEqual(expected)
          expect(after, `counter for ${p}`).toBe(before[p] + perPrefix)
        }
      }

      console.log(
        `\n  6 prefixes × ${perPrefix} concurrent calls — each sequence advanced independently, none bled into another.` +
          (dropped.length > 0 ? `  (connections dropped: ${dropped.join(', ')})` : '') +
          '\n',
      )
    } finally {
      for (const p of prefixes) await setCounter(p, before[p])
    }
  })
})

describe('next_sku — unknown prefix', () => {
  it("raises for 'NOPE' rather than returning null", async () => {
    const before = await readCounter(PREFIX)
    const outcome = await rpc('next_sku', { p_prefix: 'NOPE' })

    console.log(
      [
        '',
        "  next_sku('NOPE')",
        `  HTTP status   ${outcome.status}`,
        `  SQLSTATE      ${outcome.error?.code}`,
        `  message       ${outcome.error?.message}`,
        `  hint          ${outcome.error?.hint}`,
        '',
      ].join('\n'),
    )

    expect(outcome.ok, 'must not succeed').toBe(false)
    expect(outcome.value, 'must not return a value').toBeNull()
    expect(outcome.error?.code, 'invalid_parameter_value').toBe('22023')
    expect(outcome.error?.message).toContain('unknown SKU prefix')

    // The important half: it must not have quietly invented a counter.
    const { data, error } = await serviceClient()
      .from('sku_counters')
      .select('sku_prefix')
      .eq('sku_prefix', 'NOPE')
    expect(error).toBeNull()
    expect(data, 'no sku_counters row may be created for an unknown prefix').toEqual([])

    // And it must not have disturbed a real counter.
    expect(await readCounter(PREFIX)).toBe(before)
  })

  it('raises for a null prefix', async () => {
    const outcome = await rpc('next_sku', { p_prefix: null })
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('22023')
  })
})

describe('next_sku — implementation shape', () => {
  it('is a single UPDATE ... RETURNING, not a SELECT followed by an UPDATE', async () => {
    const { data, error } = await serviceClient().rpc('_loupe_function_source', {
      p_name: 'next_sku',
    })

    // This introspection helper is optional — skip cleanly rather than fail if a
    // future migration drops it.
    if (error) {
      console.log(`\n  (source introspection unavailable: ${error.message} — skipping)\n`)
      return
    }

    const src = String(data).toLowerCase()
    const selects = (src.match(/\bselect\b/g) ?? []).length
    const updates = (src.match(/\bupdate\b/g) ?? []).length

    expect(src).toContain('returning')
    expect(updates, 'exactly one UPDATE').toBe(1)
    expect(selects, 'no SELECT of last_number before the UPDATE').toBe(0)
  })
})
