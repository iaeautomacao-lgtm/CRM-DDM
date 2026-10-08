import { useState } from 'react';
import { Database, FileText, Globe, Search, AlertCircle } from 'lucide-react';
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
  secrets: SecretItem[];
  readOnly?: boolean;
}

export function KnowledgeTab({
  data,
  onChange,
  kbFiles,
  secrets,
  readOnly,
}: KnowledgeTabProps) {
  const [fileFilter, setFileFilter] = useState('');

  const knowledge = data.knowledge;
  const rag = knowledge.rag_external;
  const credentialSecrets = secrets.filter((s) => s.kind === 'credential');

  const selectedFileIds = new Set(knowledge.file_ids);

  const filteredFiles = kbFiles.filter((f) =>
    f.name.toLowerCase().includes(fileFilter.toLowerCase()),
  );

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

        {/* Lista de seleção manual de arquivos */}
        {knowledge.selection_mode === 'explicit' && (
          <div className="rounded-lg border border-border bg-card p-4 space-y-3 max-w-2xl">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="relative flex-1 max-w-sm">
                <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
                <Input
                  value={fileFilter}
                  onChange={(e) => setFileFilter(e.target.value)}
                  placeholder="Filtrar arquivos..."
                  className="pl-8 text-xs h-8"
                  disabled={readOnly}
                />
              </div>

              {!readOnly && kbFiles.length > 0 && (
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
            </div>

            {kbFiles.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">
                Nenhum arquivo cadastrado na base de conhecimento da conta.
              </p>
            ) : filteredFiles.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">
                Nenhum arquivo corresponde ao filtro de busca.
              </p>
            ) : (
              <div className="max-h-56 overflow-y-auto space-y-1.5 divide-y divide-border/40 pr-1">
                {filteredFiles.map((file) => {
                  const isChecked = selectedFileIds.has(file.id);
                  return (
                    <label
                      key={file.id}
                      className="flex items-center gap-2.5 py-1.5 px-2 rounded hover:bg-muted/40 cursor-pointer text-xs"
                    >
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={(checked) => handleFileToggle(file.id, !!checked)}
                        disabled={readOnly}
                      />
                      <FileText className="size-3.5 text-muted-foreground shrink-0" />
                      <span className="flex-1 font-medium text-foreground truncate">{file.name}</span>
                      {isChecked && <Badge variant="secondary" className="text-[10px] py-0">Selecionado</Badge>}
                    </label>
                  );
                })}
              </div>
            )}

            <div className="text-xs text-muted-foreground pt-1 border-t border-border flex justify-between">
              <span>{knowledge.file_ids.length} de {kbFiles.length} arquivos selecionados</span>
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
