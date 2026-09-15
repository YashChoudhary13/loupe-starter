import { beforeEach, expect, it, vi } from 'vitest'

const mocks=vi.hoisted(()=>({operator:vi.fn(),plan:vi.fn(),apply:vi.fn(),insert:vi.fn(),limit:vi.fn()}))
vi.mock('@/lib/auth/authorize',()=>({requireOperatorForAction:mocks.operator,NotAuthorisedError:class extends Error{}}))
vi.mock('@/lib/env',()=>({serverEnv:{authBaseUrl:'https://loupe.example'}}))
vi.mock('@/lib/shopify/client',()=>({ShopifyClient:class{}}))
vi.mock('@/lib/labels/prepare-codes',()=>({planProductCodes:mocks.plan,applyProductCodes:mocks.apply}))
vi.mock('@/lib/supabase/server',()=>({supabaseServer:()=>({from:()=>({select:()=>({eq:()=>({neq:()=>({limit:mocks.limit})})}),insert:mocks.insert})})}))
import { POST } from '@/app/api/labels/prepare/route'
import { NotAuthorisedError } from '@/lib/auth/authorize'
const plan={productId:'gid://shopify/Product/10',fingerprint:'saved-hash',parent:'RS004',rows:[]}
const request=(body:unknown,origin='https://loupe.example')=>new Request('https://loupe.example/api/labels/prepare',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify(body)})
beforeEach(()=>{vi.clearAllMocks();mocks.operator.mockResolvedValue({email:'operator@example.test'});mocks.plan.mockResolvedValue(plan);mocks.limit.mockResolvedValue({data:[],error:null});mocks.insert.mockResolvedValue({error:null})})
it('requires a named operator and the configured origin',async()=>{
  mocks.operator.mockRejectedValueOnce(new NotAuthorisedError())
  expect((await POST(request({action:'preview',productId:plan.productId}))).status).toBe(401)
  expect((await POST(request({action:'preview',productId:plan.productId},'https://outside.example'))).status).toBe(403)
  expect(mocks.plan).not.toHaveBeenCalled()
})
it('previews without changing Shopify and refuses unpublished Loupe drafts',async()=>{
  expect((await POST(request({action:'preview',productId:plan.productId}))).status).toBe(200)
  expect(mocks.apply).not.toHaveBeenCalled()
  mocks.limit.mockResolvedValue({data:[{status:'publishing'}],error:null})
  expect((await POST(request({action:'apply',productId:plan.productId,fingerprint:'saved-hash'}))).status).toBe(400)
  expect(mocks.apply).not.toHaveBeenCalled()
})
it('refuses a stale preview before auditing or writing codes',async()=>{
  expect((await POST(request({action:'apply',productId:plan.productId,fingerprint:'old'}))).status).toBe(409)
  expect(mocks.insert).not.toHaveBeenCalled();expect(mocks.apply).not.toHaveBeenCalled()
})
it('writes only the fresh server plan and records the operator',async()=>{
  expect((await POST(request({action:'apply',productId:plan.productId,fingerprint:'saved-hash',rows:[{barcode:'ATTACK'}]}))).status).toBe(200)
  expect(mocks.apply).toHaveBeenCalledWith(expect.anything(),plan)
  expect(mocks.insert.mock.calls[0][0].actor).toBe('operator@example.test')
})
it('refuses Shopify writes when the pre-change audit fails',async()=>{
  mocks.insert.mockResolvedValue({error:{message:'offline'}})
  expect((await POST(request({action:'apply',productId:plan.productId,fingerprint:'saved-hash'}))).status).toBe(400)
  expect(mocks.apply).not.toHaveBeenCalled()
})
