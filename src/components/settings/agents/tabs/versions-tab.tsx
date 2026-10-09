'use client';

import { useState } from 'react';
import { History, Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { AgentVersionSummary } from '../types';

interface VersionsTabProps {
  versions: AgentVersionSummary[];
  publishedVersionId?: string;
  onRestore: (versionId: string) => Promise<void>;
  readOnly?: boolean;
  busy?: boolean;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function VersionsTab({ versions, publishedVersionId, onRestore, readOnly, busy }: VersionsTabProps) {
  const [pending, setPending] = useState<AgentVersionSummary | null>(null);

  return (
    <div className="space-y-4">
      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restaurar versão</AlertDialogTitle>
            <AlertDialogDescription>
              {`Restaurar a versão ${pending?.version ?? ''}? Isso publica uma nova versão com este conteúdo. Conversas em andamento continuam na versão anterior.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = pending;
                setPending(null);
                if (target) void onRestore(target.id);
              }}
            >
              Restaurar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div>
        <h3 className="text-sm font-medium text-foreground">Histórico de versões</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Cada salvamento publica uma nova versão imutável. Restaurar cria uma nova versão com o conteúdo da escolhida.
        </p>
      </div>

      {versions.length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-border p-8 text-center space-y-2">
          <History className="size-5 mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Nenhuma versão publicada ainda.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {versions.map((v) => {
            const current = v.id === publishedVersionId;
            return (
              <li key={v.id} className="flex flex-wrap items-center gap-3 rounded-[10px] border border-border bg-card p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">v{v.version}</span>
                    {current && <Badge>Publicada</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formatDate(v.created_at)}
                    {v.created_by_name ? ` · ${v.created_by_name}` : ''}
                  </p>
                </div>
                {!readOnly && !current && (
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setPending(v)}>
                    {busy && <Loader2 className="size-3.5 mr-1.5 animate-spin" />}
                    Restaurar esta versão
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
