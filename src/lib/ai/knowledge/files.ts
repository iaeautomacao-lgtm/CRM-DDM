// Arquivos de conhecimento da conta (wacrm.knowledge_base_files, migration 214). Servidor, service role,
// sempre escopado pela conta. O conteúdo (texto extraído) nunca volta para o navegador.

import "server-only";
import { createHash, randomUUID } from "node:crypto";

import { supabaseAdmin } from "@/lib/flows/admin-client";

export interface KnowledgeFileSummary {
  id: string;
  name: string;
  mime_type: string | null;
  size_bytes: number | null;
  char_count: number | null;
  created_at: string;
}

const SUMMARY_COLUMNS = "id, name, mime_type, size_bytes, char_count, created_at";
const PAGE = 1000;

export async function listKnowledgeFiles(accountId: string): Promise<KnowledgeFileSummary[]> {
  const out: KnowledgeFileSummary[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin()
      .from("knowledge_base_files")
      .select(SUMMARY_COLUMNS)
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`knowledge_base_files: ${error.message}`);
    const rows = (data ?? []) as KnowledgeFileSummary[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

export async function createKnowledgeFile(input: {
  accountId: string;
  userId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  text: string;
}): Promise<KnowledgeFileSummary> {
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin()
    .from("knowledge_base_files")
    .insert({
      id: randomUUID(),
      account_id: input.accountId,
      name: input.name,
      content: input.text,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      char_count: input.text.length,
      content_hash: createHash("sha256").update(input.text).digest("hex"),
      created_by: input.userId,
      created_at: now,
      updated_at: now,
    })
    .select(SUMMARY_COLUMNS)
    .limit(1);
  if (error) throw new Error(`knowledge_base_files: ${error.code ?? error.message}`);
  return (data as KnowledgeFileSummary[])[0];
}

export type DeleteKnowledgeFileResult = { ok: true } | { ok: false; status: 404 | 409; error: string };

/**
 * Apaga o arquivo da conta. Recusa (409) se alguma versão de agente o escolhe explicitamente
 * (ai_agent_knowledge.file_ids, inclusive versões anteriores: apagar quebraria o histórico/rollback),
 * como as ferramentas.
 */
export async function deleteKnowledgeFile(accountId: string, id: string): Promise<DeleteKnowledgeFileResult> {
  const db = supabaseAdmin();
  const { data: own, error: ownError } = await db
    .from("knowledge_base_files")
    .select("id")
    .eq("account_id", accountId)
    .eq("id", id)
    .limit(1);
  if (ownError) throw new Error(`knowledge_base_files: ${ownError.message}`);
  if ((own ?? []).length === 0) return { ok: false, status: 404, error: "Arquivo não encontrado." };

  const { data: refs, error: refsError } = await db
    .from("ai_agent_knowledge")
    .select("agent_version_id")
    .eq("account_id", accountId)
    .contains("file_ids", [id])
    .limit(1);
  if (refsError) throw new Error(`ai_agent_knowledge: ${refsError.message}`);
  if ((refs ?? []).length > 0) {
    return {
      ok: false,
      status: 409,
      error: "Este arquivo é usado por agentes (inclusive em versões anteriores) e não pode ser removido.",
    };
  }

  const { error } = await db.from("knowledge_base_files").delete().eq("account_id", accountId).eq("id", id);
  if (error) throw new Error(`knowledge_base_files: ${error.message}`);
  return { ok: true };
}
