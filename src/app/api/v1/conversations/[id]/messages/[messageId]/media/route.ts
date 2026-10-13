import { requireApiKey } from '@/lib/auth/api-context';
import { ok, notFound, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { getConversation, uuidParam } from '@/lib/api/v1/conversation-history';
import { chatMediaPath } from '@/lib/storage/chat-media';
import { isOwnedChatMediaPath } from '@/lib/api/v1/conversation-media';

export async function GET(request:Request,{params}:{params:Promise<{id:string;messageId:string}>}) {
 const logCtx:ApiCallLogContext={method:'GET',route:'/api/v1/conversations/[id]/messages/[messageId]/media',startedAt:Date.now()};
 try {
  const ctx=await requireApiKey(request,'conversations:read');
  logCtx.accountId=ctx.accountId;logCtx.keyId=ctx.keyId;
  const {id,messageId}=await params, convId=uuidParam(id),msgId=uuidParam(messageId);
  await getConversation(ctx.supabase,ctx.accountId,convId);
  const {data:msg,error}=await ctx.supabase.from('messages').select('media_url')
    .eq('account_id',ctx.accountId).eq('conversation_id',convId).eq('id',msgId).maybeSingle();
  if(error)throw error;
  const path=msg?.media_url?chatMediaPath(msg.media_url):null;
  if(!path||!isOwnedChatMediaPath(path,ctx.accountId))throw notFound('Media not available through the API');
  const {data:signed,error:signError}=await ctx.supabase.storage.from('chat-media').createSignedUrl(path,60);
  if(signError||!signed?.signedUrl)throw notFound('Media not found');
  const response=ok({url:signed.signedUrl,expires_in_seconds:60},200,logCtx);
  response.headers.set('Cache-Control','private, no-store');
  return response;
 } catch(err){return toApiErrorResponse(err,logCtx);}
}
