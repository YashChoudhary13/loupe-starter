import { expect, it } from 'vitest'
import sharp from 'sharp'
import { BinaryBitmap, HybridBinarizer, MultiFormatReader, RGBLuminanceSource } from '@zxing/library'
import { renderLabelDocument } from '@/lib/labels/print'

it.each(['qr', 'code128'] as const)('decodes the actual printed %s symbol back to its saved variant code', async symbology => {
  const code = 'RS004-C-GOLD-S-7'
  const html = renderLabelDocument({symbology,width:symbology==='qr'?38:100,height:symbology==='qr'?25:30,items:[{id:'v1',copies:1}]},[{id:'v1',sku:code,barcode:code,title:'Gold / 7',inventoryQuantity:12,product:{id:'p1',title:'Rings 004'}}])
  const embedded = /src="data:image\/svg\+xml,([^"]+)"/.exec(html)![1]
  const svg = decodeURIComponent(embedded)
  // Decode the real generated symbol with an independent library, including a clear border.
  const {data,info} = await sharp(Buffer.from(svg)).resize({width:800,kernel:'nearest'}).flatten({background:'#fff'}).extend({top:40,bottom:40,left:40,right:40,background:'#fff'}).greyscale().raw().toBuffer({resolveWithObject:true})
  const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(new Uint8ClampedArray(data),info.width,info.height)))
  expect(new MultiFormatReader().decode(bitmap).getText()).toBe(code)
})
