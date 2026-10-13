import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { batchMessages } from '@/lib/api/v1/conversation-history';
import { readBoundedJson } from '@/lib/api/v1/limited-json';
export async function POST(request:Request) {
 const logCtx:ApiCallLogContext={method:'POST',route:'/api/v1/conversations/messages/batch',startedAt:Date.now()};
 try {
  const ctx=await requireApiKey(request,'conversations:read');
  logCtx.accountId=ctx.accountId;logCtx.keyId=ctx.keyId;
  const body=await readBoundedJson(request,16384);
  return ok(await batchMessages(ctx.supabase,ctx.accountId,body),200,logCtx);
 } catch(e) {return toApiErrorResponse(e,logCtx);}
}
