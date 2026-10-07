// Variáveis e credenciais da conta — lado SERVIDOR (wacrm.account_secrets,
// migration 175). Carrega e decifra os valores para UMA chamada de ferramenta
// (cache por chamada, nunca por processo: trocar/apagar uma credencial vale na
// hora) e guarda a conta atual num AsyncLocalStorage para o responder não
// precisar de um parâmetro novo em generateOpenAiResponse.
//
// Nunca loga valores. Credencial que não decifra (ENCRYPTION_KEY trocada,
// linha corrompida) é IGNORADA — o marcador vira "ausente" e a ferramenta
// falha de forma explícita, em vez de enviar lixo.

import { AsyncLocalStorage } from "node:async_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { decrypt, isEncryptedSecret } from "@/lib/whatsapp/encryption";
import type { AccountSecretsContext } from "@/lib/ai/tool-secrets";

interface SecretRow {
  name: string;
  kind: "variable" | "credential";
  value_plain: string | null;
  value_encrypted: string | null;
  allowed_hosts: string[] | null;
}

const EMPTY: AccountSecretsContext = { vars: new Map(), creds: new Map() };

/**
 * Carrega as variáveis e credenciais (decifradas) da conta. Falha de leitura
 * devolve vazio + log SEM valores: o comportamento cai no do ambiente.
 */
export async function loadAccountSecrets(accountId: string): Promise<AccountSecretsContext> {
  return loadAccountSecretsFrom(supabaseAdmin(), accountId, { decryptCredentials: true });
}

/**
 * Lê as linhas de account_secrets de `db` (cliente real OU o banco em memória
 * do simulador). `decryptCredentials: false` (simulador): credenciais entram com
 * valor VAZIO — só nome e hosts —, porque a simulação nunca resolve credencial
 * (mostra "***"); variáveis são texto comum e vêm com o valor.
 */
export async function loadAccountSecretsFrom(
  db: Pick<SupabaseClient, "from">,
  accountId: string,
  options: { decryptCredentials: boolean },
): Promise<AccountSecretsContext> {
  const { data, error } = await db
    .from("account_secrets")
    .select("name, kind, value_plain, value_encrypted, allowed_hosts")
    .eq("account_id", accountId);
  if (error) {
    console.error("[account-secrets] falha ao ler variáveis/credenciais da conta:", error.message);
    return EMPTY;
  }
  const vars = new Map<string, string>();
  const creds = new Map<string, { value: string; hosts: readonly string[] }>();
  for (const row of (data ?? []) as SecretRow[]) {
    if (row.kind === "variable") {
      if (row.value_plain !== null) vars.set(row.name, row.value_plain);
      continue;
    }
    if (!row.allowed_hosts?.length) continue;
    const hosts = row.allowed_hosts.map((h) => h.toLowerCase());
    if (!options.decryptCredentials) {
      creds.set(row.name, { value: "", hosts });
      continue;
    }
    if (!row.value_encrypted) continue;
    try {
      // Estrito: a tabela só recebe valores cifrados pelo servidor. Texto fora do
      // formato iv:ciphertext:authTag NÃO é tratado como "legado em texto puro"
      // (decryptStoredSecret devolveria o próprio texto e ele iria para o host).
      if (!isEncryptedSecret(row.value_encrypted)) {
        console.error("[account-secrets] credencial fora do formato cifrado, ignorada:", row.name);
        continue;
      }
      const value = decrypt(row.value_encrypted);
      if (value) creds.set(row.name, { value, hosts });
    } catch {
      console.error("[account-secrets] credencial não pôde ser decifrada:", row.name);
    }
  }
  return { vars, creds };
}

interface SecretsScope {
  accountId: string;
  /** Carga usada pelas ferramentas (produção: real; simulador: memória, sem valores de credencial). */
  load: (accountId: string) => Promise<AccountSecretsContext>;
  /** Carga REAL (decifrada), só para a leitura somente-leitura liberada do simulador. */
  loadReal: (accountId: string) => Promise<AccountSecretsContext>;
}

const scope = new AsyncLocalStorage<SecretsScope>();

/**
 * Roda `fn` com a conta atual disponível para as ferramentas HTTP do agente de IA.
 * O simulador passa `loaders` próprios para NÃO ler credenciais do banco real.
 */
export function withAccountSecretsScope<T>(
  accountId: string,
  fn: () => Promise<T>,
  loaders: { load?: SecretsScope["load"]; loadReal?: SecretsScope["loadReal"] } = {},
): Promise<T> {
  return scope.run({ accountId, load: loaders.load ?? loadAccountSecrets, loadReal: loaders.loadReal ?? loadAccountSecrets }, fn);
}

/**
 * Segredos da conta do escopo atual (carregados agora — por chamada de
 * ferramenta). Fora de um escopo (ex.: testes diretos) devolve null: só o
 * ambiente resolve {{secret.X}}.
 */
export async function currentAccountSecrets(): Promise<AccountSecretsContext | null> {
  const current = scope.getStore();
  return current ? current.load(current.accountId) : null;
}

/** Idem, com os valores REAIS (decifrados): só para a leitura real liberada no simulador. */
export async function currentRealAccountSecrets(): Promise<AccountSecretsContext | null> {
  const current = scope.getStore();
  return current ? current.loadReal(current.accountId) : null;
}

/** Nomes cadastrados na conta (para o validador de fluxo). Sem valores. */
export async function listAccountSecretNames(
  accountId: string,
): Promise<{ credentials: string[]; variables: string[] }> {
  const { data, error } = await supabaseAdmin()
    .from("account_secrets")
    .select("name, kind")
    .eq("account_id", accountId);
  if (error) return { credentials: [], variables: [] };
  const rows = (data ?? []) as Array<{ name: string; kind: string }>;
  return {
    credentials: rows.filter((r) => r.kind === "credential").map((r) => r.name),
    variables: rows.filter((r) => r.kind === "variable").map((r) => r.name),
  };
}
