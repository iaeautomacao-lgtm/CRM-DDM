import { timingSafeEqual } from 'node:crypto';

/**
 * Compara o segredo enviado por um chamador operacional (cron, webhook
 * WAHA, stress run) com o valor configurado no servidor.
 *
 * - Fail-closed: se a variável de ambiente não estiver configurada, NUNCA
 *   autoriza (antes, `undefined === undefined` podia liberar o acesso).
 * - Comparação em tempo constante (`timingSafeEqual`) para não vazar o
 *   segredo por diferença de tempo de resposta. A checagem de tamanho vem
 *   antes porque `timingSafeEqual` lança erro com buffers de tamanhos
 *   diferentes.
 *
 * @param expected valor do `.env` (ex.: process.env.CRON_SECRET)
 * @param supplied valor do header da requisição
 */
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
