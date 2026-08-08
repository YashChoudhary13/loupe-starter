import { readFileSync } from 'node:fs'
import { pgClient } from './lib/pg'
async function main() {
  const c = pgClient(); await c.connect()
  const cur = await c.query(`select kind, name from prompts where is_default and archived_at is null order by kind`)
  console.log('LIVE right now:'); for (const x of cur.rows) console.log('   ', x.kind, '|', x.name)
  await c.query('begin')
  try {
    await c.query(readFileSync('supabase/migrations/20260808180000_promote_preset_picks_up_newer_revisions.sql','utf8'))
    try {
      await c.query(`select * from public.promote_prompt_preset('marble','test:dbg')`)
      console.log('marble promote OK')
    } catch (e: any) {
      console.log('ERROR:', e.message)
      console.log('  where:', e.where)
    }
  } finally { await c.query('rollback') }
  await c.end()
}
main().catch((e) => { console.error(e.message); process.exit(1) })
