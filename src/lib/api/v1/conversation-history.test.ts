import { describe,expect,it } from 'vitest';
import { cursorDecode,cursorEncode,limitParam,uuidParam,dayParam,timestampParam } from './conversation-history';
const id='11111111-1111-4111-8111-111111111111';
describe('conversation history public input',()=>{
 it('roundtrips stable ascending cursor',()=>expect(cursorDecode(cursorEncode('2026-10-13T13:00:00.000Z',id))).toEqual({at:'2026-10-13T13:00:00.000Z',id}));
 it('rejects malformed and forged cursors',()=>{for(const s of ['junk',Buffer.from(JSON.stringify({at:'a',id})).toString('base64url')])expect(()=>cursorDecode(s)).toThrow();});
 it('caps pages to protect the service',()=>{expect(limitParam(null)).toBe(50);expect(()=>limitParam('501',100,500)).toThrow();expect(()=>limitParam('0')).toThrow();});
 it('rejects unsafe ids',()=>{expect(uuidParam(id)).toBe(id);expect(()=>uuidParam('1,2')).toThrow();});
 it('validates filtering input',()=>{expect(dayParam('2026-10-13','from')).toBe('2026-10-13');expect(()=>dayParam('yesterday','from')).toThrow();expect(()=>timestampParam('not-a-date','from')).toThrow();});
});