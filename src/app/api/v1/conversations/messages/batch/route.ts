import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse, badRequest, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { batchMessages } from '@/lib/api/v1/conversation-history';
export async function POST(request:Request) {
 const logCtx:ApiCallLogContext={method:'POST',route:'/api/v1/conversations/messages/batch',startedAt:Date.now()};
 try {
  const ctx=await requireApiKey(request,'conversations:read');
  logCtx.accountId=ctx.accountId;logCtx.keyId=ctx.keyId;
  const size=Number(request.headers.get('content-length')||0);
  if(size>12000)throw badRequest('Request body too large');
  const body=await request.json().catch(()=>{throw badRequest('Invalid JSON');});
  return ok(await batchMessages(ctx.supabase,ctx.accountId,body),200,logCtx);
 } catch(e) {return toApiErrorResponse(e,logCtx);}
}
