// Credenciais do UTMpay em TEXTO, só no servidor, para falar com o UTMpay (conectar/ler a conexão). O que a conta guardou está cifrado; o que acabou de
// ser digitado vem do corpo do PUT. Nunca vai para o navegador, para log ou para erro.
import "server-only";
import { isKeepCurrentSecret } from "@/lib/whatsapp/secret-write";
import { tryDecrypt } from "@/lib/whatsapp/encryption";

/** Valor novo digitado, ou (se vazio/máscara = "manter") o já guardado, decifrado. Null se não há nenhum. */
export function plainSecretFor(submitted: unknown, existingEncrypted: string | null | undefined): string | null {
  if (!isKeepCurrentSecret(submitted)) return (submitted as string).trim() || null;
  if (!existingEncrypted) return null;
  try {
    return tryDecrypt(existingEncrypted).trim() || null;
  } catch {
    return null; // chave de cifra trocada: tratado como "sem segredo"
  }
}
