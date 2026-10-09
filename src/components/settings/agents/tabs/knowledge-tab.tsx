'use client';

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Database, FileText, Globe, Search, AlertCircle, Loader2, RefreshCw, Sparkles, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  KB_ACCEPT,
  KB_ACCEPT_LABEL,
  KB_MAX_FILE_BYTES,
  formatBytes,
} from '@/lib/ai/knowledge/limits';
import { AgentApiError, reindexKnowledgeFile, removeKnowledgeFile, uploadKnowledgeFile } from '../api';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import type {
  AgentFormData,
  KnowledgeBaseFileItem,
  SecretItem,
} from '../types';

interface KnowledgeTabProps {
  data: AgentFormData;
  onChange: (patch: Partial<AgentFormData>) => void;
  kbFiles: KnowledgeBaseFileItem[];
  /** Lista de arquivos da conta mudou (envio/remoção). */
  onFilesChange: (files: KnowledgeBaseFileItem[]) => void;
  /** Teto de caracteres da base deste agente (knowledge.max_chars). */
  maxChars: number;
  secrets: SecretItem[];
  readOnly?: boolean;
}

const NUMBER = new Intl.NumberFormat('pt-BR');

/** Situação do índice da busca por trechos, para a lista. */
const INDEX_LABEL: Record<string, { text: string; tone: 'ok' | 'warn' | 'muted' }> = {
  indexed: { text: 'Indexado', tone: 'ok' },
  pending: { text: 'Indexando…', tone: 'muted' },
  no_key: { text: 'Sem chave de IA da conta', tone: 'warn' },
  failed: { text: 'Falha ao indexar', tone: 'warn' },
  too_large: { text: 'Grande demais para indexar', tone: 'warn' },
};
function indexLabel(status: string | null | undefined) {
  return (status && INDEX_LABEL[status]) || { text: 'Sem índice', tone: 'muted' as const };
}

export function KnowledgeTab({
  data,
  onChange,
  kbFiles,
  onFilesChange,
  maxChars,
  secrets,
  readOnly,
}: KnowledgeTabProps) {
  const [fileFilter, setFileFilter] = useState('');
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const knowledge = data.knowledge;
  const rag = knowledge.rag_external;
  const credentialSecrets = secrets.filter((s) => s.kind === 'credential');

  const selectedFileIds = new Set(knowledge.file_ids);

  const filteredFiles = kbFiles.filter((f) =>
    f.name.toLowerCase().includes(fileFilter.toLowerCase()),
  );
  const explicit = knowledge.selection_mode === 'explicit';
  // Arquivos que este agente consulta: todos (modo da conta) ou só os escolhidos.
  const inUse = explicit ? kbFiles.filter((f) => selectedFileIds.has(f.id)) : kbFiles;
  const usedChars = inUse.reduce((sum, f) => sum + (f.char_count ?? 0), 0);
  const unknownChars = inUse.some((f) => f.char_count == null);
  const usedPct = maxChars > 0 ? Math.round((usedChars / maxChars) * 100) : 0;
  const overLimit = usedChars > maxChars;

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > KB_MAX_FILE_BYTES) {
      toast.error('Arquivo maior que 10 MB.');
      return;
    }
    setUploading(true);
    try {
      const saved = await uploadKnowledgeFile(file);
      onFilesChange([saved, ...kbFiles.filter((f) => f.id !== saved.id)]);
      // Já vincula ao agente quando ele usa arquivos escolhidos (vale ao publicar a nova versão).
      if (explicit && !selectedFileIds.has(saved.id)) {
        onChange({ knowledge: { ...knowledge, file_ids: [...knowledge.file_ids, saved.id] } });
      }
      toast.success(`${saved.name} enviado (${NUMBER.format(saved.char_count ?? 0)} caracteres · ${indexLabel(saved.embedding_status).text.toLowerCase()}).`);
    } catch (err) {
      toast.error(err instanceof AgentApiError ? err.message : 'Não foi possível enviar o arquivo.');
    } finally {
      setUploading(false);
    }
  }

  async function handleReindex(file: KnowledgeBaseFileItem) {
    setReindexing(file.id);
    try {
      const out = await reindexKnowledgeFile(file.id);
      onFilesChange(kbFiles.map((f) => (f.id === file.id ? { ...f, ...out } : f)));
      const label = indexLabel(out.embedding_status);
      if (label.tone === 'ok') toast.success(`${file.name}: ${label.text.toLowerCase()} (${out.embedding_chunks ?? 0} trechos).`);
      else toast.warning(`${file.name}: ${label.text.toLowerCase()}. Vale o modo atual.`);
    } catch (err) {
      toast.error(err instanceof AgentApiError ? err.message : 'Não foi possível reindexar o arquivo.');
    } finally {
      setReindexing(null);
    }
  }

  async function handleRemove(file: KnowledgeBaseFileItem) {
    if (!window.confirm(`Remover o arquivo "${file.name}" da base de conhecimento da conta?`)) return;
    setRemoving(file.id);
    try {
      await removeKnowledgeFile(file.id);
      onFilesChange(kbFiles.filter((f) => f.id !== file.id));
      if (selectedFileIds.has(file.id)) {
        onChange({ knowledge: { ...knowledge, file_ids: knowledge.file_ids.filter((id) => id !== file.id) } });
      }
      toast.success(`${file.name} removido.`);
    } catch (err) {
      toast.error(err instanceof AgentApiError ? err.message : 'Não foi possível remover o arquivo.');
    } finally {
      setRemoving(null);
    }
  }

  function handleModeChange(mode: 'legacy_account_all' | 'explicit') {
    onChange({
      knowledge: {
        ...knowledge,
        selection_mode: mode,
      },
    });
  }

  function handleFileToggle(fileId: string, checked: boolean) {
    const updatedIds = checked
      ? [...knowledge.file_ids, fileId]
      : knowledge.file_ids.filter((id) => id !== fileId);

    onChange({
      knowledge: {
        ...knowledge,
        file_ids: updatedIds,
      },
    });
  }

  function handleSelectAllFiles() {
    onChange({
      knowledge: {
        ...knowledge,
        file_ids: kbFiles.map((f) => f.id),
      },
    });
  }

  function handleDeselectAllFiles() {
    onChange({
      knowledge: {
        ...knowledge,
        file_ids: [],
      },
    });
  }

  const vector = knowledge.vector;
  function updateVector(patch: Partial<typeof vector>) {
    onChange({ knowledge: { ...knowledge, vector: { ...vector, ...patch } } });
  }

  function updateRag(patch: Partial<typeof rag>) {
    onChange({
      knowledge: {
        ...knowledge,
        rag_external: {
          ...rag,
          ...patch,
        },
      },
    });
  }

  // Extracts secret name if credential is in format {{cred.NAME}}
  const selectedSecretName = rag.credential?.startsWith('{{cred.') && rag.credential.endsWith('}}')
    ? rag.credential.slice(7, -2)
    : rag.credential;

  return (
    <div className="space-y-8">
      {/* 1. Base de Conhecimento Interna */}
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
            <Database className="size-4 text-primary" />
            Base de Conhecimento (Arquivos da Conta)
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Defina como o agente consulta os arquivos e documentos carregados na conta.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 max-w-2xl">
          <label
            className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-all ${
              knowledge.selection_mode === 'legacy_account_all'
                ? 'border-primary bg-primary/5 text-foreground'
                : 'border-border hover:bg-muted/30 text-muted-foreground'
            } ${readOnly ? 'pointer-events-none opacity-80' : ''}`}
          >
            <input
              type="radio"
              name="kb-mode"
              value="legacy_account_all"
              checked={knowledge.selection_mode === 'legacy_account_all'}
              onChange={() => handleModeChange('legacy_account_all')}
              disabled={readOnly}
              className="mt-0.5"
            />
            <div className="space-y-0.5">
              <span className="text-sm font-medium text-foreground">Todos os arquivos da conta</span>
              <p className="text-xs text-muted-foreground">
                O agente consulta dinamicamente todos os arquivos da base de conhecimento da conta.
              </p>
            </div>
          </label>

          <label
            className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-all ${
              knowledge.selection_mode === 'explicit'
                ? 'border-primary bg-primary/5 text-foreground'
                : 'border-border hover:bg-muted/30 text-muted-foreground'
            } ${readOnly ? 'pointer-events-none opacity-80' : ''}`}
          >
            <input
              type="radio"
              name="kb-mode"
              value="explicit"
              checked={knowledge.selection_mode === 'explicit'}
              onChange={() => handleModeChange('explicit')}
              disabled={readOnly}
              className="mt-0.5"
            />
            <div className="space-y-0.5">
              <span className="text-sm font-medium text-foreground">Arquivos escolhidos</span>
              <p className="text-xs text-muted-foreground">
                Selecione manualmente quais arquivos específicos este agente pode consultar.
              </p>
            </div>
          </label>
        </div>

        {/* Arquivos da conta: envio, uso do teto, vínculo (modo escolhido) e remoção */}
        <div className="rounded-lg border border-border bg-card p-4 space-y-3 max-w-2xl">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
              <Input
                value={fileFilter}
                onChange={(e) => setFileFilter(e.target.value)}
                placeholder="Filtrar arquivos..."
                className="pl-8 text-xs h-8"
              />
            </div>
            {!readOnly && (
              <div className="flex items-center gap-3">
                {explicit && kbFiles.length > 0 && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleSelectAllFiles}
                      className="text-xs text-primary hover:underline font-medium"
                    >
                      Marcar todos
                    </button>
                    <span className="text-muted-foreground text-xs">•</span>
                    <button
                      type="button"
                      onClick={handleDeselectAllFiles}
                      className="text-xs text-muted-foreground hover:underline"
                    >
                      Desmarcar todos
                    </button>
                  </div>
                )}
                <input ref={inputRef} type="file" accept={KB_ACCEPT} className="hidden" onChange={(e) => void handleUpload(e)} />
                <Button type="button" size="sm" onClick={() => inputRef.current?.click()} disabled={uploading}>
                  {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                  {uploading ? 'Extraindo texto…' : 'Enviar arquivo'}
                </Button>
              </div>
            )}
          </div>
          {!readOnly && (
            <p className="text-[11px] text-muted-foreground">
              {KB_ACCEPT_LABEL}, até {formatBytes(KB_MAX_FILE_BYTES)}. O texto é extraído no servidor; PDF digitalizado
              (imagem) ou protegido por senha não tem texto aproveitável.
              {explicit ? ' O arquivo enviado já fica marcado para este agente.' : ''}
            </p>
          )}

          {kbFiles.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">
              Nenhum arquivo cadastrado na base de conhecimento da conta.
            </p>
          ) : filteredFiles.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">
              Nenhum arquivo corresponde ao filtro de busca.
            </p>
          ) : (
            <div className="max-h-72 overflow-y-auto divide-y divide-border/40 pr-1">
              {filteredFiles.map((file) => {
                const isChecked = selectedFileIds.has(file.id);
                return (
                  <div key={file.id} className="flex items-center gap-2.5 py-1.5 px-2 rounded hover:bg-muted/40 text-xs">
                    {explicit && (
                      <Checkbox
                        id={`kb-file-${file.id}`}
                        checked={isChecked}
                        onCheckedChange={(checked) => handleFileToggle(file.id, !!checked)}
                        disabled={readOnly}
                        aria-label={`Usar ${file.name} neste agente`}
                      />
                    )}
                    <FileText className="size-3.5 text-muted-foreground shrink-0" />
                    <label htmlFor={explicit ? `kb-file-${file.id}` : undefined} className="min-w-0 flex-1 cursor-pointer">
                      <span className="block font-medium text-foreground truncate">{file.name}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {formatBytes(file.size_bytes)} ·{' '}
                        {file.char_count == null ? 'caracteres: —' : `${NUMBER.format(file.char_count)} caracteres`}
                        {vector.enabled && (
                          <span
                            className={
                              indexLabel(file.embedding_status).tone === 'ok'
                                ? 'text-emerald-600'
                                : indexLabel(file.embedding_status).tone === 'warn'
                                  ? 'text-amber-600'
                                  : undefined
                            }
                          >
                            {' · '}
                            {indexLabel(file.embedding_status).text}
                          </span>
                        )}
                      </span>
                    </label>
                    {explicit && isChecked && <Badge variant="secondary" className="text-[10px] py-0">Selecionado</Badge>}
                    {!readOnly && vector.enabled && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleReindex(file)}
                        disabled={reindexing === file.id}
                        aria-label={`Reindexar ${file.name}`}
                        title="Reindexar para a busca por trechos"
                      >
                        {reindexing === file.id ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                      </Button>
                    )}
                    {!readOnly && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleRemove(file)}
                        disabled={removing === file.id}
                        aria-label={`Remover ${file.name}`}
                      >
                        {removing === file.id ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="space-y-1.5 pt-2 border-t border-border">
            <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {explicit
                  ? `${knowledge.file_ids.length} de ${kbFiles.length} arquivos selecionados`
                  : `Todos os ${kbFiles.length} arquivos da conta`}
              </span>
              <span className={overLimit ? 'text-amber-600 font-medium' : undefined}>
                {NUMBER.format(usedChars)}
                {unknownChars ? '+' : ''} de {NUMBER.format(maxChars)} caracteres do teto ({usedPct}%)
              </span>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(usedPct, 100)}
              aria-label="Uso do teto de caracteres da base"
            >
              <div
                className={`h-full rounded-full ${overLimit ? 'bg-amber-500' : 'bg-primary'}`}
                style={{ width: `${Math.min(usedPct, 100)}%` }}
              />
            </div>
            {overLimit && (
              <p className="flex items-start gap-1.5 text-[11px] text-amber-600">
                <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
                Acima do teto: a cada resposta entram só os arquivos mais relevantes para a conversa, até o teto (o último
                pode ser cortado).
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Busca por trechos (RAG vetorial, TASK1-D) */}
      <div className="rounded-lg border border-border p-5 space-y-4 max-w-2xl bg-card">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              <Label htmlFor="kb-vector-toggle" className="text-sm font-medium cursor-pointer">
                Busca por trechos
              </Label>
              {vector.enabled && (
                <Badge variant="outline" className="text-[10px] text-primary border-primary/30">
                  Ligada
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              A cada mensagem, o agente recebe só os trechos dos arquivos mais parecidos com o que o cliente disse, em vez
              do conhecimento inteiro. Usa a chave de IA da conta (OpenAI) e só vale quando todos os arquivos do agente
              estão indexados; senão, sem chave ou em caso de erro, continua o modo atual (teto de caracteres).
            </p>
          </div>
          <Switch
            id="kb-vector-toggle"
            checked={vector.enabled}
            onCheckedChange={(checked) => updateVector({ enabled: checked })}
            disabled={readOnly}
          />
        </div>

        {vector.enabled && (
          <div className="grid grid-cols-2 gap-4 pt-2 border-t border-border animate-in fade-in-50 duration-150">
            <div className="space-y-1.5">
              <Label htmlFor="kb-vector-top-k" className="text-xs font-medium">
                Trechos por mensagem (top_k)
              </Label>
              <Input
                id="kb-vector-top-k"
                type="number"
                min={1}
                max={20}
                value={vector.top_k}
                onChange={(e) => updateVector({ top_k: Math.min(20, Math.max(1, Number.parseInt(e.target.value, 10) || 1)) })}
                disabled={readOnly}
                className="text-xs"
              />
              <p className="text-[11px] text-muted-foreground">Entre 1 e 20 (padrão: 6).</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kb-vector-min" className="text-xs font-medium">
                Similaridade mínima
              </Label>
              <Input
                id="kb-vector-min"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={vector.min_similarity}
                onChange={(e) => {
                  const v = Number.parseFloat(e.target.value);
                  updateVector({ min_similarity: Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0 });
                }}
                disabled={readOnly}
                className="text-xs"
              />
              <p className="text-[11px] text-muted-foreground">De 0 a 1 (padrão: 0,3). Nenhum trecho acima dela → modo atual.</p>
            </div>
          </div>
        )}
      </div>

      {/* 2. Bloco RAG Externo */}
      <div className="rounded-lg border border-border p-5 space-y-5 max-w-2xl bg-card">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <Globe className="size-4 text-primary" />
              <Label htmlFor="rag-external-toggle" className="text-sm font-medium cursor-pointer">
                RAG Externo Conectável
              </Label>
              {rag.enabled && (
                <Badge variant="outline" className="text-[10px] text-primary border-primary/30">
                  Conectado
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Integração HTTP para recuperação de contexto externo em tempo real. O agente consulta
              o endpoint fornecido antes de formular a resposta.
            </p>
          </div>
          <Switch
            id="rag-external-toggle"
            checked={rag.enabled}
            onCheckedChange={(checked) => updateRag({ enabled: checked })}
            disabled={readOnly}
          />
        </div>

        {rag.enabled && (
          <div className="space-y-4 pt-2 border-t border-border animate-in fade-in-50 duration-150">
            <div className="space-y-1.5">
              <Label htmlFor="rag-url" className="text-xs font-medium">
                URL da API (HTTPS) <span className="text-destructive">*</span>
              </Label>
              <Input
                id="rag-url"
                value={rag.url}
                onChange={(e) => updateRag({ url: e.target.value })}
                placeholder="https://rag.suaempresa.com.br/api/retrieve"
                disabled={readOnly}
                className="text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                Deve ser uma URL segura HTTPS sem credenciais no corpo da URL.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rag-credential" className="text-xs font-medium">
                Credencial de Autenticação <span className="text-destructive">*</span>
              </Label>
              {credentialSecrets.length === 0 ? (
                <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-600 dark:text-amber-400 flex items-start gap-2">
                  <AlertCircle className="size-4 shrink-0 mt-0.5" />
                  <div>
                    Nenhuma credencial cadastrada. Cadastre um token ou chave em{' '}
                    <strong>Configurações → Variáveis e credenciais</strong> para associar com segurança ao RAG.
                  </div>
                </div>
              ) : (
                <Select
                  value={selectedSecretName || ''}
                  onValueChange={(secretName) => updateRag({ credential: `{{cred.${secretName}}}` })}
                  disabled={readOnly}
                >
                  <SelectTrigger id="rag-credential" className="text-xs">
                    <SelectValue placeholder="Selecione a credencial cadastrada..." />
                  </SelectTrigger>
                  <SelectContent>
                    {credentialSecrets.map((sec) => (
                      <SelectItem key={sec.id} value={sec.name} className="text-xs">
                        <span className="font-mono font-medium">{sec.name}</span>
                        {sec.last4 && (
                          <span className="text-muted-foreground ml-2">(••••{sec.last4})</span>
                        )}
                        {sec.description && (
                          <span className="text-muted-foreground ml-2">— {sec.description}</span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-[11px] text-muted-foreground">
                O token é injetado pelo servidor com segurança usando marcador <code>{'{{cred.NOME}}'}</code>.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="rag-top-k" className="text-xs font-medium">
                  Documentos recuperados (top_k)
                </Label>
                <Input
                  id="rag-top-k"
                  type="number"
                  min={1}
                  max={50}
                  value={rag.top_k}
                  onChange={(e) => updateRag({ top_k: Number.parseInt(e.target.value, 10) || 5 })}
                  disabled={readOnly}
                  className="text-xs"
                />
                <p className="text-[11px] text-muted-foreground">Entre 1 e 50 documentos (padrão: 5).</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="rag-timeout" className="text-xs font-medium">
                  Tempo limite (timeout em ms)
                </Label>
                <Input
                  id="rag-timeout"
                  type="number"
                  min={500}
                  step={500}
                  value={rag.timeout_ms}
                  onChange={(e) => updateRag({ timeout_ms: Number.parseInt(e.target.value, 10) || 5000 })}
                  disabled={readOnly}
                  className="text-xs"
                />
                <p className="text-[11px] text-muted-foreground">Padrão: 5000ms (5 segundos).</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
