import { describe,expect,it } from 'vitest';
import { readBoundedJson } from './limited-json';

describe('bounded public API request bodies',()=>{
  it('parses a small JSON payload',async()=>{
    const req=new Request('https://crm.test/api/v1/conversations/exports',{method:'POST',body:JSON.stringify({from:'2026-10-13'})});
    expect(await readBoundedJson(req,1000)).toEqual({from:'2026-10-13'});
  });
  it('returns 413 for oversized request without relying on Content-Length',async()=>{
    const req=new Request('https://crm.test/api/v1/conversations/exports',{method:'POST',body:JSON.stringify({x:'a'.repeat(10000)})});
    req.headers.delete('content-length');
    await expect(readBoundedJson(req,1000)).rejects.toMatchObject({code:'payload_too_large',status:413});
  });
  it('rejects malformed JSON',async()=>{
    const req=new Request('https://crm.test/api/v1/conversations/exports',{method:'POST',body:'not-json'});
    await expect(readBoundedJson(req,1000)).rejects.toMatchObject({code:'bad_request',status:400});
  });
});
