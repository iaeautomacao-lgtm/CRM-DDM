import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({owned:true,row:null as any,rpc:vi.fn(),writes:[] as any[]}));
vi.mock('./admin-client',()=>({supabaseAdmin:()=>({rpc:mocks.rpc,from:()=>{
 const chain:any={};for(const method of ['select','eq'])chain[method]=()=>chain;
 chain.update=(value:any)=>{mocks.writes.push(value);return chain};chain.maybeSingle=async()=>({data:mocks.row,error:null});chain.then=(resolve:any)=>Promise.resolve({error:null}).then(resolve);return chain;
}})}));
import { runIdempotentSend } from './send-ledger';
beforeEach(()=>{mocks.writes.length=0;mocks.owned=true;mocks.row=null;mocks.rpc.mockReset().mockImplementation(async()=>({data:mocks.owned,error:null}))});
const request=(key='intent-001')=>new Request('https://crm.test/api/whatsapp/send',{method:'POST',headers:{'Idempotency-Key':key},body:'{"text":"hello"}'});
it('rejects missing keys without touching the database or provider',async()=>{
 const work=vi.fn();expect((await runIdempotentSend('account',request(''),work)).status).toBe(400);expect(mocks.rpc).not.toHaveBeenCalled();expect(work).not.toHaveBeenCalled();
});
it('does not call the provider when the same operation is still reserved',async()=>{
 await runIdempotentSend('account',request(),async()=>new Response('{"success":true}',{status:202}));
 const hash=mocks.rpc.mock.calls[0][1].p_hash;mocks.owned=false;mocks.row={request_hash:hash,state:'reserved'};
 const work=vi.fn();expect((await runIdempotentSend('account',request(),work)).status).toBe(409);expect(work).not.toHaveBeenCalled();
});
it('replays an accepted response without repeating the external send',async()=>{
 await runIdempotentSend('account',request(),async()=>new Response('{"whatsapp_message_id":"accepted"}',{status:202}));
 mocks.owned=false;mocks.row={request_hash:mocks.rpc.mock.calls[0][1].p_hash,state:'completed',response_body:{whatsapp_message_id:'accepted'},response_status:202};
 const work=vi.fn();const res=await runIdempotentSend('account',request(),work);expect(res.status).toBe(202);expect(await res.json()).toEqual({whatsapp_message_id:'accepted'});expect(work).not.toHaveBeenCalled();
});
it('fails closed when the reservation database is unavailable',async()=>{
 mocks.rpc.mockResolvedValue({error:{message:'offline'},data:null});const work=vi.fn();expect((await runIdempotentSend('account',request(),work)).status).toBe(503);expect(work).not.toHaveBeenCalled();
});
