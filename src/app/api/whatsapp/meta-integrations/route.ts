import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decryptStoredSecret, encrypt } from '@/lib/whatsapp/encryption'
import { accessibleWabas, MetaDiscoveryError } from '@/lib/whatsapp/meta-onboarding'
import { auditMetaOnboarding, sameOrigin } from '@/lib/whatsapp/meta-onboarding-store'

const noCache={'Cache-Control':'private, no-store'}
const ID=/^[0-9]{5,32}$/

export async function GET() {
  try{
    const ctx=await requireRole('admin')
    const db=supabaseAdmin()
    const [integrations,drafts,channels]=await Promise.all([
      db.from('meta_onboarding_integrations')
        .select('id,name,business_id,app_id,source_channel_id,app_secret_ciphertext,created_at')
        .eq('account_id',ctx.accountId).order('created_at',{ascending:false}),
      db.from('meta_onboarding_drafts')
        .select('id,integration_id,waba_id,phone_number_id,display_phone_number,verified_name,former_provider,status,created_at')
        .eq('account_id',ctx.accountId).order('created_at',{ascending:false}).limit(200),
      db.from('whatsapp_config')
        .select('id,display_phone_number,waba_id,app_secret,habilitado,status')
        .eq('account_id',ctx.accountId).eq('provider','meta').order('created_at',{ascending:false}),
    ])
    if(integrations.error||drafts.error||channels.error)throw new Error('Meta onboarding DB unavailable')
    return NextResponse.json({
      integrations:(integrations.data??[]).map(({app_secret_ciphertext,...i})=>({
        ...i,has_app_secret:!!app_secret_ciphertext,
      })),
      drafts:drafts.data??[],
      legacy_channels:(channels.data??[]).map(({app_secret,...c})=>({
        ...c,has_app_secret:!!app_secret,
      })),
    },{headers:noCache})
  }catch(e){return toErrorResponse(e)}
}

export async function POST(request:Request){
  try{
    const ctx=await requireRole('admin')
    if(!sameOrigin(request))return NextResponse.json({error:'Origem não permitida'},{status:403})
    const body=await request.json().catch(()=>null)
    if(!body||typeof body!=='object'||Array.isArray(body))
      return NextResponse.json({error:'Dados inválidos'},{status:400})

    const name=typeof body.name==='string'?body.name.trim():''
    const businessId=typeof body.business_id==='string'?body.business_id.trim():''
    const appId=typeof body.app_id==='string'?body.app_id.trim():''
    if(name.length<3||name.length>80||!ID.test(businessId)||(appId&&!ID.test(appId)))
      return NextResponse.json({error:'Informe um nome, Business ID numérico e, se houver, App ID válido.'},{status:400})
    const sourceId=typeof body.source_channel_id==='string' ? body.source_channel_id : ''
    const tokenInput=typeof body.access_token==='string'?body.access_token.trim():''
    const secretInput=typeof body.app_secret==='string'?body.app_secret.trim():''
    if((!!sourceId)===!!tokenInput)
      return NextResponse.json({error:'Informe um token novo OU selecione um canal Meta existente.'},{status:400})
    let token=tokenInput
    let appSecret=secretInput
    let source_channel_id:string|null=null
    if(sourceId){
      const {data:channel,error}=await supabaseAdmin().from('whatsapp_config')
        .select('id,access_token,app_secret').eq('account_id',ctx.accountId)
        .eq('id',sourceId).eq('provider','meta').maybeSingle()
      if(error)throw error
      if(!channel)return NextResponse.json({error:'Canal não encontrado nesta organização.'},{status:404})
      token=decryptStoredSecret(channel.access_token,'meta integration legacy channel token')
      source_channel_id=channel.id
      if(!appSecret && channel.app_secret)
        appSecret=decryptStoredSecret(channel.app_secret,'meta integration legacy channel app secret')
    }
    if(token.length<16||token.length>4096 || appSecret.length>500)
      return NextResponse.json({error:'Credencial inválida.'},{status:400})

    // Validate token access before saving any new integration.
    let access
    try{access=await accessibleWabas(token,businessId)}
    catch(e){
      if(e instanceof MetaDiscoveryError)
        return NextResponse.json({error:e.code==='auth'
          ? 'O token não pode listar WABAs deste Business ID. Verifique permissões e titularidade.'
          : 'Não foi possível consultar a Meta. Verifique token e Business ID.'},{status:422})
      throw e
    }
    const db=supabaseAdmin()
    const {data,error}=await db.from('meta_onboarding_integrations').insert({
      account_id:ctx.accountId,name,business_id:businessId,app_id:appId||null,
      access_token_ciphertext:encrypt(token),
      app_secret_ciphertext:appSecret?encrypt(appSecret):null,
      source_channel_id,created_by:ctx.userId,
    }).select('id,name,business_id,app_id,created_at').single()
    if(error?.code==='23505')return NextResponse.json({error:'Já existe uma integração com este nome.'},{status:409})
    if(error||!data)throw error??new Error('cannot insert integration')
    await auditMetaOnboarding({accountId:ctx.accountId,integrationId:data.id,
      actorId:ctx.userId,action:'integration_created',
      metadata:{wabas_found:access.wabas.length,permission_warnings:access.warnings.length,
        from_existing_channel:!!source_channel_id}})
    return NextResponse.json({integration:data,warnings:access.warnings},{status:201,headers:noCache})
  }catch(e){return toErrorResponse(e)}
}
