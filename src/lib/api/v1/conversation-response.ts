import { ok, type ApiCallLogContext } from '@/lib/api/v1/respond';

/** Conversation content contains personal and financial data: never cache in intermediaries. */
export function privateOk<T>(value:T,status=200,logCtx?:ApiCallLogContext) {
  const response=ok(value,status,logCtx);
  response.headers.set('Cache-Control','private, no-store, max-age=0');
  response.headers.set('Pragma','no-cache');
  response.headers.set('X-Content-Type-Options','nosniff');
  return response;
}
