import { requireApiKey } from '@/lib/auth/api-context';
import { ok, badRequest, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { createExportJob } from '@/lib/api/v1/conversation-exports';

export async function POST(request:Request) {
 const logCtx:ApiCallLogContext={method:'POST',route:'/api/v1/conversations/exports',startedAt:Date.now()};
 try {
  const ctx=await requireApiKey(request,'conversations:export');
  logCtx.accountId=ctx.accountId; logCtx.keyId=ctx.keyId;
  const raw=await request.text(); if(raw.length>8192)throw badRequest('Export request exceeds 8 KB');
  let input:unknown;try{input=JSON.parse(raw);}catch{throw badRequest('Invalid JSON');}
  return ok(await createExportJob(ctx.supabase,ctx.accountId,ctx.keyId,input),202,logCtx);
 } catch(err){return toApiErrorResponse(err,logCtx);}
}
