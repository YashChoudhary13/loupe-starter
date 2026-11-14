/** Diagnostic, changes nothing: shows today's deliveries, then tries the link update inside a transaction that is always rolled back, to read the database's own error. */
import { pgClient } from './lib/pg'

async function main() {
  const c = pgClient(); await c.connect()
  try {
    const rows = await c.query(`select f.id, f.agent_batch, f.agent_tag, f.status, f.source, f.agent_source_photo_id is not null as linked, f.product_description is not null as has_alt,
                                       to_char(f.discovered_at at time zone 'Asia/Kolkata', 'HH24:MI') as at, f.filename
                                  from public.intake_files f where f.agent_batch is not null order by f.discovered_at desc limit 14`)
    for (const r of rows.rows) console.log(`${r.at} ${String(r.agent_batch).padEnd(40)} ${String(r.agent_tag).padEnd(12)} linked ${r.linked} alt ${r.has_alt} ${r.status} ${r.source} ${String(r.filename).slice(0, 50)}`)
    const all = await c.query(`select count(*)::int n, count(agent_source_photo_id)::int linked, max(discovered_at) filter (where agent_source_photo_id is not null) as last_linked from public.intake_files where source = 'manual' and agent_batch is not null`)
    console.log('all agent deliveries:', JSON.stringify(all.rows[0]))
    const pick = await c.query(`select f.id as intake, p.id as photo from public.intake_files f join public.agent_jobs j on j.label = f.agent_batch
                                  join public.agent_job_photos p on p.job_id = j.id and p.status = 'uploaded'
                                 where f.agent_source_photo_id is null and j.label = '2026-11-14 12.27' limit 1`)
    if (!pick.rows[0]) { console.log('nothing to test with'); return }
    for (const [name, sql] of [
      ['link only', `update public.intake_files set agent_source_photo_id = $2 where id = $1`],
      ['link + alt', `update public.intake_files set agent_source_photo_id = $2, product_description = 'test', description_missing_at = null where id = $1`],
    ] as const) {
      await c.query('begin')
      try { const r = await c.query(sql, [pick.rows[0].intake, pick.rows[0].photo]); console.log(`${name}: would update ${r.rowCount} row(s), no error`) }
      catch (e) { console.log(`${name}: ERROR ${String((e as Error).message).slice(0, 300)}`) }
      finally { await c.query('rollback') }
    }
    const pol = await c.query(`select tgname from pg_trigger where tgrelid = 'public.intake_files'::regclass and not tgisinternal`)
    console.log('triggers on intake_files:', pol.rows.map((r) => r.tgname).join(', '))
  } finally { await c.end() }
}
main().catch((e) => { console.error(String(e).slice(0, 400)); process.exit(1) })
