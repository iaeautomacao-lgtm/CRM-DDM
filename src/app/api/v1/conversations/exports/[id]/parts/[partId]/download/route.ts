import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { signExportPart } from '@/lib/api/v1/conversation-exports';
import { uuidParam } from '@/lib/api/v1/conversation-history';

export async function GET(request:Request,{params}:{params:Promise<{id:string;partId:string}>}) {
 const logCtx:ApiCallLogContext={method:'GET',route:'/api/v1/conversations/exports/[id]/parts/[partId]/download',startedAt:Date.now()};
 try {
  const ctx=await requireApiKey(request,'conversations:export');
  logCtx.accountId=ctx.accountId;logCtx.keyId=ctx.keyId;
  const {id,partId}=await params;
  const response=ok(await signExportPart(ctx.supabase,ctx.accountId,uuidParam(id),uuidParam(partId)),200,logCtx);
  response.headers.set('Cache-Control','private, no-store');
  return response;
 } catch(err){return toApiErrorResponse(err,logCtx);}
}
