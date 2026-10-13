import { ok, type ApiCallLogContext } from '@/lib/api/v1/respond';

/** Transcripts contain customer PII; forbid downstream browser/proxy caching. */
export function privateOk(data: unknown, logCtx: ApiCallLogContext, status = 200) {
  const response = ok(data, status, logCtx);
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  response.headers.set('Pragma', 'no-cache');
  return response;
}
