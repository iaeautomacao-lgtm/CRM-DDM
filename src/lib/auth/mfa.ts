// Verificação em duas etapas obrigatória (TOTP) — regra única usada pelo servidor (getCurrentAccount) e pela guarda do
// painel. Módulo puro: pode ir ao navegador.
//
// Quem tem fator TOTP VERIFICADO precisa de sessão aal2. Sessão aal1 (só senha) desse usuário:
//   - rotas /api de sessão → 401 { code: 'mfa_required' } (getCurrentAccount);
//   - páginas do painel → /login/2fa?next=… (guarda do shell + apiFetch).
// Ficam fora, por construção: rotas públicas, /api/v1 (chave de API), crons com segredo, webhooks, /w/[token], o próprio
// /login/2fa e o logout (nenhum deles passa por getCurrentAccount nem pelo shell do painel).

export const MFA_PATH = '/login/2fa';
export const MFA_REQUIRED_CODE = 'mfa_required';

export type Aal = 'aal1' | 'aal2';

export interface FactorLike {
  factor_type?: string;
  status?: string;
}

/** O usuário tem ao menos um fator TOTP verificado? (fatores não verificados = cadastro não concluído) */
export function hasVerifiedTotp(factors: readonly FactorLike[] | null | undefined): boolean {
  return (factors ?? []).some((f) => f.factor_type === 'totp' && f.status === 'verified');
}

function decodeBase64Url(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Nível de garantia (`aal`) do access token. Sem validar assinatura: só é chamado DEPOIS que o Supabase validou o
 * mesmo token (getUser). Token ilegível ou sem claim conta como aal1 (o lado seguro).
 */
export function aalFromAccessToken(token: string | null | undefined): Aal {
  try {
    const payload = token?.split('.')[1];
    if (!payload) return 'aal1';
    const claims = JSON.parse(decodeBase64Url(payload)) as { aal?: unknown };
    return claims.aal === 'aal2' ? 'aal2' : 'aal1';
  } catch {
    return 'aal1';
  }
}

/** Falta o segundo fator? */
export function isMfaRequired(factors: readonly FactorLike[] | null | undefined, aal: Aal): boolean {
  return hasVerifiedTotp(factors) && aal !== 'aal2';
}

/** URL do passo de código, levando de volta para onde o usuário estava (sem apontar para o próprio passo). */
export function mfaRedirectUrl(currentPath: string | null | undefined): string {
  const next = currentPath && currentPath.startsWith('/') && !currentPath.startsWith(MFA_PATH) ? currentPath : '/dashboard';
  return `${MFA_PATH}?next=${encodeURIComponent(next)}`;
}

/** Código TOTP digitado: só dígitos, até 6. */
export function normalizeTotpCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 6);
}

/** Erro do Supabase Auth na verificação → mensagem legível (o texto original vem em inglês). */
export function verifyErrorMessage(message: string | undefined): string {
  const m = (message ?? '').toLowerCase();
  if (m.includes('rate') || m.includes('too many')) return 'Muitas tentativas. Aguarde um instante e tente de novo.';
  if (m.includes('invalid') || m.includes('expired')) return 'Código inválido ou expirado. Confira o horário do celular e use o código atual.';
  return 'Não foi possível verificar o código. Tente de novo.';
}
