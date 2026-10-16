/**
 * READ-ONLY Meta discovery. No /register, /subscribed_apps POST, transfer
 * or routing change is performed in this module.
 *
 * All Graph paths/fields are built by the server from validated numeric
 * Meta IDs; callers cannot supply arbitrary URLs.
 */
import { resolveMetaApiBaseUrl } from '@/lib/loadtest/gate'

const ID = /^[0-9]{5,32}$/
const ALLOWED_VERSIONS = new Set(['v25.0', 'v26.0'])
const PAGE_LIMIT = 4
const MAX_WABAS = 20
const MAX_PHONES = 200
const GRAPH_TIMEOUT_MS = 12_000

export type MetaWaba = { id: string; name: string; ownership: 'owned' | 'shared' }
export type MetaPhone = {
  id: string; waba_id: string; waba_name: string
  display_phone_number: string; verified_name: string
  quality_rating: string | null; code_verification_status: string | null
}
export type MetaDiscovery = { wabas: MetaWaba[]; phones: MetaPhone[]; warnings: string[]; partial: boolean }

export class MetaDiscoveryError extends Error {
  constructor(public readonly code: 'invalid_id' | 'auth' | 'meta_unavailable' | 'limit' | 'unexpected') {
    super(code)
    this.name = 'MetaDiscoveryError'
  }
}

function graphBase(): string {
  const version = process.env.META_ONBOARDING_GRAPH_VERSION || 'v26.0'
  if (!ALLOWED_VERSIONS.has(version)) throw new MetaDiscoveryError('unexpected')
  return resolveMetaApiBaseUrl().replace(/\/$/, '') + '/' + version
}
function metaId(value: string): string {
  if (!ID.test(value)) throw new MetaDiscoveryError('invalid_id')
  return value
}
function asString(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}
function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
type GraphPage = { data?: unknown[]; paging?: { next?: string; cursors?: { after?: string } } }

async function graphGet(
  token: string, path: string, params: Record<string,string> = {},
): Promise<GraphPage> {
  // path is constructed from metaId(..) and fixed server-side suffixes.
  const url = new URL(graphBase() + '/' + path)
  for (const [key,val] of Object.entries(params)) url.searchParams.set(key,val)
  let result: Response
  try {
    result = await fetch(url, {
      method:'GET',
      headers:{ Authorization:'Bearer '+token, Accept:'application/json' },
      cache:'no-store', redirect:'error',
      signal:AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    })
  } catch {
    throw new MetaDiscoveryError('meta_unavailable')
  }
  if (!result.ok) {
    // Never forward the provider's raw error text (it might include PII or token fragments).
    throw new MetaDiscoveryError(result.status===401||result.status===403 ? 'auth' : 'meta_unavailable')
  }
  try {
    const payload = obj(await result.json())
    if (!Array.isArray(payload.data)) throw new Error('not a Graph collection')
    return payload as GraphPage
  } catch { throw new MetaDiscoveryError('unexpected') }
}
async function graphCollection(
  token:string,path:string,fields:string,maxItems:number,
):Promise<unknown[]> {
  const rows: unknown[]=[]
  let cursor: string | null=null
  for(let page=0;page<PAGE_LIMIT;page++){
    const params:Record<string,string>={fields,limit:'100'}
    if(cursor)params.after=cursor
    const payload=await graphGet(token,path,params)
    rows.push(...(payload.data??[]))
    if(rows.length>maxItems)throw new MetaDiscoveryError('limit')
    const more=typeof payload.paging?.next==='string' && payload.paging.next.length>0
    if(!more)return rows
    // Use only the opaque cursor, NEVER follow paging.next as an arbitrary URL.
    const nextCursor=payload.paging?.cursors?.after
    if(!nextCursor || nextCursor===cursor || nextCursor.length>4096)throw new MetaDiscoveryError('limit')
    cursor=nextCursor
  }
  throw new MetaDiscoveryError('limit')
}

export async function accessibleWabas(token:string,businessId:string):Promise<{wabas:MetaWaba[],warnings:string[]}>{
  const business=metaId(businessId)
  const sources=[
    ['owned_whatsapp_business_accounts','owned'] as const,
    ['client_whatsapp_business_accounts','shared'] as const,
  ]
  const wabas=new Map<string,MetaWaba>()
  const warnings:string[]=[]
  let successful=0
  for(const [endpoint,ownership] of sources){
    try{
      const items=await graphCollection(token,business+'/'+endpoint,'id,name',MAX_WABAS)
      successful++
      for(const item of items){
        const record=obj(item)
        const id=asString(record.id)
        if(!ID.test(id))continue
        if(!wabas.has(id))wabas.set(id,{
          id,name:asString(record.name).slice(0,130)||'Conta Meta',ownership,
        })
      }
    }catch(e){
      if(e instanceof MetaDiscoveryError && e.code==='auth'){
        warnings.push('Permissões insuficientes para listar WABAs '+(ownership==='owned'?'próprias':'compartilhadas')+'.')
      }else{
        warnings.push('Não foi possível consultar todas as WABAs '+(ownership==='owned'?'próprias':'compartilhadas')+'.')
      }
    }
  }
  if(successful===0)throw new MetaDiscoveryError('auth')
  if(wabas.size>MAX_WABAS)throw new MetaDiscoveryError('limit')
  return {wabas:[...wabas.values()],warnings}
}
async function wabaPhones(token:string,wabaId:string):Promise<Record<string,unknown>[]>{
  const data=await graphCollection(
    token,metaId(wabaId)+'/phone_numbers',
    'id,display_phone_number,verified_name,quality_rating,code_verification_status',MAX_PHONES,
  )
  return data.map(obj)
}
export async function discoverMetaPhones(token:string,businessId:string):Promise<MetaDiscovery>{
  const {wabas,warnings}=await accessibleWabas(token,businessId)
  const phones:MetaPhone[]=[]
  for(const waba of wabas){
    try{
      const page=await wabaPhones(token,waba.id)
      for(const raw of page){
        const id=asString(raw.id)
        if(!ID.test(id))continue
        phones.push({
          id,waba_id:waba.id,waba_name:waba.name,
          display_phone_number:asString(raw.display_phone_number).slice(0,35),
          verified_name:asString(raw.verified_name).slice(0,128),
          quality_rating:asString(raw.quality_rating)||null,
          code_verification_status:asString(raw.code_verification_status)||null,
        })
        if(phones.length>MAX_PHONES)throw new MetaDiscoveryError('limit')
      }
    }catch(e){
      warnings.push('A listagem de números não pôde ser concluída para uma das contas Meta.')
    }
  }
  return {wabas,phones,warnings,partial:warnings.length>0}
}

/** Recheck the phone in Meta immediately before creating a draft. */
export async function recheckMetaPhone(token:string,wabaId:string,phoneId:string):Promise<MetaPhone|null>{
  metaId(phoneId)
  const data=await wabaPhones(token,wabaId)
  const row=data.find(r=>asString(r.id)===phoneId)
  if(!row)return null
  return {
    id:phoneId,waba_id:wabaId,waba_name:'',
    display_phone_number:asString(row.display_phone_number).slice(0,35),
    verified_name:asString(row.verified_name).slice(0,128),
    quality_rating:asString(row.quality_rating)||null,
    code_verification_status:asString(row.code_verification_status)||null,
  }
}
