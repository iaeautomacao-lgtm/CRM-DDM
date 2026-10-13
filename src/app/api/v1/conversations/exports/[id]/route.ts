import { requireApiKey } from '@/lib/auth/api-context';
import { badRequest, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { privateOk } from '@/lib/api/v1/conversation-response';
import { getExportStatus } from '@/lib/api/v1/conversation-exports';
import { uuidParam } from '@/lib/api/v1/conversation-history';

export async function GET(request:Request,{params}:{params:Promise<{id:string}>}) {
 const logCtx:ApiCallLogContext={method:'GET',route:'/api/v1/conversations/exports/[id]',startedAt:Date.now()};
 try {
  const ctx=await requireApiKey(request,'conversations:export');
  logCtx.accountId=ctx.accountId;logCtx.keyId=ctx.keyId;
  const {id}=await params;const raw=new URL(request.url).searchParams.get('after_part_no')??'0';
  if(!/^\d+$/.test(raw))throw badRequest('after_part_no must be numeric');
  return privateOk(await getExportStatus(ctx.supabase,ctx.accountId,uuidParam(id),Number(raw)),200,logCtx);
 } catch(err){return toApiErrorResponse(err,logCtx);}
}
