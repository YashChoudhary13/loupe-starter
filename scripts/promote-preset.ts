/**
 * Promote the newest revision of a style preset, from the terminal.
 *
 *   npm run prompt:promote necklace
 *   npm run prompt:promote            # lists every preset and what is live
 *
 * WHY THIS EXISTS
 *
 * `/prompts` can already do this — "Promote this version" on the image or
 * describe prompt — but the prominent control on that page is the preset
 * selector, and until 20260808180000 that selector silently did nothing when the
 * preset was already live. Two worn-V necklace revisions sat unused for a day
 * because of it, and the visible symptom was "the new prompt does not work".
 *
 * This calls the same audited SQL as the console, so the promotion is recorded
 * in `events` with the actor exactly as a click would be. It is a convenience,
 * not a second code path.
 *
 * A prompt change alters every product's look and is never a side effect of
 * deployment (D51), so this is deliberately a command you run, not something a
 * migration or a deploy does for you.
 */
import { pgClient } from './lib/pg'

interface PresetRow {
  preset_slug: string
  kind: 'describe' | 'image'
  newest_name: string
  live_name: string | null
  up_to_date: boolean
}

const SURVEY = `
  with newest as (
    select distinct on (p.preset_slug, p.kind)
           p.preset_slug, p.kind, p.id, p.name
      from public.prompts as p
     where p.preset_slug is not null
     order by p.preset_slug, p.kind, p.created_at desc, p.id desc
  ),
  live as (
    select p.kind, p.id, p.name, p.preset_slug
      from public.prompts as p
     where p.is_default and p.archived_at is null
  )
  select n.preset_slug,
         n.kind,
         n.name as newest_name,
         l.name as live_name,
         (l.id is not null and l.id = n.id) as up_to_date
    from newest as n
    left join live as l on l.kind = n.kind and l.preset_slug = n.preset_slug
   order by n.preset_slug, n.kind
`

function report(rows: readonly PresetRow[]): void {
  const bySlug = new Map<string, PresetRow[]>()
  for (const row of rows) bySlug.set(row.preset_slug, [...(bySlug.get(row.preset_slug) ?? []), row])

  for (const [slug, halves] of bySlug) {
    const live = halves.every((half) => half.live_name !== null)
    const stale = halves.filter((half) => half.live_name !== null && !half.up_to_date)
    const mark = !live ? ' ' : stale.length > 0 ? '!' : '●'
    console.log(`${mark} ${slug}`)
    for (const half of halves) {
      const state = half.live_name === null
        ? 'not live'
        : half.up_to_date
          ? 'live, current'
          : `LIVE IS STALE — running "${half.live_name}"`
      console.log(`      ${half.kind.padEnd(8)} newest: ${half.newest_name}`)
      console.log(`      ${' '.repeat(8)} ${state}`)
    }
  }
  console.log('\n● live and current   ! live but running an older revision   (blank) not live')
}

async function main(): Promise<void> {
  const slug = process.argv[2]?.trim()
  const client = pgClient()
  await client.connect()
  try {
    const survey = await client.query<PresetRow>(SURVEY)

    if (!slug) {
      report(survey.rows)
      console.log('\nTo switch or refresh one:  npm run prompt:promote <slug>')
      return
    }

    if (!survey.rows.some((row) => row.preset_slug === slug)) {
      const known = [...new Set(survey.rows.map((row) => row.preset_slug))].join(', ')
      throw new Error(`Unknown preset "${slug}". Known presets: ${known}`)
    }

    const actor = process.env.PROMPT_PROMOTE_ACTOR?.trim() || `cli:${process.env.USER ?? 'operator'}`
    const applied = await client.query<{ kind: string; prompt_id: string; changed: boolean }>(
      `select * from public.promote_prompt_preset($1, $2)`,
      [slug, actor],
    )

    console.log(`promote_prompt_preset('${slug}') as ${actor}:`)
    for (const row of applied.rows) {
      console.log(`   ${row.kind.padEnd(8)} ${row.changed ? 'promoted' : 'already current'}`)
    }

    /**
     * Read the live pair back rather than trusting the return value. If the
     * deployed `promote_prompt_preset` is still the pre-20260808180000 version,
     * it reports `changed: false` and leaves an older revision running — the
     * precise failure this script was written to make visible.
     */
    const after = await client.query<PresetRow>(SURVEY)
    const halves = after.rows.filter((row) => row.preset_slug === slug)
    const stale = halves.filter((row) => !row.up_to_date)
    console.log('\nlive now:')
    for (const half of halves) console.log(`   ${half.kind.padEnd(8)} ${half.live_name ?? '(not live)'}`)

    if (stale.length > 0) {
      console.error(
        `\nNOT FULLY APPLIED — ${stale.map((row) => row.kind).join(' and ')} still ` +
          `running an older revision.\nThe deployed promote_prompt_preset is probably the old one; ` +
          `apply 20260808180000 with npm run db:push, then run this again.`,
      )
      process.exitCode = 1
    }
  } finally {
    await client.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
