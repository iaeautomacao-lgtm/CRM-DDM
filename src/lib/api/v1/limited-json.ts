import { badRequest, payloadTooLarge } from '@/lib/api/v1/respond';

/** Read a bounded JSON body even when Content-Length is absent (chunked requests).
 * No request may force a service-role API route to buffer arbitrary megabytes. */
export async function readBoundedJson(request:Request,cap:number):Promise<unknown> {
  const stated=Number(request.headers.get('content-length')??0);
  if(Number.isFinite(stated)&&stated>cap)throw payloadTooLarge('Request body too large');
  const reader=request.body?.getReader();
  if(!reader)throw badRequest('Missing JSON body');
  const chunks:Uint8Array[]=[];
  let total=0;
  for(;;) {
    const {value,done}=await reader.read();
    if(done)break;
    if(value){
      total+=value.byteLength;
      if(total>cap) {
        await reader.cancel().catch(()=>undefined);
        throw payloadTooLarge('Request body too large');
      }
      chunks.push(value);
    }
  }
  try{return JSON.parse(Buffer.concat(chunks.map(c=>Buffer.from(c))).toString('utf8')) as unknown;}
  catch{throw badRequest('Invalid JSON body');}
}
