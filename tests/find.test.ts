import { describe, expect, it } from 'vitest'

import { cleanSticker, editDistance, judgeRead, orderNumbersFrom, parseQuery, stickerDiffers, trackingUrl, viewOf } from '@/lib/find/query'
import { parseRead, readParcelPhoto, READER_MODEL, UnreadableParcel } from '@/lib/find/reader'

describe('parseQuery', () => {
  it('reads digits as an order number, however the chat wrote it', () => {
    for (const typed of ['8613', ' qimati8613 ', '#8613', 'Qimati 8613', 'order #8613']) expect(parseQuery(typed), typed).toEqual(typed === 'order #8613' ? null : { kind: 'order', key: '8613' })
    expect(parseQuery('0085')).toEqual({ kind: 'order', key: '85' })
  })
  it('reads letters then digits as a product code and drops what follows it', () => {
    expect(parseQuery('nk 2067')).toEqual({ kind: 'product', key: 'NK2067' })
    expect(parseQuery('RS514-Gold')).toEqual({ kind: 'product', key: 'RS514' })
    expect(parseQuery('rs')).toEqual({ kind: 'product', key: 'RS' })
  })
  it('is nothing for an empty field or a plain word', () => {
    for (const typed of ['', '   ', 'necklace', '#', '123456789']) expect(parseQuery(typed), typed).toBeNull()
  })
})

describe('orderNumbersFrom', () => {
  it('keeps the order typed, the first one first, without repeats', () => {
    expect(orderNumbersFrom('8626, 8501')).toEqual([8626, 8501])
    expect(orderNumbersFrom('Qimati8626 + 8501 + 8626')).toEqual([8626, 8501])
    expect(orderNumbersFrom('none')).toEqual([])
    expect(orderNumbersFrom('0, 123456789')).toEqual([])
  })
})

describe('judgeRead', () => {
  const fact = (number: number, zip: string | null, found = true, tracking: string[] = []) => ({ number, found, zip, tracking })
  it('matches only when the order exists and its PIN code is the one on the slip', () => {
    expect(judgeRead({ orders: [8558], pincode: '533005', sticker: null }, [fact(8558, '533005')])).toEqual({ status: 'matched', orders: [8558], problem: null })
  })
  it('sends a misread digit to a person: 6558 is a real order, but not at this PIN code', () => {
    const verdict = judgeRead({ orders: [6558], pincode: '533005', sticker: null }, [fact(6558, '302001')])
    expect(verdict.status).toBe('review')
    expect(verdict.orders).toEqual([6558])
    expect(verdict.problem).toContain('Qimati6558')
  })
  it('never matches without a PIN code on either side', () => {
    expect(judgeRead({ orders: [8558], pincode: null, sticker: null }, [fact(8558, '533005')]).status).toBe('review')
    expect(judgeRead({ orders: [8558], pincode: '533005', sticker: null }, [fact(8558, null)]).status).toBe('review')
    expect(judgeRead({ orders: [8558], pincode: '', sticker: null }, [fact(8558, '')]).status).toBe('review')
  })
  it('sends an unknown order, and an empty reading, to a person', () => {
    expect(judgeRead({ orders: [9999], pincode: '533005', sticker: null }, [fact(9999, null, false)]).problem).toContain('not an order')
    expect(judgeRead({ orders: [], pincode: '533005', sticker: null }, []).status).toBe('review')
    expect(judgeRead({ orders: [8558], pincode: '533005', sticker: null }, []).status).toBe('review')
  })
  it('takes a second order in the parcel only when it goes to the same PIN code', () => {
    const read = { orders: [8626, 8501], pincode: '110001', sticker: null }
    expect(judgeRead(read, [fact(8626, '110001'), fact(8501, '110 001')])).toEqual({ status: 'matched', orders: [8626, 8501], problem: null })
    expect(judgeRead(read, [fact(8626, '110001'), fact(8501, '560001')]).status).toBe('review')
    expect(judgeRead(read, [fact(8626, '110001')]).status).toBe('review')
  })
  it('sends a right PIN code to a person when the courier sticker is clearly another parcel\'s', () => {
    // 8521 misread from 8524: both exist, both go to 302001. The order's own tracking number tells them apart.
    const read = { orders: [8521], pincode: '302001', sticker: 'X1011788476' }
    expect(judgeRead(read, [fact(8521, '302001', true, ['53192010000722'])]).problem).toContain('courier sticker')
    expect(judgeRead(read, [fact(8521, '302001', true, ['X10117788476'])]).status).toBe('matched') // one doubled digit: the same sticker
    expect(judgeRead(read, [fact(8521, '302001', true, [])]).status).toBe('matched') // not fulfilled yet: the PIN code alone decides
    expect(judgeRead({ ...read, sticker: null }, [fact(8521, '302001', true, ['53192010000722'])]).status).toBe('matched')
  })
})

describe('viewOf', () => {
  const parcel = (order: number, photoId = `p${order}`) => ({ order, photoId, thumbUrl: null, orders: [order], sticker: null, at: '2026-11-16T10:00:00Z' })
  it('draws an order card only for the whole number typed, never for the one order matching its first digits', () => {
    expect(viewOf({ kind: 'order', key: '8613', parcels: [parcel(8613)] }).type).toBe('order')
    expect(viewOf({ kind: 'order', key: '861', parcels: [parcel(8613)] })).toMatchObject({ type: 'list', rows: [{ go: '8613' }] })
    expect(viewOf({ kind: 'order', key: '86', parcels: [parcel(8613), parcel(8650)] }).type).toBe('list')
    // No photograph: a whole number still gets a card (for its tracking number), a few digits get nothing.
    expect(viewOf({ kind: 'order', key: '8613', parcels: [] })).toEqual({ type: 'order', number: 8613, photos: [] })
    expect(viewOf({ kind: 'order', key: '86', parcels: [] }).type).toBe('none')
  })
  it('opens the only product a code matches', () => {
    const raw = (code: string) => ({ code, kind: 'phone' as const, photoId: `r${code}`, thumbUrl: null, at: '2026-11-16T10:00:00Z' })
    expect(viewOf({ kind: 'product', key: 'RS51', photos: [raw('RS514')] })).toMatchObject({ type: 'product', code: 'RS514' })
    expect(viewOf({ kind: 'product', key: 'RS', photos: [raw('RS514'), raw('RS515')] }).type).toBe('list')
    expect(viewOf({ kind: 'product', key: 'NK9', photos: [] }).type).toBe('none')
  })
})

describe('the sticker', () => {
  it('is stored as capitals and digits, or not at all', () => {
    expect(cleanSticker(' x1011 788479 ')).toBe('X1011788479')
    expect(cleanSticker('12')).toBeNull()
    expect(cleanSticker(null)).toBeNull()
  })
  it('counts edits', () => {
    expect(editDistance('X1011788476', 'X1011788476')).toBe(0)
    expect(editDistance('X10117788476', 'X1011788476')).toBe(1)
    expect(editDistance('', 'abc')).toBe(3)
  })
  it('warns when the parcel now travels under another number, not when one digit was misread', () => {
    const dtdc = ['X1011788476'], delhivery = ['53192010000722']
    expect(stickerDiffers('X1011788476', dtdc)).toBe(false)
    expect(stickerDiffers('X10117788476', dtdc)).toBe(false)
    expect(stickerDiffers('X1011788476', delhivery)).toBe(true)
    expect(stickerDiffers('X1011788476', [...delhivery, ...dtdc])).toBe(false)
    expect(stickerDiffers(null, delhivery)).toBe(false)
    expect(stickerDiffers('X1011788476', [])).toBe(false)
  })
})

describe('trackingUrl', () => {
  it('builds the page for the couriers we know and keeps Shopify\'s link for the rest', () => {
    expect(trackingUrl('DTDC', 'X1011788476', null)).toBe('https://www.dtdc.com/track-your-shipment/?awb=X1011788476')
    expect(trackingUrl('Delhivery', '53192010000722', 'https://example.com/x')).toBe('https://www.delhivery.com/track/package/53192010000722')
    expect(trackingUrl('India Post', 'ER123456789IN', 'https://www.indiapost.gov.in/track')).toBe('https://www.indiapost.gov.in/track')
    expect(trackingUrl('Tirupati Courier', '123456', null)).toBeNull()
    expect(trackingUrl('Other', '123456', 'javascript:alert(1)')).toBeNull()
  })
})

describe('the reader', () => {
  it('narrows the model\'s JSON to what Find accepts', () => {
    expect(parseRead('{"orders":[8558,"x",-1,8501],"pincode":"533 005","sticker":"x1011788479"}')).toEqual({ orders: [8558, 8501], pincode: '533005', sticker: 'X1011788479' })
    expect(parseRead('{"orders":[],"pincode":"5330","sticker":null}')).toEqual({ orders: [], pincode: null, sticker: null })
    expect(() => parseRead('not json')).toThrow(UnreadableParcel)
    expect(() => parseRead('{"pincode":null}')).toThrow(UnreadableParcel)
  })

  const reply = (body: object) => new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: READER_MODEL, usage: { input_tokens: 1, output_tokens: 1 }, ...body }), { headers: { 'content-type': 'application/json' } })

  it('sends one photograph and the workspace header, and returns the reading', async () => {
    let sent: { url: string; headers: Headers; body: { model: string; output_config: { effort: string; format: { type: string } }; messages: { content: { type: string; source?: { media_type: string; data: string } }[] }[] } } | null = null
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      sent = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) }
      return reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"orders":[8558],"pincode":"533005","sticker":"X1011788479"}' }] })
    }) as typeof fetch
    const read = await readParcelPhoto({ apiKey: 'test-key', workspaceId: 'wrkspc_test', image: Buffer.from('photo'), mime: 'image/jpeg', fetchImpl })
    expect(read).toEqual({ orders: [8558], pincode: '533005', sticker: 'X1011788479' })
    expect(sent!.url).toContain('/v1/messages')
    expect(sent!.headers.get('anthropic-workspace-id')).toBe('wrkspc_test')
    expect(sent!.body.model).toBe(READER_MODEL)
    expect(sent!.body.output_config).toMatchObject({ effort: 'low', format: { type: 'json_schema' } })
    expect(sent!.body.messages[0].content[0]).toMatchObject({ type: 'image', source: { media_type: 'image/jpeg', data: Buffer.from('photo').toString('base64') } })
  })

  it('does not take a refusal or a cut-off answer as a reading', async () => {
    for (const stop_reason of ['refusal', 'max_tokens']) {
      const fetchImpl = (async () => reply({ stop_reason, content: [{ type: 'text', text: '{"orders":[8558],"pincode":"533005","sticker":null}' }] })) as typeof fetch
      await expect(readParcelPhoto({ apiKey: 'test-key', image: Buffer.from('photo'), mime: 'image/jpeg', fetchImpl }), stop_reason).rejects.toThrow(UnreadableParcel)
    }
  })
})
