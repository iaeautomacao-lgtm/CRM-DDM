import { gzipSync } from 'node:zlib';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { listConversations, listMessages, cursorEncode } from './conversation-history';
import { EXPORT_BUCKET, asParams, type ExportJob } from './conversation-exports';

const MAX_CONVERSATION_PAGES=50;
const MAX_MESSAGES_PER_PART=1500;
const MAX_TIME_MS=19000;
const MAX_PART_BYTES=40*1024*1024;

export interface ExportChunk {
  rows: string[];
  conversationCursor: string|null;
  messageCursor: string|null;
  conversationsCount: number;
  messagesCount: number;
  done: boolean;
}

/** Purely account-scoped, bounded pagination; no request can load the entire history into memory. */
export async function buildExportChunk(db:SupabaseClient,job:ExportJob, nowMs=()=>Date.now()):Promise<ExportChunk> {
  const start=nowMs();
  let conversationCursor=job.conversation_cursor;
  let messageCursor=job.message_cursor;
  let conversationsCount=0,messagesCount=0,done=false;
  const rows:string[]=[];
  for(let step=0;step<MAX_CONVERSATION_PAGES && messagesCount<MAX_MESSAGES_PER_PART;step++) {
    if(step>0 && nowMs()-start>MAX_TIME_MS)break;
    const conversations=await listConversations(db,job.account_id,asParams(job.filters,1,conversationCursor),job.snapshot_at);
    const conversation=conversations.items[0];
    if(!conversation){done=true;break;}
    const limit=Math.min(250,MAX_MESSAGES_PER_PART-messagesCount);
    const page=await listMessages(db,job.account_id,conversation.id,limit,messageCursor,job.snapshot_at);
    if(!messageCursor){
      rows.push(JSON.stringify({record_type:'conversation',conversation_id:conversation.id,data:conversation}));
      conversationsCount++;
    }
    for(const message of page.items)rows.push(JSON.stringify({record_type:'message',conversation_id:conversation.id,data:message}));
    messagesCount+=page.items.length;
    if(page.next_cursor){
      messageCursor=page.next_cursor;
    }else{
      conversationCursor=cursorEncode(conversation.created_at,conversation.id);
      messageCursor=null;
    }
  }
  // When the last conversation was consumed within budget, finish on this tick.
  if(!done&&!messageCursor) {
    const next=await listConversations(db,job.account_id,asParams(job.filters,1,conversationCursor),job.snapshot_at);
    done=next.items.length===0;
  }
  return {rows,conversationCursor,messageCursor,conversationsCount,messagesCount,done};
}

async function processClaimedExport(db:SupabaseClient,job:ExportJob) {
  if(!job.lease_token)throw new Error('missing_export_lease');
  const chunk=await buildExportChunk(db,job);
  const partNo=job.parts_count+1;
  if(chunk.rows.length) {
    const bytes=gzipSync(Buffer.from(chunk.rows.join('\n')+'\n','utf8'),{level:6});
    if(bytes.length>MAX_PART_BYTES)throw new Error('export_part_too_large');
    const storagePath=job.account_id+'/'+job.id+'/part-'+String(partNo).padStart(6,'0')+'.ndjson.gz';
    const {error:uploadError}=await db.storage.from(EXPORT_BUCKET)
      .upload(storagePath,bytes,{contentType:'application/gzip',upsert:true});
    if(uploadError)throw new Error('export_storage_unavailable');
    const {error:partError}=await db.from('conversation_export_parts').upsert({
      job_id:job.id,account_id:job.account_id,part_no:partNo,storage_path:storagePath,
      byte_size:bytes.length, messages_count:chunk.messagesCount, conversations_count:chunk.conversationsCount,
    },{onConflict:'job_id,part_no'});
    if(partError){
      // Best-effort orphan prevention. Crash recovery cleanup also lists the Storage prefix.
      await db.storage.from(EXPORT_BUCKET).remove([storagePath]).catch(()=>undefined);
      throw new Error('export_part_record_failed');
    }
  }
  const now=new Date().toISOString();
  const {data:saved,error:saveError}=await db.from('conversation_export_jobs').update({
    status:chunk.done?'completed':'running', conversation_cursor:chunk.conversationCursor,
    message_cursor:chunk.messageCursor, parts_count:job.parts_count+(chunk.rows.length?1:0),
    conversations_exported:job.conversations_exported+chunk.conversationsCount,
    messages_exported:job.messages_exported+chunk.messagesCount, attempts:0,
    error_code:null,lease_token:null,lease_expires_at:null,next_run_at:now,
    updated_at:now,completed_at:chunk.done?now:null,
  }).eq('id',job.id).eq('account_id',job.account_id).eq('lease_token',job.lease_token)
    .eq('status','running').select('id').maybeSingle();
  if(saveError||!saved)throw new Error('export_lease_lost');
  return {status:chunk.done?'completed':'running',conversations:chunk.conversationsCount,messages:chunk.messagesCount,part:chunk.rows.length?partNo:null};
}
async function failClaimedExport(db:SupabaseClient,job:ExportJob) {
  const exhausted=job.attempts>=5;
  // Reuse a bounded backoff, never put raw DB/provider responses or personal data into error_code.
  const retryAt=new Date(Date.now()+Math.min(job.attempts*job.attempts*60000,900000)).toISOString();
  await db.from('conversation_export_jobs').update({
    status:exhausted?'failed':'queued',lease_token:null,lease_expires_at:null,
    error_code:exhausted?'max_retries':'transient_export_failure',next_run_at:retryAt,
    updated_at:new Date().toISOString(),
  }).eq('id',job.id).eq('account_id',job.account_id).eq('lease_token',job.lease_token).eq('status','running');
}

/** Erase expired parts from private Storage before transitioning the job to expired. */
export async function purgeExpiredExports(db:SupabaseClient) {
  const {data:jobs,error}=await db.from('conversation_export_jobs').select('id,account_id')
    .neq('status','expired').lte('expires_at',new Date().toISOString())
    .order('expires_at',{ascending:true}).limit(3);
  if(error)throw error;
  let removedParts=0;
  for(const job of jobs??[]) {
    const folder=job.account_id+'/'+job.id;
    // List Storage objects, not just rows in the metadata table: an interrupted
    // upload may have created an orphan before its DB reference was inserted.
    const {data:objects,error:listError}=await db.storage.from(EXPORT_BUCKET).list(folder,{
      limit:100,sortBy:{column:'name',order:'asc'},
    });
    if(listError)continue;
    const paths=(objects??[])
      .filter(obj=>/^part-\d{6}\.ndjson\.gz$/.test(obj.name))
      .map(obj=>folder+'/'+obj.name);
    if(paths.length){
      const {error:rmError}=await db.storage.from(EXPORT_BUCKET).remove(paths);
      if(rmError)continue;
      const {error:delError}=await db.from('conversation_export_parts').delete()
        .eq('job_id',job.id).eq('account_id',job.account_id).in('storage_path',paths);
      if(delError)throw delError;
      removedParts+=paths.length;
      continue; // Check the folder again on the next tick (more than 100 files).
    }
    const {data:parts,error:partError}=await db.from('conversation_export_parts')
      .select('id').eq('job_id',job.id).eq('account_id',job.account_id).limit(100);
    if(partError)throw partError;
    if(parts?.length){
      // Remove stale references only after proving Storage is empty.
      const {error:delError}=await db.from('conversation_export_parts').delete()
        .eq('job_id',job.id).eq('account_id',job.account_id).in('id',parts.map(p=>p.id));
      if(delError)throw delError;
      continue;
    }
    await db.from('conversation_export_jobs').update({
      status:'expired',lease_token:null,lease_expires_at:null,error_code:null,updated_at:new Date().toISOString(),
    }).eq('id',job.id).eq('account_id',job.account_id);
  }
  return removedParts;
}

export async function runConversationExportTick(db:SupabaseClient=supabaseAdmin()) {
  const purged=await purgeExpiredExports(db);
  const {data,error}=await db.rpc('claim_conversation_export_job');
  if(error)throw error;
  const job=(data as ExportJob[]|null)?.[0];
  if(!job)return {processed:0,purged};
  try {
    const outcome=await processClaimedExport(db,job);
    return {processed:1,purged,job_id:job.id,...outcome};
  }catch(err) {
    await failClaimedExport(db,job);
    // Never log the exported content or personally-identifying input.
    console.error('[conversation-export] job failed',job.id,err instanceof Error?err.name:'UnknownError');
    return {processed:0,purged,job_id:job.id,failed:true};
  }
}
