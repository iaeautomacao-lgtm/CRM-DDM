// Memória (aba aberta) da origem de cada conversa aberta no Inbox. Expira em 2 min e é esvaziada com o resto da sessão
// (clearSessionData): nada do usuário anterior fica para o próximo.
export const originCache = new Map<string, Promise<unknown>>();

export function clearOriginCache(): void {
  originCache.clear();
}
