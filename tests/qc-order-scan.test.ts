import { describe, expect, it } from 'vitest'
import { orderScan } from '@/lib/qc/order-scan'

describe('a packing slip scan (D180)', () => {
  it('is the order name, whatever the gun does to the case; a pouch code is not', () => {
    expect(orderScan('Qimati8796')).toBe('Qimati8796'); expect(orderScan(' QIMATI8796 ')).toBe('QIMATI8796'); expect(orderScan('#Qimati12345')).toBe('Qimati12345')
    for (const code of ['', '8796', 'Qimati', 'Qimati8796-RED', 'NK1042-GOLD', 'Qimati87 96', 'XQimati8796']) expect(orderScan(code)).toBeNull()
  })
})
