import { timingSafeEqual } from 'node:crypto';

/** Missing server configuration must never authorize an operational request. */
export function matchesOperationalSecret(
  expected: string | undefined,
  supplied: string | null
): boolean {
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}
