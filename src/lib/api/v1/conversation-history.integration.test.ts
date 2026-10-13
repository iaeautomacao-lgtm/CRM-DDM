import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { batchMessages, cursorDecode, getConversation, listConversations, listMessages } from './conversation-history';
import { buildExportChunk } from './conversation-export-worker';
import { isSafeExportPath, isExportDownloadable, parseExportFilters, signExportPart, type ExportJob } from './conversation-exports';
import { isOwnedChatMediaPath } from './conversation-media';

const A='11111111-1111-4111-8111-111111111111';
const B='22222222-2222-4222-8222-222222222222';
const C1='33333333-3333-4333-8333-333333333333';
const C2='44444444-4444-4444-8444-444444444444';
const C3='55555555-5555-4555-8555-555555555555';
const M1='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const M2='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const M3='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ts='2026-10-13T14:00:00.000Z';
type Row=Record<string,unknown>;
function fakeDb(tables:Record<string,Row[]>) {
 const calls:Array<{table:string;conditions:string[]}> = [];
 const from=vi.fn((table:string)=>{
   const conditions:string[]=[];
   calls.push({table,conditions});
   const filters:Array<(row:Row)=>boolean>=[];
   const orders:Array<{key:string,ascending:boolean}>=[];
   let max=999999;
   const run=()=>{
     const data=[...(tables[table]??[])].filter(row=>filters.every(f=>f(row)));
     data.sort((a,b)=>{
       for(const order of orders) {
         const x=String(a[order.key]??''),y=String(b[order.key]??'');
         const d=x.localeCompare(y);
         if(d)return order.ascending?d:-d;
       }
       return 0;
     });
     return { data:data.slice(0,max),error:null };
   };
   const q:Record<string,any>={};
   q.select=()=>q;
   q.eq=(key:string,value:unknown)=>{conditions.push(key+'='+String(value));filters.push(row=>row[key]===value);return q;};
   q.in=(key:string,values:unknown[])=>{conditions.push(key+'.in');filters.push(row=>values.includes(row[key]));return q;};
   q.gte=(key:string,value:string)=>{filters.push(row=>String(row[key])>=value);return q;};
   q.lte=(key:string,value:string)=>{filters.push(row=>String(row[key])<=value);return q;};
   q.lt=(key:string,value:string)=>{filters.push(row=>String(row[key])<value);return q;};
   q.gt=(key:string,value:unknown)=>{filters.push(row=>String(row[key])>String(value));return q;};
   q.or=(raw:string)=>{
     const found=/^created_at\.gt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.gt\.([^)]+)\)$/.exec(raw);
     if(!found)throw new Error('unexpected cursor filter: '+raw);
     filters.push(row=>String(row.created_at)>found[1]||(String(row.created_at)===found[2] && String(row.id)>found[3]));
     return q;
   };
   q.order=(key:string,config:{ascending?:boolean}={})=>{orders.push({key,ascending:config.ascending!==false});return q;};
   q.limit=(n:number)=>{max=n;return q;};
   q.maybeSingle=async()=>{const res=run();return {data:res.data[0]??null,error:null};};
   q.then=(resolve:(x:{data:Row[],error:null})=>unknown,reject?:unknown)=>Promise.resolve(run()).then(resolve);
   return q;
 });
 return {db:{from} as unknown as SupabaseClient,calls,from};
}
function conversation(id:string,account_id:string,created_at=ts):Row {return {id,account_id,contact_id:C1,status:'open',created_at};}
function message(id:string,conversation_id:string,account_id:string,created_at=ts,media_url:string|null=null):Row {
 return {id,conversation_id,account_id,created_at,sender_type:'customer',content_type:'text',content_text:'mensagem integral',media_url};
}

describe('isolamento da API de historico',()=>{
 it('returns not_found for a conversation belonging to a different account',async()=>{
   const f=fakeDb({conversations:[conversation(C2,B)]});
   await expect(getConversation(f.db,A,C2)).rejects.toMatchObject({code:'not_found',status:404});
   expect(f.calls[0].conditions).toContain('account_id='+A);
 });
 it('pagination reads all messages, stable for equal timestamps, never leaks another account',async()=>{
   const f=fakeDb({conversations:[conversation(C1,A)],messages:[
      message(M1,C1,A),message(M2,C1,A),message(M3,C1,A,ts,'/api/chat-media/account-'+A+'/documento.pdf'),
      message(C2,C1,B),message(C3,C2,A)
   ]});
   const first=await listMessages(f.db,A,C1,2,null);
   expect(first.items.map(m=>m.id)).toEqual([M1,M2]);
   expect(first.next_cursor).toBeTruthy();
   const second=await listMessages(f.db,A,C1,2,first.next_cursor);
   expect(second.items.map(m=>m.id)).toEqual([M3]);
   expect(second.next_cursor).toBeNull();
   expect(second.items[0].media_download_url).toContain('/messages/'+M3+'/media');
   expect(f.calls.filter(c=>c.table==='messages').every(c=>c.conditions.includes('account_id='+A))).toBe(true);
 });
 it('rejects mixed account batch before reading any messages',async()=>{
   const f=fakeDb({conversations:[conversation(C1,A),conversation(C2,B)],messages:[message(M1,C1,A)]});
   await expect(batchMessages(f.db,A,{conversation_ids:[C1,C2]})).rejects.toMatchObject({code:'not_found'});
   expect(f.calls.some(c=>c.table==='messages')).toBe(false);
 });
 it('lists only the account conversations and provides a stable cursor',async()=>{
   const f=fakeDb({conversations:[conversation(C1,A),conversation(C2,A),conversation(C3,B)]});
   const first=await listConversations(f.db,A,new URLSearchParams({limit:'1'}));
   expect(first.items).toHaveLength(1);expect(first.next_cursor).toBeTruthy();
   expect(cursorDecode(first.next_cursor)?.id).toBe(C1);
   const second=await listConversations(f.db,A,new URLSearchParams({limit:'1',cursor:first.next_cursor!}));
   expect(second.items.map(c=>c.id)).toEqual([C2]);expect(second.next_cursor).toBeNull();
 });
 it('limits snapshot to old messages only',async()=>{
   const f=fakeDb({conversations:[conversation(C1,A)],messages:[
     message(M1,C1,A,'2026-10-13T13:59:59.000Z'),message(M2,C1,A,'2026-10-13T14:00:01.000Z'),
   ]});
   const page=await listMessages(f.db,A,C1,100,null,ts);
   expect(page.items.map(m=>m.id)).toEqual([M1]);
 });
});
describe('safe export and private media',()=>{
 it('rejects unsupported filter, invalid date, and ranges over 366 days',()=>{
   expect(()=>parseExportFilters({from:'2026-02-30',to:'2026-03-01'})).toThrow();
   expect(()=>parseExportFilters({from:'2025-01-01',to:'2026-10-13'})).toThrow();
   expect(()=>parseExportFilters({from:'2026-10-10',to:'2026-10-13',account_id:B})).toThrow();
   expect(parseExportFilters({from:'2026-10-10',to:'2026-10-13'})).toEqual({from:'2026-10-10',to:'2026-10-13'});
 });
 it('never signs a path in another account, traversal, or after expiry',()=>{
   expect(isSafeExportPath(A+'/'+C1+'/part-000001.ndjson.gz',A,C1)).toBe(true);
   expect(isSafeExportPath(B+'/'+C1+'/part-000001.ndjson.gz',A,C1)).toBe(false);
   expect(isSafeExportPath(A+'/'+C1+'/../file',A,C1)).toBe(false);
   expect(isExportDownloadable({status:'completed',expires_at:'2020-01-01T00:00:00Z'})).toBe(false);
   expect(isOwnedChatMediaPath('account-'+B+'/file',A)).toBe(false);
   expect(isOwnedChatMediaPath('account-'+A+'/file',A)).toBe(true);
   expect(isOwnedChatMediaPath('account-'+A+'/../file',A)).toBe(false);
 });
 it('does not sign a cross-account job or part',async()=>{
   const f=fakeDb({conversation_export_jobs:[{id:C1,account_id:B,status:'completed',expires_at:'2099-01-01T00:00:00Z'}]});
   const storage={from:vi.fn()};
   Object.assign(f.db,{storage});
   await expect(signExportPart(f.db,A,C1,M1)).rejects.toMatchObject({code:'not_found'});
   expect(storage.from).not.toHaveBeenCalled();
 });
});
describe('async export worker snapshot',()=>{
 function job(overrides:Partial<ExportJob>={}):ExportJob {
  return {id:C3,account_id:A,created_by_key_id:M1,status:'running',filters:{from:'2026-10-13',to:'2026-10-13'},
    snapshot_at:'2026-10-13T20:00:00.000Z',expires_at:'2099-01-01T00:00:00Z',next_run_at:ts,
    lease_token:M1,attempts:1,conversation_cursor:null,message_cursor:null,parts_count:0,
    conversations_exported:0,messages_exported:0,created_at:ts,updated_at:ts,error_code:null,...overrides};
 }
 it('exports complete chronological messages and original conversation metadata',async()=>{
   const f=fakeDb({conversations:[conversation(C1,A),conversation(C2,B)],messages:[message(M1,C1,A),message(M2,C1,A)]});
   const result=await buildExportChunk(f.db,job());
   expect(result.done).toBe(true);
   expect(result.conversationsCount).toBe(1);
   expect(result.messagesCount).toBe(2);
   expect(result.rows.map(row=>JSON.parse(row).record_type)).toEqual(['conversation','message','message']);
 });
 it('resumes a long conversation without duplicating its metadata',async()=>{
   const msgs=Array.from({length:1501},(_,i)=>message('00000000-0000-4000-8000-'+String(i).padStart(12,'0'),C1,A,'2026-10-13T14:00:00.000Z'));
   const f=fakeDb({conversations:[conversation(C1,A)],messages:msgs});
   const first=await buildExportChunk(f.db,job());
   expect(first.done).toBe(false);
   expect(first.messagesCount).toBe(1500);
   expect(first.conversationsCount).toBe(1);
   const second=await buildExportChunk(f.db,job({conversation_cursor:first.conversationCursor,message_cursor:first.messageCursor}));
   expect(second.done).toBe(true);
   expect(second.messagesCount).toBe(1);
   expect(second.conversationsCount).toBe(0);
   expect(second.rows.map(x=>JSON.parse(x).record_type)).toEqual(['message']);
 });
});
