"use client";

// /disparador/blacklist — visual do redesenho DDM: grupos de origem como faixa clicável, refinamento
// segmentado, tabela densa e diálogos do design system. Regras de classificação e de bloqueio inalteradas.

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getDisparadorScope } from "@/lib/disparador/scope";
import { Plus, Trash2, Search, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { KpiStrip } from "@/components/ddm/kpi-strip";
import { PageBody, PageToolbar } from "@/components/ddm/page-toolbar";
import { Segmented } from "@/components/ddm/segmented";
import { StatusChip, type StatusTone } from "@/components/ddm/status-chip";
import { DenseTable, TableCard, Td, Th, Tr } from "@/components/ddm/table-card";
import { EmptyState, ErrorState, Skeleton } from "@/components/ddm/states";
import { toast } from "sonner";
import { formatBrazilianPhone } from "@/lib/disparador/phone-key";

interface BlacklistEntry {
  id: string;
  telefone: string;
  motivo: string;
  data_bloqueio: string;
  bloqueado_por?: string;
  mensagem_detectada?: string;
}

type BlacklistType = "opt_out" | "manual" | "meta_131026" | "automatic" | "unknown";
type BlacklistGroup = "all" | "human" | "meta" | "system";

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
      severity: "Forte",
      description: "131026 confirmado em 3 campanhas diferentes",
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

const SEVERITY_TONE: Record<BlacklistClassification["severity"], StatusTone> = {
  Forte: "bad",
  Preventivo: "warn",
  Indefinida: "mute",
};


function groupForClassification(classification: BlacklistClassification): Exclude<BlacklistGroup, "all"> {
  if (classification.type === "opt_out" || classification.type === "manual") return "human";
  if (classification.type === "meta_131026") return "meta";
  return "system";
}

export default function BlacklistPage() {
  const [blacklist, setBlacklist] = useState<BlacklistEntry[]>([]);
  const [filteredList, setFilteredList] = useState<BlacklistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState<BlacklistGroup>("all");
  const [originFilter, setOriginFilter] = useState<BlacklistType | "all">("all");
  // Resolvido em loadBlacklist() — mesmo padrão de campanhas/page.tsx
  // (getDisparadorScope). Necessário pra migration 040/085 (RLS do
  // Disparador) poder ser aplicada.
  const [accountId, setAccountId] = useState<string | null>(null);

  // Modal Form States
  const [showModal, setShowModal] = useState(false);
  const [telefone, setTelefone] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
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

      const pageSize = 1000;
      const allRows: BlacklistEntry[] = [];
      for (let from = 0; ; from += pageSize) {
        const { data, error } = await supabase
          .from("blacklist")
          .select("*")
          .eq("account_id", scopedAccountId)
          .order("data_bloqueio", { ascending: false })
          .range(from, from + pageSize - 1);
        if (error) throw error;
        allRows.push(...((data ?? []) as BlacklistEntry[]));
        if (!data || data.length < pageSize) break;
      }
      setBlacklist(allRows);
      setFilteredList(allRows);
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
        const classification = classifyBlacklistEntry(entry);
        const matchesGroup =
          groupFilter === "all" || groupForClassification(classification) === groupFilter;
        const matchesOrigin =
          originFilter === "all" || classification.type === originFilter;
        return Boolean(matchesSearch && matchesGroup && matchesOrigin);
      })
    );
  }, [search, blacklist, groupFilter, originFilter]);

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

  const groupCounts = useMemo(
    () => ({
      all: blacklist.length,
      human: originCounts.opt_out + originCounts.manual,
      meta: originCounts.meta_131026,
      system: originCounts.automatic + originCounts.unknown,
    }),
    [blacklist.length, originCounts],
  );

  const groupFilters: Array<{ key: BlacklistGroup; label: string; description: string }> = [
    { key: "all", label: "Todos", description: "Toda a blacklist" },
    { key: "human", label: "Solicitações / Humano", description: "Opt-out e bloqueios manuais" },
    { key: "meta", label: "Erros Meta", description: "Falhas técnicas confirmadas" },
    { key: "system", label: "Sistema / Outros", description: "Automáticos não Meta" },
  ];

  const visibleOriginFilters: Array<{ key: BlacklistType | "all"; label: string }> =
    groupFilter === "human"
      ? [
          { key: "all", label: "Todos humanos" },
          { key: "opt_out", label: "Opt-out" },
          { key: "manual", label: "Manual" },
        ]
      : groupFilter === "meta"
        ? [
            { key: "all", label: "Todos Meta" },
            { key: "meta_131026", label: "Meta 131026" },
          ]
        : groupFilter === "system"
          ? [
              { key: "all", label: "Todos do sistema" },
              { key: "automatic", label: "Automático" },
              { key: "unknown", label: "Não informado" },
            ]
          : [];


  // Remove from Blacklist — confirmação num AlertDialog (antes, confirm()), mesmas mensagens.
  const [removeTarget, setRemoveTarget] = useState<BlacklistEntry | null>(null);
  const removeIsOptOut = removeTarget ? classifyBlacklistEntry(removeTarget).type === "opt_out" : false;

  const handleRemove = async (id: string) => {
    setRemoveTarget(null);
    try {
      const supabase = createClient();
      const { error } = await supabase.from("blacklist").delete().eq("id", id);
      if (error) throw error;
      toast.success("Número removido da blacklist!");
      loadBlacklist();
    } catch {
      toast.error("Erro ao remover da blacklist.");
    }
  };

  // Add to Blacklist
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!telefone.trim()) {
      // Erro no próprio campo (antes só toast, longe do campo e sem aria-invalid).
      setPhoneError("Insira o número do telefone.");
      document.getElementById("blacklist-telefone")?.focus();
      return;
    }
    if (!accountId) {
      toast.error("Conta não resolvida — recarregue a página e tente de novo.");
      return;
    }

    // Mesmo formato de contacts.phone (+55DDDNÚMERO). Antes gravava sem o
    // 55 ("+11999998888") e o bloqueio nunca batia com o contato.
    // Número estrangeiro digitado com "+" (fora do +55) fica como está.
    const trimmed = telefone.trim();
    const cleanPhone =
      trimmed.startsWith("+") && !trimmed.startsWith("+55")
        ? `+${trimmed.replace(/\D/g, "")}`
        : formatBrazilianPhone(trimmed);

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
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao adicionar à blacklist.");
    }
  };

  return (
    <PageBody>
      <PageToolbar
        actions={
          <Button
            onClick={() => {
              setPhoneError(null);
              setShowModal(true);
            }}
          >
            <Plus className="size-3.5" aria-hidden="true" /> Bloquear número
          </Button>
        }
      >
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            aria-label="Buscar na blacklist"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por telefone ou palavra bloqueada"
            className="h-8 pl-8 text-[12.5px]"
          />
        </div>
      </PageToolbar>

      {/* Grupos de origem: cada célula filtra a lista (contagens reais da blacklist da conta). */}
      <KpiStrip
        ariaLabel="Separar blacklist por origem"
        loading={loading}
        minWidth={180}
        items={groupFilters.map((f) => ({
          label: f.label,
          value: groupCounts[f.key].toLocaleString("pt-BR"),
          note: f.description,
          active: groupFilter === f.key,
          onClick: () => {
            setGroupFilter(f.key);
            setOriginFilter("all");
          },
        }))}
      />

      {visibleOriginFilters.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Refinar</span>
          <Segmented
            ariaLabel="Refinar por origem"
            value={originFilter}
            onChange={setOriginFilter}
            options={visibleOriginFilters.map((f) => ({
              value: f.key,
              label: f.label,
              count: f.key === "all" ? groupCounts[groupFilter] : originCounts[f.key],
            }))}
          />
        </div>
      )}

      <p className="m-0 text-xs text-muted-foreground">
        Solicitações humanas ficam separadas das falhas técnicas. Opt-out e bloqueios manuais são imediatos; Meta 131026 só
        entra definitivamente após ocorrer em 3 campanhas diferentes para o mesmo número.
      </p>

      {loading ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Carregando blacklist">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : loadError ? (
        <ErrorState title="Não foi possível carregar a blacklist" onRetry={loadBlacklist} />
      ) : filteredList.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title={blacklist.length === 0 ? "Sua blacklist está vazia" : "Nenhum registro neste filtro"}
          hint={
            blacklist.length === 0
              ? "Nenhum número foi bloqueado ainda. Adicione contatos manualmente se necessário."
              : "Ajuste a categoria, o refinamento ou a busca para ver outros registros."
          }
        />
      ) : (
        <TableCard
          title="Números bloqueados"
          hint={`${filteredList.length.toLocaleString("pt-BR")} de ${blacklist.length.toLocaleString("pt-BR")} registros`}
        >
          <DenseTable minWidth={720}>
            <thead>
              <tr>
                <Th>Telefone</Th>
                <Th>Motivo</Th>
                <Th>Origem</Th>
                <Th>Data do bloqueio</Th>
                <Th align="right">
                  <span className="sr-only">Ações</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {filteredList.map((entry) => {
                const c = classifyBlacklistEntry(entry);
                return (
                  <Tr key={entry.id}>
                    <Td className="whitespace-nowrap font-mono font-semibold text-foreground">{entry.telefone}</Td>
                    <Td>
                      <StatusChip tone="bad">{MOTIVO_LABELS[entry.motivo] || entry.motivo}</StatusChip>
                    </Td>
                    <Td className="max-w-xs">
                      <span className="flex flex-col gap-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="font-semibold text-foreground">{c.label}</span>
                          <StatusChip tone={SEVERITY_TONE[c.severity]} dot={false}>
                            {c.severity}
                          </StatusChip>
                        </span>
                        <span className="text-[11.5px] text-muted-foreground">{c.description}</span>
                        {c.type === "opt_out" && entry.mensagem_detectada && (
                          <span className="truncate text-[11.5px] italic text-muted-foreground">“{entry.mensagem_detectada}”</span>
                        )}
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(entry.data_bloqueio).toLocaleString("pt-BR")}
                    </Td>
                    <Td align="right">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setRemoveTarget(entry)}
                        aria-label={`Remover ${entry.telefone} da blacklist`}
                        title="Remover da blacklist"
                        className="text-muted-foreground hover:bg-danger-soft hover:text-danger"
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </DenseTable>
        </TableCard>
      )}

      {/* Remover: confirmação. Opt-out tem aviso próprio (envio indevido). */}
      <AlertDialog open={removeTarget !== null} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover {removeTarget?.telefone} da blacklist?</AlertDialogTitle>
            <AlertDialogDescription>
              {removeIsOptOut
                ? "Este contato pediu para não receber mensagens. Remover este bloqueio pode causar envio indevido. Deseja continuar?"
                : "Tem certeza que deseja remover este número da blacklist? Ele voltará a receber disparos."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <Button variant="destructive" onClick={() => removeTarget && handleRemove(removeTarget.id)}>
              Remover da blacklist
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Adicionar à blacklist */}
      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Adicionar à blacklist</DialogTitle>
            <DialogDescription>O número deixa de receber disparos de todas as campanhas desta conta.</DialogDescription>
          </DialogHeader>
          <form id="blacklist-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-xs font-medium text-foreground-2">
              Telefone do contato
              <Input
                id="blacklist-telefone"
                type="tel"
                autoFocus
                aria-describedby={phoneError ? "blacklist-telefone-erro blacklist-telefone-hint" : "blacklist-telefone-hint"}
                aria-invalid={phoneError ? true : undefined}
                value={telefone}
                onChange={(e) => {
                  setTelefone(e.target.value);
                  if (phoneError) setPhoneError(null);
                }}
                placeholder="Ex: 5521999999999"
              />
              {phoneError && (
                <span id="blacklist-telefone-erro" role="alert" className="font-medium text-danger">
                  {phoneError}
                </span>
              )}
              <span id="blacklist-telefone-hint" className="font-normal text-muted-foreground">
                Insira o código do país + DDD + Número.
              </span>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-foreground-2">
              Motivo
              <select
                id="blacklist-motivo"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                className="h-8 w-full rounded-[6px] border border-input bg-background px-2 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {Object.entries(MOTIVO_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-foreground-2">
              Mensagem opcional (opt-out recebido)
              <Textarea
                id="blacklist-mensagem"
                rows={2}
                value={mensagemDetectada}
                onChange={(e) => setMensagemDetectada(e.target.value)}
                placeholder="Ex: 'Não quero mais receber mensagens'"
              />
            </label>
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setShowModal(false)}>
              Cancelar
            </Button>
            <Button type="submit" form="blacklist-form" variant="destructive">
              Bloquear
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageBody>
  );
}
