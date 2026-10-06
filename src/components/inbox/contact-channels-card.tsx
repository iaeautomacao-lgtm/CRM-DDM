"use client";

// Card "Canais" do painel do contato: as identidades do cliente em cada
// canal (contact_identities — Instagram, Messenger, Webchat) e, para quem
// chegou sem telefone, o formulário para vincular telefone/e-mail. Se o
// telefone ou e-mail já for de outro contato, a rota une os dois (mesma
// pessoa no WhatsApp e no Instagram = um contato só).

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Link2, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Contact } from "@/types";

interface Identity {
  id: string;
  channel_type: string;
  external_id: string;
  username: string | null;
  display_name: string | null;
}

const CHANNEL_LABEL: Record<string, string> = {
  instagram: "Instagram",
  messenger: "Messenger",
  webchat: "Webchat",
  sms: "SMS",
};

export function ContactChannelsCard({
  contact,
  canEdit,
  onLinked,
}: {
  contact: Contact;
  canEdit: boolean;
  /** `merged`: o contato atual deixou de existir e virou `result`. */
  onLinked: (result: Contact, merged: boolean) => void;
}) {
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    createClient()
      .from("contact_identities")
      .select("id, channel_type, external_id, username, display_name")
      .eq("contact_id", contact.id)
      .order("created_at")
      .then(({ data }) => {
        if (!cancelled) setIdentities((data ?? []) as Identity[]);
      });
    return () => {
      cancelled = true;
    };
  }, [contact.id]);

  const needsLink = !contact.phone || !contact.email;
  if (identities.length === 0 && !(canEdit && needsLink && !contact.phone)) return null;

  async function handleLink() {
    if (!phone.trim() && !email.trim()) return;
    setSaving(true);
    try {
      const res = await apiFetch(`/api/contacts/${contact.id}/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.trim() || undefined, email: email.trim() || undefined }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.contact) throw new Error(json.error ?? `HTTP ${res.status}`);
      toast.success(json.merged ? "Contato unido ao existente" : "Contato atualizado");
      setPhone("");
      setEmail("");
      onLinked(json.contact as Contact, !!json.merged);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao vincular");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1 text-sm font-medium text-foreground">
        <Link2 className="h-3 w-3" />
        Canais
      </div>
      {identities.length > 0 && (
        <ul className="space-y-1 px-1">
          {identities.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium text-foreground">{CHANNEL_LABEL[i.channel_type] ?? i.channel_type}</span>
              <span className="truncate text-muted-foreground">
                {i.username ? `@${i.username}` : i.display_name ?? i.external_id}
              </span>
            </li>
          ))}
        </ul>
      )}
      {/* Só para quem ainda não tem telefone: é aí que mora a duplicata. */}
      {canEdit && !contact.phone && (
        <div className="space-y-1.5 rounded-lg border border-dashed border-border p-2">
          <p className="text-xs text-muted-foreground">
            Vincule telefone ou e-mail. Se já existir um contato com ele, os dois viram um só.
          </p>
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Telefone com DDI (5511…)"
            aria-label="Telefone com DDI"
            inputMode="tel"
            className="h-8 text-xs"
          />
          {!contact.email && (
            <Input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="E-mail"
              aria-label="E-mail"
              type="email"
              className="h-8 text-xs"
            />
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 w-full text-xs"
            onClick={handleLink}
            disabled={saving || (!phone.trim() && !email.trim())}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Vincular"}
          </Button>
        </div>
      )}
    </div>
  );
}
