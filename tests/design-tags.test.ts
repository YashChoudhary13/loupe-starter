import { describe, expect, it } from 'vitest'

import {
  clean, fingerprint, kindFor, kindOf, labelPhotos, LABEL_MODEL, metafieldValue, productText, schema, storedFingerprint,
  systemPrompt, typesFor,
} from '@/lib/design-tags/labeller'
import { perKeyQueue } from '@/lib/design-tags/queue'
import { TAXONOMY_VERSION } from '@/lib/design-tags/vocabulary'

import labelPy from './fixtures/design-tags-label-py.json'

/**
 * D177. Pure: no database, no Shopify, no network. The expected values were produced by the search project's own
 * scripts/label.py functions on the inputs stored beside them (`node scripts/design-tags-sync.mjs <taxonomy.json>
 * <label.py>` writes both the vocabulary and this fixture), so a pass means Loupe asks Claude exactly what label.py asks.
 */
type Product = { title: string; options: { name: string; values: string[] }[] }
const { cases, expected } = labelPy as unknown as {
  cases: { titles: string[]; products: [Product, string][]; typeKinds: string[][]; clean: [Record<string, unknown>, string][] }
  expected: { system: string; schema: unknown; kinds: Record<string, string>; texts: string[]; types: Record<string, string>[]; clean: unknown[] }
}

describe('the port of label.py', () => {
  it('was checked against the vocabulary Loupe ships', () => {
    expect((labelPy as { taxonomyVersion: string }).taxonomyVersion).toBe(TAXONOMY_VERSION)
  })
  it('sends the same system prompt', () => expect(systemPrompt()).toBe(expected.system))
  it('asks for the same JSON schema', () => expect(schema()).toEqual(expected.schema))
  it('reads the same kind from a title', () => {
    for (const title of cases.titles) expect(kindOf(title), title).toBe(expected.kinds[title])
  })
  it('writes the same text after the photos', () => {
    cases.products.forEach(([product, kind], i) => expect(productText(product, kind), product.title).toBe(expected.texts[i]))
  })
  it('allows the same types per kind', () => {
    cases.typeKinds.forEach((kinds, i) => expect(typesFor(kinds), kinds.join(' ')).toEqual(expected.types[i]))
  })
  it('cleans an answer the same way', () => {
    cases.clean.forEach(([answer, kind], i) => expect(clean(structuredClone(answer), kind), `case ${i}`).toEqual(expected.clean[i]))
  })
  it('refuses an answer that is not the agreed shape', () => {
    expect(() => clean({ description: 'x', pieces: [] }, 'ring')).toThrow(/no list "types"/)
    expect(() => clean({ ...cases.clean[0][0], description: 7 }, 'ring')).toThrow(/description/)
  })
})

describe('kindFor', () => {
  it('takes the kind from the category prefix Loupe knows', () => {
    expect(kindFor('NK', 'Set (Necklace & Earring) 001')).toBe('necklace')
    expect(kindFor('BK', 'Bracelet Kada 120 (Small)')).toBe('kada')
    expect(kindFor('CB', 'Chain Bracelet 400')).toBe('chain-bracelet')
    expect(kindFor('rs', 'Rings 600')).toBe('ring')
    expect(kindFor('HJ', 'Hair Jewellery 021')).toBe('hair')
  })
  it('treats Indian Jewellery as the mixed kind, which its Loupe title alone would miss', () => {
    expect(kindOf('Indian Pendant Sets 065')).toBe('other')
    expect(kindFor('INJ', 'Indian Pendant Sets 065')).toBe('mixed')
  })
  it('falls back to the title for a category made later in the console', () => {
    expect(kindFor('BX', 'Jewellery Box 003')).toBe('box')
    expect(kindFor(null, 'Anklets 120 (Single Piece)')).toBe('anklet')
    expect(kindFor('ZZ', 'Something New 001')).toBe('other')
  })
})

describe('fingerprint', () => {
  const ids = ['v-1', 'v-2']
  it('is the same for the same photos, category and vocabulary', () => {
    expect(fingerprint(ids, 'NK')).toBe(fingerprint([...ids], 'NK'))
    expect(fingerprint(ids, 'NK')).toMatch(/^[0-9a-f]{64}$/)
  })
  it('changes with a new photo, a new order or a new category', () => {
    const base = fingerprint(ids, 'NK')
    for (const other of [fingerprint(['v-1', 'v-3'], 'NK'), fingerprint(['v-2', 'v-1'], 'NK'), fingerprint(ids, 'ER'), fingerprint(['v-1'], 'NK')]) expect(other).not.toBe(base)
  })
  it('is read back from the stored metafield value, and nothing else counts', () => {
    const print = fingerprint(ids, 'NK')
    const value = metafieldValue({ description: 'A heart.', main_motifs: ['heart'] }, 'necklace', print, new Date('2026-11-19T10:00:00Z'))
    expect(value).toEqual({ v: 1, model: LABEL_MODEL, at: '2026-11-19T10:00:00.000Z', images: print, labels: { kind: 'necklace', description: 'A heart.', main_motifs: ['heart'] } })
    expect(storedFingerprint(JSON.stringify(value))).toBe(print)
    for (const junk of [null, undefined, '', 'not json', 'null', '{"images":7}', '[]']) expect(storedFingerprint(junk), String(junk)).toBeNull()
  })
})

describe('labelPhotos', () => {
  const answer = { ...cases.clean[0][0], types: ['pendant', 'band'] }
  const reply = (body: Record<string, unknown>) => new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: LABEL_MODEL, stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 2_000, output_tokens: 300, cache_read_input_tokens: 6_000, cache_creation_input_tokens: 0 },
    content: [{ type: 'text', text: JSON.stringify(answer) }], ...body,
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const product = { title: 'Necklace 970', options: [{ name: 'Color', values: ['Gold', 'Silver'] }] }

  it('makes the request label.py makes and cleans the answer', async () => {
    let sent: { headers: Headers; body: Record<string, any> } | null = null  // eslint-disable-line @typescript-eslint/no-explicit-any
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = { headers: new Headers(init.headers), body: JSON.parse(String(init.body)) }
      return reply({})
    }) as unknown as typeof fetch
    const photos = ['a', 'b', 'c', 'd', 'e'].map((s) => Buffer.from(s))
    const { labels, usage } = await labelPhotos({ apiKey: 'test-key', workspaceId: 'wrkspc_test', photos, product, kind: 'necklace', fetchImpl })

    const body = sent!.body
    expect(sent!.headers.get('anthropic-workspace-id')).toBe('wrkspc_test')
    expect(body.model).toBe('claude-opus-5-5')
    expect(body.max_tokens).toBe(64_000)
    expect(body.system).toEqual([{ type: 'text', text: expected.system, cache_control: { type: 'ephemeral' } }])
    expect(body.output_config).toEqual({ effort: 'high', format: { type: 'json_schema', schema: expected.schema } })
    expect(body.messages).toHaveLength(1)
    const content = body.messages[0].content
    expect(content).toHaveLength(5)  // four photos at most, then the text
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: Buffer.from('a').toString('base64') } })
    expect(content[4]).toEqual({ type: 'text', text: expected.texts[0] })
    expect(labels.types).toEqual(['pendant'])  // band is not a necklace type
    expect(labels.keywords).toHaveLength(8)
    expect(usage).toEqual({ input: 2_000, cacheRead: 6_000, cacheWrite: 0, output: 300, usd: 0.0152 })
  })

  it('takes no labels from a refusal, a cut-off answer or text that is not JSON', async () => {
    const tries: Record<string, unknown>[] = [{ stop_reason: 'refusal' }, { stop_reason: 'max_tokens' }, { content: [{ type: 'text', text: 'a heart' }] }]
    for (const body of tries) {
      const fetchImpl = (async () => reply(body)) as unknown as typeof fetch
      await expect(labelPhotos({ apiKey: 'k', photos: [Buffer.from('a')], product, kind: 'necklace', fetchImpl }), JSON.stringify(body)).rejects.toThrow(/labeller/)
    }
  })
})

describe('perKeyQueue', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
  it('runs at most two at once, and a key asked for again while it runs once more after it, not beside it', async () => {
    const runs: string[] = []
    let running = 0, most = 0
    const gates = new Map<string, () => void>()
    const queue = perKeyQueue(async (key) => {
      runs.push(key); running += 1; most = Math.max(most, running)
      await new Promise<void>((resolve) => gates.set(key, resolve))
      running -= 1
    }, 2)
    const done = [queue('a'), queue('b'), queue('c'), queue('a'), queue('a'), queue('a')]
    await tick()
    expect(runs).toEqual(['a', 'b'])  // c waits for a slot; the three extra calls for a wait for a
    gates.get('a')!(); await tick()
    expect(runs).toEqual(['a', 'b', 'c'])  // a's one rerun queues behind c, which took the free slot first
    gates.get('b')!(); await tick()
    expect(runs).toEqual(['a', 'b', 'c', 'a'])
    gates.get('c')!(); gates.get('a')!()
    await Promise.all(done)
    expect(most).toBe(2)
    expect(runs.filter((key) => key === 'a')).toHaveLength(2)
  })
})
