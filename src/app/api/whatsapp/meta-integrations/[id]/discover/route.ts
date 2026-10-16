import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { discoverMetaPhones, MetaDiscoveryError } from '@/lib/whatsapp/meta-onboarding'
import { auditMetaOnboarding, integrationToken, loadIntegration } from '@/lib/whatsapp/meta-onboarding-store'

export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
  try{
    const ctx=await requireRole('admin')
    const {id}=await params
    const integration=await loadIntegration(ctx.accountId,id)
    if(!integration)return NextResponse.json({error:'Integração não encontrada.'},{status:404})
    let discovered
    try{discovered=await discoverMetaPhones(integrationToken(integration),integration.business_id)}
    catch(e){
      if(e instanceof MetaDiscoveryError)
        return NextResponse.json({error:e.code==='auth'
          ? 'Token sem permissão para ler WABAs/números do Business ID.'
          : 'Falha ao consultar a Meta. Confira acesso e limite de consulta.'},{status:422})
      throw e
    }
    const ids=discovered.phones.map(p=>p.id)
    const db=supabaseAdmin()
    const {data:claimed,error}=ids.length
      ? await db.from('whatsapp_config').select('account_id,phone_number_id')
        .in('phone_number_id',ids)
      : {data:[] as {account_id:string,phone_number_id:string}[],error:null}
    if(error)throw error
    const status=new Map((claimed??[]).map(x=>[x.phone_number_id,x.account_id]))
    const phones=discovered.phones.map(p=>({
      ...p, crm_status:status.has(p.id)
        ? (status.get(p.id)===ctx.accountId?'already_in_this_account':'already_in_another_account')
        : 'available_for_review',
      // Connection and routing remain UNKNOWN until Meta + provider are verified.
      routing_verified:false,number_registered_verified:false,
    }))
    await auditMetaOnboarding({accountId:ctx.accountId,integrationId:id,
      actorId:ctx.userId,action:'numbers_discovered',
      metadata:{numbers_found:phones.length,wabas_found:discovered.wabas.length,partial:discovered.partial}})
    return NextResponse.json({
      integration:{id:integration.id,name:integration.name,business_id:integration.business_id},
      phones,wabas:discovered.wabas,warnings:discovered.warnings,partial:discovered.partial,
      notice:'Consulta somente leitura. Não realiza /register, assinatura de webhook nem transferência.',
    },{headers:{'Cache-Control':'private, no-store'}})
  }catch(e){return toErrorResponse(e)}
}
