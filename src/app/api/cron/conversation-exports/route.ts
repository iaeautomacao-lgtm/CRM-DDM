import { NextResponse } from 'next/server';
import { matchesOperationalSecret } from '@/lib/auth/operational-secret';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  ExportLimitError, EXPORT_BUCKET, generateConversationExport,
  type ExportJobRow,
} from '@/lib/api/v1/conversation-exports';

export const runtime = 'nodejs';

/** Dedicated background worker: configure cPanel to POST this endpoint
 * every minute with x-cron-secret = AUTOMATION_CRON_SECRET.
 * Processes at most one job per invocation; never exposes transcripts. */
export async function POST(request: Request) {
  const secret = process.env.AUTOMATION_CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  if (!matchesOperationalSecret(secret, request.headers.get('x-cron-secret'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const db = supabaseAdmin();
  const now = new Date().toISOString();

  // Fail abandoned work so it cannot remain 'processing' indefinitely.
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { error: staleError } = await db.from('conversation_export_jobs')
    .update({ status: 'failed', error_code: 'worker_timeout', finished_at: now })
    .eq('status', 'processing').lt('started_at', cutoff);
  if (staleError) return NextResponse.json({ error: 'unavailable' }, { status: 503 });

  // Expired queued jobs must not occupy a key's two pending slots forever.
  const { error: expiredQueueError } = await db.from('conversation_export_jobs')
    .update({ status: 'failed', error_code: 'expired_before_processing', finished_at: now })
    .eq('status', 'queued').lte('expires_at', now);
  if (expiredQueueError) return NextResponse.json({ error: 'unavailable' }, { status: 503 });

  // Remove files after expiry. Private bucket uses no public SELECT policy.
  const { data: expired, error: expiredError } = await db.from('conversation_export_jobs')
    .select('id,storage_path').eq('status', 'completed').lt('expires_at', now)
    .not('storage_path', 'is', null).limit(20);
  if (!expiredError && expired?.length) {
    const paths = expired.map(x => x.storage_path).filter((x): x is string => Boolean(x));
    const { error: removalError } = await db.storage.from(EXPORT_BUCKET).remove(paths);
    if (!removalError) {
      await db.from('conversation_export_jobs').update({ storage_path: null })
        .in('id', expired.map(x => x.id)).eq('status', 'completed');
    }
  }

  const { data: pending, error: pendingError } = await db.from('conversation_export_jobs')
    .select('*').eq('status', 'queued').gt('expires_at', now)
    .order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (pendingError) return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  if (!pending) return NextResponse.json({ status: 'idle' });

  // Claim via compare-and-swap to handle cron invocations racing on cPanel.
  const { data: claimed, error: claimError } = await db.from('conversation_export_jobs')
    .update({ status: 'processing', started_at: now })
    .eq('id', pending.id).eq('status', 'queued')
    .select('*').maybeSingle();
  if (claimError) return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  if (!claimed) return NextResponse.json({ status: 'already_claimed' });

  try {
    const file = await generateConversationExport(db, claimed as ExportJobRow);
    const { error: finishError } = await db.from('conversation_export_jobs')
      .update({ status: 'completed', finished_at: new Date().toISOString(),
        storage_path: file.path, file_bytes: file.bytes,
        conversation_count: file.conversations, message_count: file.messages,
        event_count: file.events, next_cursor: file.nextCursor, error_code: null })
      .eq('id', claimed.id).eq('status', 'processing');
    if (finishError) {
      // Avoid orphaned private blobs if the DB update fails.
      await db.storage.from(EXPORT_BUCKET).remove([file.path]);
      throw new Error('job_update_failed');
    }
    return NextResponse.json({ status: 'completed', job_id: claimed.id,
      conversations: file.conversations, messages: file.messages });
  } catch (error) {
    const code = error instanceof ExportLimitError ? error.code : 'worker_failed';
    // No customer text, tool payloads or authorization keys in logs.
    console.error('[conversation-exports] job failed:', claimed.id, code);
    await db.from('conversation_export_jobs')
      .update({ status: 'failed', finished_at: new Date().toISOString(), error_code: code })
      .eq('id', claimed.id).eq('status', 'processing');
    return NextResponse.json({ status: 'failed', job_id: claimed.id, error_code: code });
  }
}
