import { NextResponse } from 'next/server';
import { matchesOperationalSecret } from '@/lib/auth/operational-secret';
import { registerAuditActor } from '@/lib/audit/context';
import { runConversationExportTick } from '@/lib/api/v1/conversation-export-worker';
import { supabaseAdmin } from '@/lib/flows/admin-client';

// Call once per minute from cPanel cron. Always require the same secret as /api/automations/cron.
// No work is started by the public API request; a Passenger restart cannot lose a queued job.
export async function POST(request:Request) {
 const secret=process.env.AUTOMATION_CRON_SECRET;
 if(!secret)return NextResponse.json({error:'cron not configured'},{status:503});
 if(!matchesOperationalSecret(secret,request.headers.get('x-cron-secret')))
   return NextResponse.json({error:'Unauthorized'},{status:401});
 try {
  await registerAuditActor({actorType:'automation',source:'cron_conversation_exports'});
  const result=await runConversationExportTick();
  const response=NextResponse.json(result);
  response.headers.set('Cache-Control','no-store');
  return response;
 }catch(err){
  console.error('[conversation-export] cron failed',err instanceof Error?err.name:'UnknownError');
  return NextResponse.json({error:'Export worker unavailable'},{status:503});
 }
}
export async function GET(request:Request) {
 const secret=process.env.AUTOMATION_CRON_SECRET;
 if(!secret)return NextResponse.json({error:'cron not configured'},{status:503});
 if(!matchesOperationalSecret(secret,request.headers.get('x-cron-secret')))
   return NextResponse.json({error:'Unauthorized'},{status:401});
 const {error}=await supabaseAdmin().from('conversation_export_jobs').select('id').limit(1);
 return NextResponse.json({status:error?'unavailable':'healthy'},{status:error?503:200});
}
