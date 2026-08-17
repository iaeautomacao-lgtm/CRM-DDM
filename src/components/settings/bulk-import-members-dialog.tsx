'use client';

// ============================================================
// BulkImportMembersDialog
//
// Upload a CSV/XLSX with columns nome/email/role (role optional,
// defaults to "operador"/agent) + a shared default password, and
// create one account member per row via
// POST /api/account/members/bulk-invite.
//
// Parsing happens entirely client-side (papaparse for .csv, xlsx
// for .xlsx/.xls) — the API contract is a plain JSON
// { members: [{name, email, role}], password } payload, not a
// file upload, so the server route stays focused on validation +
// user creation rather than spreadsheet parsing.
// ============================================================

import { useRef, useState } from 'react';
import * as Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle,
  Download,
  Eye,
  EyeOff,
  FileText,
  Loader2,
  Upload,
  XCircle,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { ROLE_META } from './role-meta';

const TEMPLATE_CSV =
  'nome,email,role\nMaria Silva,maria.silva@empresa.com,operador\nJoão Souza,joao.souza@empresa.com,administrador\n';

const MIN_PASSWORD_LENGTH = 6;
const MAX_ROWS = 200;

// Client-side mirror of the server's alias map (bulk-invite/route.ts) —
// used only to render a friendly role badge in the preview. The server
// re-validates everything; this is just so the preview doesn't show a
// raw "operador" string next to properly-cased chips.
const ROLE_ALIASES: Record<string, 'admin' | 'agent' | 'viewer'> = {
  admin: 'admin',
  administrador: 'admin',
  agent: 'agent',
  operador: 'agent',
  viewer: 'viewer',
  visualizador: 'viewer',
};

interface ParsedRow {
  name: string;
  email: string;
  role: string;
  /** True when this email already belongs to an existing account
   *  member. Purely informational (see the "Já existe" badge) — it
   *  does NOT remove the row or block the import. */
  existsInAccount?: boolean;
}

/**
 * Drops rows whose email repeats earlier in the sheet, keeping the
 * first occurrence. Rows with no email at all are never deduped
 * against each other (nothing to key on) — they're left for the
 * server-side validation that already handles missing emails.
 */
function dedupeRowsByEmail(rows: ParsedRow[]): { rows: ParsedRow[]; removed: number } {
  const seen = new Set<string>();
  const deduped: ParsedRow[] = [];
  let removed = 0;
  for (const row of rows) {
    const key = row.email.trim().toLowerCase();
    if (key) {
      if (seen.has(key)) {
        removed++;
        continue;
      }
      seen.add(key);
    }
    deduped.push(row);
  }
  return { rows: deduped, removed };
}

/** Emails of every existing account member, normalized for lookup.
 *  Fails open (empty set) on any error — this check is advisory only,
 *  so a failed fetch should never block the preview from rendering. */
async function fetchExistingMemberEmails(): Promise<Set<string>> {
  try {
    const res = await fetch('/api/account/members', { cache: 'no-store' });
    if (!res.ok) return new Set();
    const data = await res.json().catch(() => null) as { members?: { email: string | null }[] } | null;
    const emails = (data?.members ?? [])
      .map((m) => m.email?.trim().toLowerCase())
      .filter((email): email is string => !!email);
    return new Set(emails);
  } catch (err) {
    console.error('[BulkImportMembersDialog] fetchExistingMemberEmails error:', err);
    return new Set();
  }
}

interface BulkImportResult {
  imported: number;
  errors: { email: string; reason: string }[];
}

function getField(
  row: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  const normalized: Record<string, unknown> = {};
  for (const rawKey of Object.keys(row)) {
    normalized[rawKey.trim().toLowerCase()] = row[rawKey];
  }
  for (const key of keys) {
    const value = normalized[key.toLowerCase()];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return undefined;
}

function roleBadgeLabel(role: string): string {
  const key = ROLE_ALIASES[role.trim().toLowerCase()];
  return key ? ROLE_META[key].label : 'Papel inválido';
}

interface BulkImportMembersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful import so the parent re-fetches the roster. */
  onImported: () => void;
}

export function BulkImportMembersDialog({
  open,
  onOpenChange,
  onImported,
}: BulkImportMembersDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [internalDuplicateCount, setInternalDuplicateCount] = useState(0);
  const [existingDuplicateCount, setExistingDuplicateCount] = useState(0);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<BulkImportResult | null>(null);

  function reset() {
    setFile(null);
    setRows([]);
    setInternalDuplicateCount(0);
    setExistingDuplicateCount(0);
    setPassword('');
    setShowPassword(false);
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function downloadTemplate() {
    const blob = new Blob([TEMPLATE_CSV], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'modelo-importacao-membros.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;

    setFile(selected);
    setResult(null);
    setInternalDuplicateCount(0);
    setExistingDuplicateCount(0);

    const filename = selected.name.toLowerCase();
    let rawRows: Record<string, unknown>[] = [];

    try {
      if (filename.endsWith('.csv')) {
        const text = (await selected.text()).replace(/^﻿/, '');
        const parsed = Papa.parse<Record<string, unknown>>(text, {
          header: true,
          skipEmptyLines: true,
          delimiter: '',
        });
        rawRows = parsed.data;
      } else if (filename.endsWith('.xlsx') || filename.endsWith('.xls')) {
        const buffer = await selected.arrayBuffer();
        const workbook = XLSX.read(buffer, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        rawRows = XLSX.utils.sheet_to_json(sheet);
      } else {
        toast.error('Formato de arquivo inválido. Envie um CSV ou XLSX.');
        setRows([]);
        return;
      }
    } catch (err) {
      console.error('[BulkImportMembersDialog] parse error:', err);
      toast.error('Não foi possível ler o arquivo.');
      setRows([]);
      return;
    }

    const parsedRows: ParsedRow[] = rawRows
      .map((row) => ({
        name: getField(row, 'nome', 'name') || '',
        email: getField(row, 'email', 'e-mail') || '',
        role: getField(row, 'role', 'papel', 'função', 'funcao') || 'agent',
      }))
      .filter((row) => row.name || row.email);

    if (parsedRows.length === 0) {
      toast.error(
        'Nenhuma linha válida encontrada. Certifique-se de que o arquivo possui as colunas "nome" e "email".',
      );
      setRows([]);
      return;
    }

    const { rows: dedupedRows, removed: internalDuplicates } = dedupeRowsByEmail(parsedRows);

    if (dedupedRows.length > MAX_ROWS) {
      toast.error(`Este arquivo tem mais de ${MAX_ROWS} linhas — o limite por importação.`);
      setRows([]);
      return;
    }

    const existingEmails = await fetchExistingMemberEmails();
    const finalRows: ParsedRow[] = dedupedRows.map((row) => ({
      ...row,
      existsInAccount: row.email ? existingEmails.has(row.email.trim().toLowerCase()) : false,
    }));

    setInternalDuplicateCount(internalDuplicates);
    setExistingDuplicateCount(finalRows.filter((row) => row.existsInAccount).length);
    setRows(finalRows);
  }

  async function handleImport() {
    if (rows.length === 0) return;
    if (password.length < MIN_PASSWORD_LENGTH) {
      toast.error(`A senha deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres`);
      return;
    }

    setImporting(true);
    try {
      const res = await fetch('/api/account/members/bulk-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ members: rows, password }),
      });

      const payload = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast.error(payload.error || 'Falha ao importar membros');
        return;
      }

      const imported = payload.imported ?? 0;
      const errors = payload.errors ?? [];
      setResult({ imported, errors });

      if (imported > 0) {
        toast.success(
          `${imported} membro${imported !== 1 ? 's' : ''} importado${imported !== 1 ? 's' : ''}`,
        );
        onImported();
      }
      if (errors.length > 0) {
        toast.error(
          `${errors.length} linha${errors.length !== 1 ? 's' : ''} não pôde${errors.length !== 1 ? 'ram' : ''} ser importada${errors.length !== 1 ? 's' : ''}`,
        );
      }
    } catch (err) {
      console.error('[BulkImportMembersDialog] import error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,720px)] flex-col gap-0 overflow-hidden bg-popover border-border p-0 text-popover-foreground sm:max-w-2xl">
        <div className="shrink-0 space-y-4 border-b border-border px-6 pt-6 pb-5">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-lg text-popover-foreground">
              Importar membros
            </DialogTitle>
            <DialogDescription className="leading-relaxed text-muted-foreground">
              Envie um CSV ou XLSX com as colunas{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
                nome
              </code>
              ,{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
                email
              </code>{' '}
              e, opcionalmente,{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
                role
              </code>{' '}
              (administrador, operador ou visualizador — padrão: operador).
              Cada linha recebe um login com a senha padrão abaixo.
            </DialogDescription>
          </DialogHeader>

          <Button
            type="button"
            variant="outline"
            onClick={downloadTemplate}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            <Download className="size-4" />
            Baixar modelo
          </Button>

          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
            }}
            className={cn(
              'group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-5 transition-all',
              file
                ? 'border-primary/35 bg-primary/[0.04]'
                : 'hover:border-primary/40 border-border bg-background/40 hover:bg-background/70',
            )}
          >
            {file ? (
              <>
                <div className="bg-primary/15 ring-primary/25 flex size-10 items-center justify-center rounded-lg ring-1">
                  <FileText className="text-primary size-5" />
                </div>
                <p className="max-w-full truncate px-2 text-sm font-medium text-popover-foreground" title={file.name}>
                  {file.name}
                </p>
                <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {rows.length} linha{rows.length !== 1 ? 's' : ''} prontas
                </span>
              </>
            ) : (
              <>
                <div className="flex size-10 items-center justify-center rounded-lg bg-muted/80 ring-1 ring-border transition-colors group-hover:bg-muted">
                  <Upload className="size-5 text-muted-foreground group-hover:text-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  Clique para escolher um arquivo CSV ou XLSX
                </p>
              </>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={handleFileChange}
            className="hidden"
          />

          <div className="space-y-2">
            <Label className="text-muted-foreground">Senha padrão</Label>
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={`Mínimo ${MIN_PASSWORD_LENGTH} caracteres`}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-9"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Todos os usuários importados recebem esta senha inicial.
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {rows.length > 0 && !result && (
            <div className="overflow-hidden rounded-xl border border-border ring-1 ring-border/50">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[28rem] text-xs">
                  <thead>
                    <tr className="border-b border-border bg-background/60">
                      <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                        Nome
                      </th>
                      <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                        E-mail
                      </th>
                      <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                        Papel
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/70">
                    {rows.map((row, i) => (
                      <tr key={i} className="bg-popover/40 transition-colors hover:bg-muted/30">
                        <td className="px-3 py-2 text-popover-foreground">{row.name || '—'}</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          <span className="inline-flex items-center gap-1.5">
                            {row.email || '—'}
                            {row.existsInAccount && (
                              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-amber-400">
                                Já existe
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{roleBadgeLabel(row.role)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {(internalDuplicateCount > 0 || existingDuplicateCount > 0) && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border bg-background/40 px-3 py-2 text-xs text-muted-foreground">
                  {internalDuplicateCount > 0 && (
                    <span>
                      {internalDuplicateCount} duplicata{internalDuplicateCount !== 1 ? 's' : ''} removida
                      {internalDuplicateCount !== 1 ? 's' : ''}
                    </span>
                  )}
                  {existingDuplicateCount > 0 && (
                    <span>
                      {existingDuplicateCount} membro{existingDuplicateCount !== 1 ? 's' : ''} já cadastrado
                      {existingDuplicateCount !== 1 ? 's' : ''} ignorado{existingDuplicateCount !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {result && (
            <div className="space-y-3">
              <div className="rounded-xl border border-border bg-background/50 p-4">
                <p className="text-sm font-medium text-popover-foreground">Importação concluída</p>
                <div className="mt-3 flex flex-wrap gap-3">
                  {result.imported > 0 && (
                    <div className="text-primary flex items-center gap-1.5 text-sm">
                      <CheckCircle className="size-4 shrink-0" />
                      {result.imported} importado{result.imported !== 1 ? 's' : ''}
                    </div>
                  )}
                  {result.errors.length > 0 && (
                    <div className="flex items-center gap-1.5 text-sm text-red-400">
                      <XCircle className="size-4 shrink-0" />
                      {result.errors.length} falhou{result.errors.length !== 1 ? 'ram' : ''}
                    </div>
                  )}
                </div>
              </div>

              {result.errors.length > 0 && (
                <div className="overflow-hidden rounded-xl border border-amber-500/40">
                  <ul className="divide-y divide-amber-500/20">
                    {result.errors.map((err, i) => (
                      <li key={i} className="flex items-start gap-2 bg-amber-500/[0.06] px-3 py-2 text-xs">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
                        <span className="text-popover-foreground">
                          <span className="font-medium">{err.email}</span>
                          {' — '}
                          <span className="text-muted-foreground">{err.reason}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="mt-0 shrink-0 gap-2 border-t border-border bg-background/50 px-6 py-4 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {result ? 'Fechar' : 'Cancelar'}
          </Button>
          {!result && (
            <Button
              type="button"
              disabled={rows.length === 0 || importing}
              onClick={handleImport}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {importing && <Loader2 className="size-4 animate-spin" />}
              Importar {rows.length > 0 ? rows.length : ''} membro{rows.length !== 1 ? 's' : ''}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
