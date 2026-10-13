import type { SupabaseClient } from '@supabase/supabase-js';
import { badRequest, conflict, notFound } from '@/lib/api/v1/respond';
import { dayParam, listConversations, uuidParam } from './conversation-history';

export const EXPORT_BUCKET = 'conversation-history-exports';
export const EXPORT_RETENTION_DAYS = 7;
export type ExportFilters = { from: string; to: string; status?: string; agent_id?: string; team_id?: string; channel_type?: string };
export type ExportJob = {
  id:string; account_id:string; created_by_key_id:string; filters:ExportFilters;
  status:'queued'|'running'|'completed'|'failed'|'expired';
  snapshot_at:string; expires_at:string; next_run_at:string;
  lease_token:string|null; attempts:number; conversation_cursor:string|null;
  message_cursor:string|null; parts_count:number; conversations_exported:number;
  messages_exported:number; created_at:string; updated_at:string; error_code:string|null;
};
export function parseExportFilters(body: unknown): ExportFilters {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Expected a JSON object');
  const data=body as Record<string,unknown>;
  for(const name of Object.keys(data)) if(!['from','to','status','agent_id','team_id','channel_type'].includes(name)) throw badRequest('Unsupported export filter');
  const from=dayParam(typeof data.from==='string'?data.from:null,'from');
  const to=dayParam(typeof data.to==='string'?data.to:null,'to');
  if(!from||!to) throw badRequest('from and to are required');
  const days=(Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000;
  if(days<0||days>365) throw badRequest('Export range must be between 1 and 366 calendar days');
  const filters:ExportFilters={from,to};
  if(data.status!==undefined) {
    if(typeof data.status!=='string'||!['open','pending','closed'].includes(data.status))throw badRequest('Invalid status');
    filters.status=data.status;
  }
  for(const key of ['agent_id','team_id'] as const) if(data[key]!==undefined)filters[key]=uuidParam(data[key],key);
  if(data.channel_type!==undefined) {
    if(typeof data.channel_type!=='string'||!['whatsapp','webchat','instagram','facebook','messenger'].includes(data.channel_type))throw badRequest('Invalid channel_type');
    filters.channel_type=data.channel_type;
  }
  return filters;
}
export function asParams(filters:ExportFilters,limit=1,cursor:string|null=null): URLSearchParams {
  const p=new URLSearchParams();
  for(const [key,val] of Object.entries(filters)) if(val!==undefined)p.set(key,val);
  p.set('limit',String(limit));
  if(cursor)p.set('cursor',cursor);
  return p;
}
export async function createExportJob(db:SupabaseClient, accountId:string, keyId:string, input:unknown) {
  const filters=parseExportFilters(input);
  // Validate filters and database relationships now, before enqueueing.
  await listConversations(db,accountId,asParams(filters));
  const {data:existing,error:existingError}=await db.from('conversation_export_jobs')
    .select('id').eq('account_id',accountId).in('status',['queued','running'])
    .gt('expires_at',new Date().toISOString()).limit(3);
  if(existingError)throw existingError;
  if((existing??[]).length>=3)throw conflict('Maximum of three active exports per account');
  const now=new Date().toISOString();
  const {data,error}=await db.from('conversation_export_jobs')
    .insert({ account_id:accountId,created_by_key_id:keyId,filters,snapshot_at:now })
    .select('id,status,created_at,expires_at').single();
  if(error)throw error;
  return { ...data, poll_url:'/api/v1/conversations/exports/'+data.id };
}
export async function getExportJob(db:SupabaseClient,accountId:string,id:string):Promise<ExportJob> {
  const {data,error}=await db.from('conversation_export_jobs').select('*').eq('account_id',accountId).eq('id',id).maybeSingle();
  if(error)throw error;
  if(!data)throw notFound('Export not found');
  return data as ExportJob;
}
export function isExportDownloadable(job:Pick<ExportJob,'status'|'expires_at'>, now=Date.now()): boolean {
  return job.status==='completed' && Date.parse(job.expires_at)>now;
}
export async function getExportStatus(db:SupabaseClient,accountId:string,id:string,afterPartNo:number) {
  const job=await getExportJob(db,accountId,id);
  if(!Number.isInteger(afterPartNo)||afterPartNo<0)throw badRequest('after_part_no must be a nonnegative integer');
  const q=db.from('conversation_export_parts').select('id,part_no,byte_size,messages_count,conversations_count')
    .eq('account_id',accountId).eq('job_id',job.id).gt('part_no',afterPartNo)
    .order('part_no',{ascending:true}).limit(101);
  // Do not expose partially written parts; exports only become downloadable when complete.
  const {data,error}=job.status==='completed'?await q:{data:[],error:null};
  if(error)throw error;
  const all=data??[],page=all.slice(0,100);
  return {
    id:job.id, status:Date.parse(job.expires_at)<=Date.now()?'expired':job.status,
    created_at:job.created_at,expires_at:job.expires_at,snapshot_at:job.snapshot_at,
    filters:job.filters,conversations_exported:job.conversations_exported,
    messages_exported:job.messages_exported,parts_count:job.parts_count,
    error_code:job.error_code,
    parts:page.map(p=>({...p,download_url:'/api/v1/conversations/exports/'+job.id+'/parts/'+p.id+'/download'})),
    next_part_no:all.length>100?page[page.length-1].part_no:null,
  };
}
export async function signExportPart(db:SupabaseClient,accountId:string,jobId:string,partId:string) {
  const job=await getExportJob(db,accountId,jobId);
  if(!isExportDownloadable(job))throw notFound('Export file not found or expired');
  const {data,error}=await db.from('conversation_export_parts').select('storage_path,part_no')
    .eq('job_id',jobId).eq('account_id',accountId).eq('id',partId).maybeSingle();
  if(error)throw error;
  if(!data || !isSafeExportPath(data.storage_path,accountId,jobId))throw notFound('Export part not found');
  const filename='conversation-history-'+jobId+'-part-'+data.part_no+'.ndjson.gz';
  const {data:signed,error:signError}=await db.storage.from(EXPORT_BUCKET)
    .createSignedUrl(data.storage_path,60,{download:filename});
  if(signError||!signed?.signedUrl)throw notFound('Export part unavailable');
  return {url:signed.signedUrl,file_name:filename,expires_in_seconds:60};
}
export function isSafeExportPath(path:string,accountId:string,jobId:string) {
  const prefix=accountId+'/'+jobId+'/';
  return path.startsWith(prefix) &&
    !path.split('/').some(v=>!v||v==='.'||v==='..'||v.includes('\\')) &&
    /^part-\d{6}\.ndjson\.gz$/.test(path.slice(prefix.length));
}
