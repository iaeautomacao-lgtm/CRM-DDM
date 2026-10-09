"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Cadastro de Clientes (wacrm.clients, migration 128). Cada linha
// (WhatsApp, Instagram, Messenger) aponta para um cliente; as conversas
// herdam o cliente da linha e o inbox mostra o selo e filtra por ele.
// Escrita direta pelo Supabase: a RLS exige admin para gravar.

export interface ClientOption {
  id: string;
  name: string;
  color: string;
}

export function ClientsDialog({
  accountId,
  clients,
  open,
  onOpenChange,
  onChanged,
}: {
  accountId: string | null;
  clients: ClientOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#6366f1");
  const [busy, setBusy] = useState(false);

  async function addClient() {
    // busy: o Enter não respeitava o botão desabilitado e criava o cliente em dobro.
    if (busy || !accountId || !name.trim()) return;
    setBusy(true);
    const { error } = await createClient()
      .from("clients")
      .insert({ account_id: accountId, name: name.trim(), color });
    setBusy(false);
    if (error) {
      toast.error(error.code === "23505" ? "Já existe um cliente com esse nome" : "Falha ao criar cliente");
      return;
    }
    setName("");
    onChanged();
  }

  async function updateClient(id: string, patch: Partial<Pick<ClientOption, "name" | "color">>) {
    const { error } = await createClient().from("clients").update(patch).eq("id", id);
    if (error) toast.error("Falha ao atualizar cliente");
    else onChanged();
  }

  async function removeClient(id: string) {
    // Linhas e conversas do cliente ficam sem cliente (FK ON DELETE SET NULL).
    const { error } = await createClient().from("clients").delete().eq("id", id);
    if (error) toast.error("Falha ao remover cliente");
    else onChanged();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Clientes</DialogTitle>
          <DialogDescription>
            Cada número, Instagram ou página pertence a um cliente. As conversas mostram o
            cliente da linha por onde chegaram.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {clients.length === 0 && (
            <p className="text-sm text-muted-foreground">Nenhum cliente cadastrado.</p>
          )}
          {clients.map((c) => (
            <div key={c.id} className="flex items-center gap-2">
              <input
                type="color"
                defaultValue={c.color}
                // Grava ao fechar o seletor (onChange de input color dispara a cada movimento do arraste).
                onBlur={(e) => {
                  if (e.target.value !== c.color) void updateClient(c.id, { color: e.target.value });
                }}
                className="h-8 w-8 shrink-0 cursor-pointer rounded border border-border bg-transparent"
                aria-label={`Cor de ${c.name}`}
              />
              <Input
                defaultValue={c.name}
                aria-label={`Nome de ${c.name}`}
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next && next !== c.name) void updateClient(c.id, { name: next });
                }}
                className="h-8"
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-danger"
                onClick={() => removeClient(c.id)}
                aria-label={`Remover ${c.name}`}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 border-t border-border pt-3">
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-8 w-8 shrink-0 cursor-pointer rounded border border-border bg-transparent"
            aria-label="Cor do novo cliente"
          />
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addClient()}
            aria-label="Nome do novo cliente"
            placeholder="Nome do cliente"
            maxLength={80}
            className="h-8"
          />
          <Button size="sm" onClick={addClient} disabled={busy || !name.trim()}>
            Adicionar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
