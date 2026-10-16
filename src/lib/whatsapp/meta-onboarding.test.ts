import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import { accessibleWabas,discoverMetaPhones,MetaDiscoveryError,recheckMetaPhone } from './meta-onboarding'

const good=(v:unknown)=>new Response(JSON.stringify(v),{status:200,headers:{'content-type':'application/json'}})
const denied=()=>new Response(JSON.stringify({error:{message:'secret-details-do-not-leak'}}),{status:403})
describe('Meta onboarding: Graph discovery read-only',()=>{
  let request:ReturnType<typeof vi.fn>
  beforeEach(()=>{
    vi.stubEnv('META_ONBOARDING_GRAPH_VERSION','v26.0')
    request=vi.fn((input:URL,init:RequestInit)=>{
      const u=new URL(String(input))
      if(u.pathname.endsWith('/owned_whatsapp_business_accounts'))
        return Promise.resolve(good({data:[{id:'123456789',name:'Minha conta'}]}))
      if(u.pathname.endsWith('/client_whatsapp_business_accounts'))
        return Promise.resolve(good({data:[{id:'987654321',name:'Compartilhada'}]}))
      if(u.pathname.endsWith('/123456789/phone_numbers'))
        return Promise.resolve(good({data:[{id:'55555555',display_phone_number:'+55 21 99999-0000',quality_rating:'GREEN'}]}))
      if(u.pathname.endsWith('/987654321/phone_numbers'))
        return Promise.resolve(good({data:[{id:'77777777',display_phone_number:'+55 21 99999-0001'}]}))
      return Promise.resolve(new Response('',{status:404}))
    })
    vi.stubGlobal('fetch',request)
  })
  afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs()})
  it('discovers WABAs and phones without write calls',async()=>{
    const data=await discoverMetaPhones('private-test-token','111111111')
    expect(data.partial).toBe(false)
    expect(data.phones.map(p=>p.id)).toEqual(['55555555','77777777'])
    for(const [input,init] of request.mock.calls){
      expect(String(input)).toMatch(/^https:\/\/graph\.facebook\.com\/v26\.0\//)
      expect(init.method).toBe('GET')
      expect(init.redirect).toBe('error')
      expect(init.headers.Authorization).toBe('Bearer private-test-token')
      expect(String(input)).not.toContain('private-test-token')
      expect(String(input)).not.toMatch(/\/register|\/subscribed_apps/)
    }
  })
  it('rechecks membership rather than trusting submitted phone IDs',async()=>{
    expect(await recheckMetaPhone('private-test-token','123456789','99999999')).toBeNull()
    expect((await recheckMetaPhone('private-test-token','123456789','55555555'))?.id).toBe('55555555')
  })
  it('rejects arbitrary URLs as Graph IDs',async()=>{
    await expect(accessibleWabas('token','https://evil.example')).rejects.toMatchObject({code:'invalid_id'})
    expect(request).not.toHaveBeenCalled()
  })
  it('never forwards provider raw error message or token',async()=>{
    request.mockResolvedValue(denied())
    await expect(accessibleWabas('secret-token','111111111')).rejects.toBeInstanceOf(MetaDiscoveryError)
    await expect(accessibleWabas('secret-token','111111111')).rejects.toThrow('auth')
    expect(String(request.mock.calls[0][0])).not.toContain('secret-token')
  })
})
