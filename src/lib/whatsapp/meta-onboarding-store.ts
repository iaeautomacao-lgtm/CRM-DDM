import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt, isEncryptedSecret } from '@/lib/whatsapp/encryption'

export type StoredMetaIntegration = {
  id: string
  account_id: string
  name: string
  business_id: string
  app_id: string | null
  access_token_ciphertext: string
  app_secret_ciphertext: string | null
}

export async function loadIntegration(accountId:string,integrationId:string):Promise<StoredMetaIntegration|null>{
  const {data,error}=await supabaseAdmin().from('meta_onboarding_integrations')
    .select('id,account_id,name,business_id,app_id,access_token_ciphertext,app_secret_ciphertext')
    .eq('account_id',accountId).eq('id',integrationId).maybeSingle()
  if(error)throw error
  return data as StoredMetaIntegration | null
}

export function integrationToken(integration:StoredMetaIntegration):string{
  if(!isEncryptedSecret(integration.access_token_ciphertext))throw new Error('Integration token not encrypted')
  return decrypt(integration.access_token_ciphertext)
}

export async function auditMetaOnboarding(input:{
  accountId:string;integrationId?:string;draftId?:string;actorId:string
  action:'integration_created'|'numbers_discovered'|'draft_created'|'draft_cancelled'
  metadata?:Record<string,string|number|boolean>
}):Promise<void>{
  const {error}=await supabaseAdmin().from('meta_onboarding_events').insert({
    account_id:input.accountId,integration_id:input.integrationId??null,
    draft_id:input.draftId??null,actor_id:input.actorId,
    action:input.action,metadata:input.metadata??{},
  })
  if(error)console.error('[meta-onboarding] audit write failed:',error.code)
}

export function sameOrigin(request:Request):boolean{
  const origin=request.headers.get('origin')
  if(!origin)return true // Authenticated non-browser clients can omit Origin.
  try{return new URL(origin).origin===new URL(request.url).origin}catch{return false}
}
