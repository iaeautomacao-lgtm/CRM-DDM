import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { accessibleWabas, recheckMetaPhone, MetaDiscoveryError } from '@/lib/whatsapp/meta-onboarding'
import { auditMetaOnboarding, integrationToken, loadIntegration, sameOrigin } from '@/lib/whatsapp/meta-onboarding-store'

const ID=/^[0-9]{5,32}$/
const SOURCES=new Set(['fortics','other','new_number'])

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
  try{
    const ctx=await requireRole('admin')
    if(!sameOrigin(request))return NextResponse.json({error:'Origem não permitida.'},{status:403})
    const {id}=await params
    const integration=await loadIntegration(ctx.accountId,id)
    if(!integration)return NextResponse.json({error:'Integração não encontrada.'},{status:404})
    const body=await request.json().catch(()=>null)
    const phoneId=typeof body?.phone_number_id==='string'?body.phone_number_id:''
    const wabaId=typeof body?.waba_id==='string'?body.waba_id:''
    const source=typeof body?.former_provider==='string'?body.former_provider:''
    if(!ID.test(phoneId)||!ID.test(wabaId)||!SOURCES.has(source)||
      body?.acknowledge_no_activation!==true || body?.ownership_attested!==true)
      return NextResponse.json({error:'Selecione um número e confirme que há autorização e que esta ação NÃO o ativa.'},{status:400})

    const token=integrationToken(integration)
    try{
      const allowed=await accessibleWabas(token,integration.business_id)
      if(!allowed.wabas.some(x=>x.id===wabaId))
        return NextResponse.json({error:'Esta WABA não está autorizada na integração selecionada.'},{status:403})
    }catch(e){
      if(e instanceof MetaDiscoveryError)
        return NextResponse.json({error:'Não foi possível confirmar acesso à WABA na Meta.'},{status:422})
      throw e
    }
    let verified
    try{verified=await recheckMetaPhone(token,wabaId,phoneId)}
    catch(e){
      if(e instanceof MetaDiscoveryError)
        return NextResponse.json({error:'Falha ao verificar o número diretamente na Meta.'},{status:422})
      throw e
    }
    if(!verified)return NextResponse.json({error:'Número não pertence à WABA informada ou não está acessível.'},{status:404})

    const db=supabaseAdmin()
    // Check globally for CRM conflict without exposing other tenants' records.
    const {data:existing,error:lookupError}=await db.from('whatsapp_config')
      .select('id').eq('phone_number_id',phoneId).limit(1)
    if(lookupError)throw lookupError
    if(existing?.length)return NextResponse.json({error:'Esse número já está cadastrado em um canal do CRM. Nenhuma alteração realizada.'},{status:409})

    const {data:draft,error}=await db.from('meta_onboarding_drafts').insert({
      account_id:ctx.accountId,integration_id:id,waba_id:wabaId,phone_number_id:phoneId,
      display_phone_number:verified.display_phone_number||null,
      verified_name:verified.verified_name||null,
      former_provider:source,
      status:'awaiting_ownership_validation',
      attested_by:ctx.userId,attested_at:new Date().toISOString(),created_by:ctx.userId,
    }).select('id,status,display_phone_number,phone_number_id,waba_id,former_provider').single()
    if(error?.code==='23505')
      return NextResponse.json({error:'Já existe um rascunho para este número nesta organização.'},{status:409})
    if(error||!draft)throw error??new Error('Cannot insert draft')
    await auditMetaOnboarding({accountId:ctx.accountId,integrationId:id,draftId:draft.id,
      actorId:ctx.userId,action:'draft_created',metadata:{source,not_activated:true}})
    return NextResponse.json({draft,activated:false,
      message:'Rascunho salvo. O número NÃO foi registrado, transferido ou ativado no CRM.'},
      {status:201,headers:{'Cache-Control':'private, no-store'}})
  }catch(e){return toErrorResponse(e)}
}
