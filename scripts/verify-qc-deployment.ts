/** Production readback using a five-minute signed session for an existing active admin.
 * Does not scan or complete customer orders, assign product codes, or change access. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { parse } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { encodeSignedValue, SESSION_COOKIE } from '../src/lib/auth/session'
import { ShopifyClient } from '../src/lib/shopify/client'
import { listQcOrders } from '../src/lib/shopify/qc-orders'
import { pgClient } from './lib/pg'

async function main() {
  const [envFile,receiptFile]=process.argv.slice(2)
  if(!envFile||!receiptFile)throw new Error('Usage: <production-env-file> <receipt-file>')
  Object.assign(process.env,parse(readFileSync(envFile)))
  const origin=process.env.AUTH_BASE_URL!
  assert.equal(origin,'https://loupe.qimati-eng.site')
  const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}})
  const {data:users,error}=await db.from('app_users').select('id,email,name,role').eq('active',true).eq('role','admin').order('created_at').limit(1)
  assert.equal(error,null);assert.equal(users?.length,1)
  const user=users![0], now=Math.floor(Date.now()/1000)
  const session=encodeSignedValue(process.env.AUTH_SESSION_SECRET!,{uid:user.id,email:user.email,name:user.name,role:user.role,iat:now,exp:now+300})
  const auth={Cookie:`${SESSION_COOKIE}=${session}`}
  const checks:Record<string,unknown>={}
  const orders=await listQcOrders(new ShopifyClient())
  checks.shopifyOrdersRead=orders.nodes.length
  for(const route of ['/qc','/labels','/console']){
    const response: Response=await fetch(origin+route,{headers:auth,redirect:'manual'})
    const html: string=await response.text()
    assert.equal(response.status,200,route);assert(!html.includes('Application error'))
    assert(html.includes(route==='/qc'?'Order QC':route==='/labels'?'Labels':'Console'))
    checks[route]=response.status
  }
  if(orders.nodes.length){
    const id=orders.nodes[0].id.split('/').at(-1)!
    const endpoint=`${origin}/api/qc/${id}`
    const response=await fetch(endpoint,{headers:auth}),view=await response.json()
    assert.equal(response.status,200);assert.equal(view.order.id,orders.nodes[0].id)
    checks.currentOrderRead={name:view.order.name,lines:view.order.lines.length,remaining:view.order.lines.reduce((n:number,l:{required:number})=>n+l.required,0),status:view.session.status}
    assert.equal((await fetch(endpoint)).status,401)
    assert.equal((await fetch(endpoint,{method:'POST',headers:{...auth,Origin:'https://foreign.example','Content-Type':'application/json'},body:'{}'})).status,403)
    checks.unauthenticatedDenied=true;checks.foreignOriginDenied=true
    const line=view.order.lines.find((l:{sku:string|null})=>l.sku)
    if(line){
      const labels=await fetch(`${origin}/labels?q=${encodeURIComponent(line.sku)}`,{headers:auth})
      const html=await labels.text();assert.equal(labels.status,200);assert(html.includes('Prepare codes'))
      checks.existingProductLabels=true
    }
  }
  // Exercise the deployed RPC as service_role inside a transaction that is ALWAYS rolled back.
  const pg=pgClient();await pg.connect()
  try {
    await pg.query('begin');await pg.query('set local role service_role')
    const orderId=`gid://shopify/Order/999999${Date.now()}`
    const snapshot={id:orderId,name:'ROLLBACK-ONLY QC VERIFICATION',lines:[{id:'fixture-line',variantId:'fixture-variant',title:'Fixture',required:2}],blockedReason:null}
    const call=async(action:string,version:number|null=null,extra?:{undo?:string})=>pg.query(`select qc_command(p_shop_domain=>$1,p_order_id=>$2,p_actor_id=>$3,p_action=>$4,p_snapshot=>$5,p_fingerprint=>$6,p_checked_at=>clock_timestamp(),p_request_id=>gen_random_uuid(),p_code=>'FIXTURE',p_variant_id=>'fixture-variant',p_expected_version=>$7,p_expected_generation=>1,p_undo_event_id=>$8) result`,[new ShopifyClient().config.storeDomain,orderId,user.id,action,JSON.stringify(snapshot),'a'.repeat(64),version,extra?.undo??null])
    assert.equal((await call('scan')).rows[0].result.event.outcome,'accepted')
    assert.equal((await call('complete',1)).rows[0].result.event.outcome,'incomplete')
    assert.equal((await call('scan')).rows[0].result.event.outcome,'accepted')
    const extra=(await call('scan')).rows[0].result
    assert.equal(extra.event.outcome,'extra')
    assert.equal((await call('complete',2)).rows[0].result.event.outcome,'extras')
    assert.equal((await call('clear_extra',2,{undo:extra.event.id})).rows[0].result.event.outcome,'removed')
    assert.equal((await call('complete',3)).rows[0].result.event.outcome,'passed')
    checks.productionRpc='service_role scan/incomplete/extra/clear_extra/complete passed; transaction rolled back'
  } finally {await pg.query('rollback');await pg.end()}
  checks.customerOrderScans=0;checks.customerOrderFulfillments=0
  checks.verifiedAt=new Date().toISOString()
  writeFileSync(receiptFile,JSON.stringify(checks,null,2)+'\n');console.log(JSON.stringify(checks,null,2))
}
main().catch(error=>{console.error(error instanceof Error?error.message:error);process.exitCode=1})
