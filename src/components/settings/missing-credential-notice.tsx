'use client';

// Aviso "Credencial NOME não existe" com o botão "Criar agora": abre o mesmo diálogo de Variáveis e
// credenciais ali mesmo, e ao salvar devolve a credencial (sem recarregar a página). Quem não tem
// secrets.write (só admin/proprietário) vê "Peça a um administrador". O valor nunca é lido de volta.

import { useState } from 'react';
import { AlertCircle } from 'lucide-react';

import { usePermission } from '@/hooks/use-permission';
import { Button } from '@/components/ui/button';
import { SecretDialog, type SecretItem } from './secret-dialog';

export function MissingCredentialNotice({
  names,
  onCreated,
}: {
  /** Nomes referenciados que não existem. Vazio = nada a mostrar. */
  names: string[];
  onCreated: (saved: SecretItem) => void;
}) {
  const canCreate = usePermission('secrets.write');
  const [creating, setCreating] = useState<string | null>(null);

  if (names.length === 0) return null;

  return (
    <>
      <div role="alert" className="flex flex-col gap-1.5">
        {names.map((name) => (
          <div
            key={name}
            className="flex flex-wrap items-center gap-2 rounded-md border border-warning-border bg-warning-soft p-2.5 text-xs text-warning"
          >
            <AlertCircle className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              Credencial <code className="font-mono font-semibold">{name}</code> não existe.
              {!canCreate && ' Peça a um administrador.'}
            </span>
            {canCreate && (
              <Button type="button" size="sm" variant="outline" onClick={() => setCreating(name)}>
                Criar agora
              </Button>
            )}
          </div>
        ))}
      </div>
      {creating !== null && (
        <SecretDialog
          item={null}
          presetName={creating}
          presetKind="credential"
          onClose={() => setCreating(null)}
          onSaved={(saved) => {
            setCreating(null);
            onCreated(saved);
          }}
        />
      )}
    </>
  );
}
