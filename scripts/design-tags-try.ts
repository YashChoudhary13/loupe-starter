/**
 * Labels local photographs the way Loupe labels a draft (D177), and prints the labels. No database, no Shopify.
 *
 *   npx tsx scripts/design-tags-try.ts --env .env.railway NK "Necklace 970" photo1.jpg [photo2.jpg ...]
 *
 * The second word is a SKU prefix (NK, ER, BK, …) or a kind from the vocabulary (necklace, earrings, …). Only
 * HOME_CLAUDE_API_KEY and HOME_CLAUDE_WORKSPACE_ID are read from the env file; nothing is printed of either.
 * One paid call to Claude Opus per run (about US$ 0.02).
 */
import { readFileSync } from 'node:fs'

import { kindFor, labelPhotos, MAX_PHOTOS } from '../src/lib/design-tags/labeller'
import { KINDS } from '../src/lib/design-tags/vocabulary'
import { makePreview } from '../src/lib/images/preview'

const args = process.argv.slice(2)
const envAt = args.indexOf('--env')
const envFile = envAt >= 0 ? args.splice(envAt, 2)[1] : '.env'
const [kindOrPrefix, title, ...files] = args
if (!kindOrPrefix || !title || files.length === 0) {
  console.error('usage: npx tsx scripts/design-tags-try.ts [--env <file>] <SKU prefix or kind> "<title>" <photo> [photo …]')
  process.exit(2)
}

function fromEnvFile(name: string): string | undefined {
  const line = readFileSync(envFile, 'utf8').split('\n').find((l) => l.startsWith(`${name}=`))
  return line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '') || undefined
}

async function main() {
  const apiKey = fromEnvFile('HOME_CLAUDE_API_KEY')
  if (!apiKey) throw new Error(`HOME_CLAUDE_API_KEY is missing in ${envFile}`)
  const kind = kindOrPrefix in KINDS ? kindOrPrefix : kindFor(kindOrPrefix, title)
  const photos: Buffer[] = []
  for (const file of files.slice(0, MAX_PHOTOS)) photos.push(await makePreview(readFileSync(file)))
  const started = Date.now()
  const { labels, usage } = await labelPhotos({ apiKey, workspaceId: fromEnvFile('HOME_CLAUDE_WORKSPACE_ID'), photos, product: { title, options: [] }, kind })
  console.log(JSON.stringify({ kind, ...labels }, null, 2))
  console.log(`tokens: input ${usage.input}, cache read ${usage.cacheRead}, cache write ${usage.cacheWrite}, output ${usage.output}; US$ ${usage.usd}; ${((Date.now() - started) / 1000).toFixed(1)} s`)
}

main().catch((cause) => { console.error(cause instanceof Error ? cause.message : cause); process.exit(1) })
