import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({owned:true,row:null as any,rpc:vi.fn(),writes:[] as any[],deletes:[] as any[]}));
vi.mock('./admin-client',()=>({supabaseAdmin:()=>({rpc:mocks.rpc,from:()=>{
 const chain:any={};for(const method of ['select','eq'])chain[method]=()=>chain;
 chain.update=(value:any)=>{mocks.writes.push(value);return chain};chain.delete=()=>{mocks.deletes.push(1);return chain};chain.maybeSingle=async()=>({data:mocks.row,error:null});chain.then=(resolve:any)=>Promise.resolve({error:null}).then(resolve);return chain;
}})}));
import { runIdempotentSend } from './send-ledger';
beforeEach(()=>{mocks.writes.length=0;mocks.deletes.length=0;mocks.owned=true;mocks.row=null;mocks.rpc.mockReset().mockImplementation(async()=>({data:mocks.owned,error:null}))});
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

// ---- modo API pública (envelope + liberação da reserva em erro pré-provedor) ----
it('api: chave ausente → ApiError 400 no envelope',async()=>{
 const work=vi.fn();
 await expect(runIdempotentSend('account',request(''),work,{apiEnvelope:true})).rejects.toMatchObject({code:'bad_request',status:400});
 expect(work).not.toHaveBeenCalled();
});
it('api: conflito de conteúdo, resultado desconhecido e indisponibilidade viram ApiError',async()=>{
 await runIdempotentSend('account',request(),async()=>new Response('{"success":true}',{status:200}),{apiEnvelope:true});
 const hash=mocks.rpc.mock.calls[0][1].p_hash;
 mocks.owned=false;
 mocks.row={request_hash:'outro',state:'reserved'};
 await expect(runIdempotentSend('account',request(),vi.fn(),{apiEnvelope:true})).rejects.toMatchObject({code:'conflict',status:409});
 mocks.row={request_hash:hash,state:'reserved'};
 await expect(runIdempotentSend('account',request(),vi.fn(),{apiEnvelope:true})).rejects.toMatchObject({code:'conflict',status:409,extra:{provider_outcome_unknown:true}});
 mocks.rpc.mockResolvedValue({error:{message:'offline'},data:null});
 await expect(runIdempotentSend('account',request(),vi.fn(),{apiEnvelope:true})).rejects.toMatchObject({code:'unavailable',status:503});
});
it('api: erro ANTES de chamar o provedor libera a reserva (corrige e reenvia com a mesma chave)',async()=>{
 await expect(runIdempotentSend('account',request(),async()=>{throw Object.assign(new Error('validação'),{status:400})},{apiEnvelope:true})).rejects.toThrow('validação');
 expect(mocks.deletes).toHaveLength(1);
});
it('api: erro DEPOIS de chamar o provedor mantém a reserva (resultado incerto)',async()=>{
 await expect(runIdempotentSend('account',request(),async(ctl)=>{ctl.providerCalled();throw new Error('timeout do provedor')},{apiEnvelope:true})).rejects.toThrow('timeout');
 expect(mocks.deletes).toHaveLength(0);
});
it('rota do dashboard (sem apiEnvelope) nunca libera a reserva',async()=>{
 await expect(runIdempotentSend('account',request(),async()=>{throw new Error('x')})).rejects.toThrow('x');
 expect(mocks.deletes).toHaveLength(0);
});
