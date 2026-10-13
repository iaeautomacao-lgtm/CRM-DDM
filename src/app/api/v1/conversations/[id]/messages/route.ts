import { requireApiKey } from '@/lib/auth/api-context';
import { toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { privateOk } from '@/lib/api/v1/conversation-response';
import { listMessages,limitParam,uuidParam } from '@/lib/api/v1/conversation-history';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}) {
 const logCtx:ApiCallLogContext={method:'GET',route:'/api/v1/conversations/[id]/messages',startedAt:Date.now()};
 try {
  const ctx=await requireApiKey(request,'conversations:read');
  logCtx.accountId=ctx.accountId;logCtx.keyId=ctx.keyId;
  const {id}=await params;
  const p=new URL(request.url).searchParams;
  return privateOk(await listMessages(ctx.supabase,ctx.accountId,uuidParam(id),limitParam(p.get('limit'),100,500),p.get('cursor')),200,logCtx);
 } catch(e) {return toApiErrorResponse(e,logCtx);}
}
