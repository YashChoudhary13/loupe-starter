import { readFileSync, writeFileSync } from 'node:fs'
import { config } from 'dotenv'
config({ path: '.env', quiet: true })
config({ path: '.env.local', override: true, quiet: true })
import { OpenRouterClient } from '../src/lib/enhance/openrouter'
import { resolveImagePrompt } from '../src/lib/enhance/prompt'
import { composeClientPair } from '../src/lib/prompts/matrix'

const DIR = '/private/tmp/claude-501/-Users-yash-Desktop-Qimati/9c6d329b-9535-40df-ab1a-c60cb2a8ea99/scratchpad/brc'
async function main() {
  const descriptions = JSON.parse(readFileSync(`${DIR}/descriptions.json`, 'utf8')) as Record<string, string>
  const pair = composeClientPair('chain-bracelet', 'charcoal-plaster')
  if (!pair) throw new Error('compose failed')
  const enhancer = new OpenRouterClient(process.env.OPENROUTER_API_KEY!)
  const pending = ['74', '75', '78']
  const results = await Promise.all(
    pending.map(async (n) => {
      const prompt = resolveImagePrompt(pair.imageBody, descriptions[n]!, true, false, 'flat-curve', false).text
      const image = readFileSync(`${DIR}/${n}.jpg`)
      try {
        const result = await enhancer.enhance(image, 'image/jpeg', prompt, {
          model: 'openai/gpt-image-2',
          size: '1024x1024',
          quality: 'high',
        })
        writeFileSync(`${DIR}/out_${n}.png`, result.image)
        console.log(`done ${n} ($${result.costUsd.toFixed(3)})`)
        return result.costUsd
      } catch (error) {
        console.error(`FAIL ${n}: ${error instanceof Error ? error.message : error}`)
        return 0
      }
    }),
  )
  console.log(`total this run $${results.reduce((a, b) => a + b, 0).toFixed(2)}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
