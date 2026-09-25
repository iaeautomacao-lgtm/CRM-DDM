"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getDisparadorScope } from "@/lib/disparador/scope";
import { 
  ShieldAlert, 
  Plus, 
  Trash2, 
  X,
  Search,
  CheckCircle2,
  AlertOctagon
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface BlacklistEntry {
  id: string;
  telefone: string;
  motivo: string;
  data_bloqueio: string;
  bloqueado_por?: string;
  mensagem_detectada?: string;
}

type BlacklistType = "opt_out" | "manual" | "meta_131026" | "automatic" | "unknown";

interface BlacklistClassification {
  type: BlacklistType;
  label: string;
  severity: "Forte" | "Preventivo" | "Indefinida";
  description: string;
}

const MOTIVO_LABELS: Record<string, string> = {
  opt_out: "Pediu para sair (Opt-out)",
  bloqueio_manual: "Bloqueio Manual",
  numero_invalido: "Número Inválido",
  reclamacao: "Reclamação de Spam",
  risco_juridico: "Risco Jurídico",
  resposta_negativa: "Resposta Negativa",
};

function classifyBlacklistEntry(entry: BlacklistEntry): BlacklistClassification {
  if (entry.mensagem_detectada?.trim() || entry.motivo === "opt_out") {
    return {
      type: "opt_out",
      label: "Opt-out",
      severity: "Forte",
      description: "Contato pediu para não receber mensagens",
    };
  }

  const motivo = entry.motivo.toLowerCase();
  if (motivo.includes("131026")) {
    return {
      type: "meta_131026",
      label: "Automático — Meta 131026",
      severity: "Preventivo",
      description: "Falha de entrega pela Meta neste envio",
    };
  }

  if (entry.bloqueado_por === "sistema") {
    return {
      type: "automatic",
      label: "Automático",
      severity: "Preventivo",
      description: "Bloqueio automático do sistema",
    };
  }

  if (entry.bloqueado_por?.trim() || entry.motivo === "bloqueio_manual") {
    return {
      type: "manual",
      label: "Manual",
      severity: "Forte",
      description: "Bloqueado manualmente por operador",
    };
  }

  return {
    type: "unknown",
    label: "Não informado",
    severity: "Indefinida",
    description: "Não foi possível determinar a origem",
  };
}

function severityClass(severity: BlacklistClassification["severity"]): string {
  if (severity === "Forte") return "bg-red-500/10 text-red-600 border-red-500/20";
  if (severity === "Preventivo") return "bg-amber-500/10 text-amber-600 border-amber-500/20";
  return "bg-zinc-500/10 text-zinc-600 border-zinc-500/20";
}

export default function BlacklistPage() {
  const [blacklist, setBlacklist] = useState<BlacklistEntry[]>([]);
  const [filteredList, setFilteredList] = useState<BlacklistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [originFilter, setOriginFilter] = useState<BlacklistType | "all">("all");
  // Resolvido em loadBlacklist() — mesmo padrão de campanhas/page.tsx
  // (getDisparadorScope). Necessário pra migration 040/085 (RLS do
  // Disparador) poder ser aplicada.
  const [accountId, setAccountId] = useState<string | null>(null);

  // Modal Form States
  const [showModal, setShowModal] = useState(false);
  const [telefone, setTelefone] = useState("");
  const [motivo, setMotivo] = useState("bloqueio_manual");
  const [mensagemDetectada, setMensagemDetectada] = useState("");

  useEffect(() => {
    loadBlacklist();
  }, []);

  const loadBlacklist = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const supabase = createClient();
      const { accountId: scopedAccountId } = await getDisparadorScope(supabase);
      setAccountId(scopedAccountId);

      const { data, error } = await supabase
        .from("blacklist")
        .select("*")
        .order("data_bloqueio", { ascending: false });

      if (error) throw error;
      setBlacklist(data ?? []);
      setFilteredList(data ?? []);
    } catch (err) {
      console.error("Failed to load blacklist:", err);
      setLoadError("Não foi possível carregar a blacklist. Tente novamente.");
    } finally {
      setLoading(false);
    }
  };

  // Filter List based on Search Query
  useEffect(() => {
    const query = search.trim().toLowerCase();
    setFilteredList(
      blacklist.filter((entry) => {
        const matchesSearch =
          !query ||
          entry.telefone.toLowerCase().includes(query) ||
          entry.mensagem_detectada?.toLowerCase().includes(query) ||
          entry.motivo.toLowerCase().includes(query);
        const matchesOrigin =
          originFilter === "all" || classifyBlacklistEntry(entry).type === originFilter;
        return Boolean(matchesSearch && matchesOrigin);
      })
    );
  }, [search, blacklist, originFilter]);

  const originFilters: Array<{ key: BlacklistType | "all"; label: string }> = [
    { key: "all", label: "Todos" },
    { key: "opt_out", label: "Opt-out" },
    { key: "manual", label: "Manual" },
    { key: "meta_131026", label: "Meta 131026" },
    { key: "automatic", label: "Automático" },
    { key: "unknown", label: "Não informado" },
  ];
  const originCounts = useMemo(() => {
    const counts: Record<BlacklistType, number> = {
      opt_out: 0,
      manual: 0,
      meta_131026: 0,
      automatic: 0,
      unknown: 0,
    };
    blacklist.forEach((entry) => {
      counts[classifyBlacklistEntry(entry).type] += 1;
    });
    return counts;
  }, [blacklist]);

  // Remove from Blacklist
  const handleRemove = async (id: string) => {
    const entry = blacklist.find((item) => item.id === id);
    const classification = entry ? classifyBlacklistEntry(entry) : null;
    const confirmation =
      classification?.type === "opt_out"
        ? "Este contato pediu para não receber mensagens. Remover este bloqueio pode causar envio indevido. Deseja continuar?"
        : "Tem certeza que deseja remover este número da blacklist? Ele voltará a receber disparos.";
    if (!confirm(confirmation)) return;
    try {
      const supabase = createClient();
      const { error } = await supabase.from("blacklist").delete().eq("id", id);
      if (error) throw error;
      toast.success("Número removido da blacklist!");
      loadBlacklist();
    } catch (err: any) {
      toast.error("Erro ao remover da blacklist.");
    }
  };

  // Add to Blacklist
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!telefone.trim()) {
      toast.error("Insira o número do telefone.");
      return;
    }
    if (!accountId) {
      toast.error("Conta não resolvida — recarregue a página e tente de novo.");
      return;
    }

    // Sanitize phone input
    let cleanPhone = telefone.replace(/\D/g, "");
    if (!cleanPhone.startsWith("+")) {
      cleanPhone = "+" + cleanPhone;
    }

    try {
      const supabase = createClient();
      const { error } = await supabase.from("blacklist").insert({
        telefone: cleanPhone,
        motivo,
        mensagem_detectada: mensagemDetectada || null,
        bloqueado_por: "Painel CRM",
        account_id: accountId,
      });

      if (error) {
        if (error.code === "23505") throw new Error("Este número já está na blacklist.");
        throw error;
      }

      toast.success("Número adicionado à blacklist!");
      setShowModal(false);
      setTelefone("");
      setMensagemDetectada("");
      loadBlacklist();
    } catch (err: any) {
      toast.error(err.message || "Erro ao adicionar à blacklist.");
    }
  };

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col space-y-4 p-4 lg:p-6 overflow-hidden">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 border-b border-border/40 pb-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/10 text-red-500">
              <ShieldAlert className="h-5 w-5" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              Blacklist de Números
            </h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Evite spam e bloqueios protegendo contatos que pediram opt-out ou são inválidos.
          </p>
        </div>
        <Button onClick={() => setShowModal(true)} variant="destructive" className="gap-1.5 self-start">
          <Plus className="h-4 w-4" /> Bloquear Número
        </Button>
      </div>

      {/* Search Input */}
      <div className="relative">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por telefone ou palavra bloqueada..."
          className="w-full rounded-md border border-input bg-background pl-9 pr-4 py-2 text-sm focus:outline-none"
        />
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {originFilters.map((filter) => {
            const count = filter.key === "all" ? blacklist.length : originCounts[filter.key];
            const active = originFilter === filter.key;
            return (
              <Button
                key={filter.key}
                type="button"
                size="sm"
                variant={active ? "secondary" : "outline"}
                onClick={() => setOriginFilter(filter.key)}
                className="gap-1.5"
              >
                {filter.label}
                <span className="text-[10px] text-muted-foreground">({count})</span>
              </Button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Bloqueios por opt-out e manuais são fortes. Falhas Meta 131026 são preventivas e indicam que a Meta não conseguiu entregar naquele envio.
        </p>
      </div>

      {/* Blacklist List */}
      <div className="flex-1 overflow-y-auto pr-2">
        {loading ? (
          <div className="flex h-48 items-center justify-center text-muted-foreground">
            Carregando blacklist...
          </div>
        ) : loadError ? (
          <div className="flex h-48 flex-col items-center justify-center text-center text-muted-foreground border border-dashed border-border rounded-xl">
            <AlertOctagon className="h-10 w-10 text-amber-500/50 mb-2" />
            <h4 className="font-semibold text-foreground">Não foi possível carregar a blacklist</h4>
            <p className="text-xs max-w-xs mt-1">Tente novamente.</p>
            <Button type="button" variant="outline" size="sm" className="mt-3" onClick={loadBlacklist}>
              Tentar novamente
            </Button>
          </div>
        ) : filteredList.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center text-center text-muted-foreground border border-dashed border-border rounded-xl">
            <CheckCircle2 className="h-10 w-10 text-emerald-500/30 mb-2" />
            <h4 className="font-semibold text-foreground">Sua blacklist está vazia</h4>
            <p className="text-xs max-w-xs mt-1">Nenhum número foi bloqueado ainda. Adicione contatos manualmente se necessário.</p>
          </div>
        ) : (
          <div className="border border-border rounded-xl bg-card overflow-hidden shadow-sm">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="border-b border-border bg-muted/30 text-muted-foreground font-semibold uppercase tracking-wider">
                <tr>
                  <th className="px-5 py-3.5">Telefone</th>
                  <th className="px-5 py-3.5">Motivo</th>
                  <th className="px-5 py-3.5">Origem</th>
                  <th className="px-5 py-3.5">Data do bloqueio</th>
                  <th className="px-5 py-3.5 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {filteredList.map((entry) => (
                  <tr key={entry.id} className="hover:bg-muted/10">
                    <td className="px-5 py-4 font-mono font-semibold text-foreground">{entry.telefone}</td>
                    <td className="px-5 py-4">
                      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-500 border border-red-500/15">
                        <AlertOctagon className="h-3 w-3" /> {MOTIVO_LABELS[entry.motivo] || entry.motivo}
                      </span>
                    </td>
                    <td className="px-5 py-4 max-w-xs">
                      {(() => {
                        const classification = classifyBlacklistEntry(entry);
                        return (
                          <div className="space-y-1">
                            <div className="font-medium text-foreground">{classification.label}</div>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className={`inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${severityClass(classification.severity)}`}>
                                {classification.severity}
                              </span>
                              <span className="text-[10px] text-muted-foreground">
                                {classification.description}
                              </span>
                            </div>
                            {classification.type === "opt_out" && entry.mensagem_detectada && (
                              <p className="truncate text-[10px] italic text-muted-foreground">
                                “{entry.mensagem_detectada}”
                              </p>
                            )}
                          </div>
                        );
                      })()}
                    </td>
                    <td className="px-5 py-4 text-muted-foreground">
                      {new Date(entry.data_bloqueio).toLocaleString()}
                    </td>
                    <td className="px-5 py-4 text-right">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => handleRemove(entry.id)}
                        className="h-8 w-8 text-muted-foreground hover:text-red-500 hover:bg-red-500/10"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Creation Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-card border border-border w-full max-w-md rounded-xl shadow-2xl flex flex-col overflow-hidden">
            <header className="px-6 py-4 border-b border-border flex justify-between items-center bg-muted/20">
              <h3 className="font-bold text-foreground">Adicionar à Blacklist</h3>
              <Button size="icon" variant="ghost" onClick={() => setShowModal(false)} className="h-8 w-8 text-muted-foreground">
                <X className="h-5 w-5" />
              </Button>
            </header>

            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground font-semibold">Telefone do Contato</label>
                <input
                  type="text"
                  value={telefone}
                  onChange={(e) => setTelefone(e.target.value)}
                  placeholder="Ex: 5521999999999"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none"
                />
                <p className="text-[10px] text-muted-foreground">Insira o código do país + DDD + Número.</p>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground font-semibold">Motivo</label>
                <select
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none"
                >
                  {Object.entries(MOTIVO_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground font-semibold">Mensagem Opcional (Opt-out recebido)</label>
                <textarea
                  value={mensagemDetectada}
                  onChange={(e) => setMensagemDetectada(e.target.value)}
                  placeholder="Ex: 'Não quero mais receber mensagens'"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none resize-none h-16"
                />
              </div>

              <footer className="pt-4 border-t border-border flex justify-end gap-3 -mx-6 -mb-6 p-6 bg-muted/10">
                <Button type="button" variant="outline" onClick={() => setShowModal(false)}>Cancelar</Button>
                <Button type="submit" variant="destructive">Bloquear</Button>
              </footer>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
