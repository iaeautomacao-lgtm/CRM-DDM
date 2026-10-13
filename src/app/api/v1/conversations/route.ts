import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { listConversations } from '@/lib/api/v1/conversation-history';
export async function GET(request: Request) {
 const logCtx:ApiCallLogContext={method:'GET',route:'/api/v1/conversations',startedAt:Date.now()};
 try {
  const ctx=await requireApiKey(request,'conversations:read');
  logCtx.accountId=ctx.accountId;logCtx.keyId=ctx.keyId;
  return ok(await listConversations(ctx.supabase,ctx.accountId,new URL(request.url).searchParams),200,logCtx);
 } catch(e) {return toApiErrorResponse(e,logCtx);}
}
