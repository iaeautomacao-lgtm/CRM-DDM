import { requireApiKey } from '@/lib/auth/api-context';
import { toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { privateOk } from '@/lib/api/v1/conversation-response';
import { createExportJob } from '@/lib/api/v1/conversation-exports';
import { readBoundedJson } from '@/lib/api/v1/limited-json';

export async function POST(request:Request) {
 const logCtx:ApiCallLogContext={method:'POST',route:'/api/v1/conversations/exports',startedAt:Date.now()};
 try {
  const ctx=await requireApiKey(request,'conversations:export');
  logCtx.accountId=ctx.accountId; logCtx.keyId=ctx.keyId;
  const input=await readBoundedJson(request,8192);
  return privateOk(await createExportJob(ctx.supabase,ctx.accountId,ctx.keyId,input),202,logCtx);
 } catch(err){return toApiErrorResponse(err,logCtx);}
}
