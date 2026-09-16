"use client";

import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { getDisparadorScope } from "@/lib/disparador/scope";
import { 
  Megaphone, 
  Clock, 
  ShieldAlert, 
  CheckCircle2, 
  AlertCircle, 
  Loader2, 
  Play, 
  Pause,
  ArrowRight,
  TrendingUp,
  Inbox,
  AlertTriangle,
  FileSpreadsheet
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

interface QueueLog {
  id: string;
  campaign_id: string;
  contact_id?: string | null;
  mensagem_final: string;
  status: string;
  scheduled_at: string;
  sent_at?: string;
  erro?: string;
  phone_attempt_order?: number;
  contacts?: { nome: string; phone: string };
  campaigns?: { nome: string };
  /** Telefone real da tentativa atual quando phone_attempt_order > 1
   * (resolvido via wacrm.contact_phones — ver loadData) — não persiste,
   * só para exibição no monitor. */
  _displayPhone?: string;
}

// Contagem de itens por (campaign_id, status). Usa a RPC wacrm.get_campaign_stats
// (migration 075 — agregação no servidor) quando disponível; sem a migration
// aplicada, cai para buscar as linhas cruas e agregar no cliente (comportamento
// atual, mais caro em volume alto mas funcionalmente idêntico).
async function fetchCampaignStats(
  supabase: SupabaseClient,
  campaignIds: string[]
): Promise<{ campaign_id: string; status: string; qty: number }[]> {
  try {
    const { data, error } = await supabase.rpc("get_campaign_stats", {
      p_campaign_ids: campaignIds,
    });
    if (!error && data) return data;
  } catch {
    // RPC ainda não existe (migration 075 não aplicada) — fallback abaixo.
  }

  const { data } = await supabase
    .from("disp_message_queue")
    .select("campaign_id, status")
    .in("campaign_id", campaignIds);

  const acc: Record<string, Record<string, number>> = {};
  for (const row of data ?? []) {
    acc[row.campaign_id] ??= {};
    acc[row.campaign_id][row.status] = (acc[row.campaign_id][row.status] ?? 0) + 1;
  }
  return Object.entries(acc).flatMap(([cid, ss]) =>
    Object.entries(ss).map(([status, qty]) => ({ campaign_id: cid, status, qty }))
  );
}

export default function DisparadorDashboardPage() {
  const [queue, setQueue] = useState<QueueLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    scheduled: 0,
    sending: 0,
    success: 0,
    failed: 0,
  });
  const [queueLimit, setQueueLimit] = useState(15);
  const [hasMoreQueue, setHasMoreQueue] = useState(false);

  // Cached once on mount — account scope doesn't change during the
  // session, so re-deriving it every tick just costs 3 extra queries.
  const campaignIdsRef = useRef<string[]>([]);

  // The 30s polling interval below is set up once on mount and closes
  // over loadData from that render — reading the limit through a ref
  // (kept in sync every render) lets each tick see the latest value
  // from "Carregar mais" instead of the one captured at mount.
  const queueLimitRef = useRef(queueLimit);
  queueLimitRef.current = queueLimit;

  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | undefined;

    (async () => {
      const supabase = createClient();
      const { campaignIds } = await getDisparadorScope(supabase);
      if (cancelled) return;
      campaignIdsRef.current = campaignIds;
      await loadData();
      interval = setInterval(loadData, 30000); // refresh queue status every 30s
    })();

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, []);

  // Refetch when "Carregar mais" bumps queueLimit — skips the initial
  // mount (already handled by the effect above) so it doesn't race
  // loadData before campaignIdsRef is populated.
  const isFirstQueueLimitRun = useRef(true);
  useEffect(() => {
    if (isFirstQueueLimitRun.current) {
      isFirstQueueLimitRun.current = false;
      return;
    }
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueLimit]);

  const loadData = async () => {
    try {
      const supabase = createClient();

      // wacrm.disp_message_queue has no account_id yet (migration 040 not
      // applied), so scope it through the caller's account's campaigns
      // instead of reading the whole table — see getDisparadorScope.
      const campaignIds = campaignIdsRef.current;

      if (campaignIds.length === 0) {
        setQueue([]);
        setStats({ scheduled: 0, sending: 0, success: 0, failed: 0 });
        setLoading(false);
        return;
      }

      // Fetch last 15 queue logs with contact and campaign info
      const { data, error } = await supabase
        .from("disp_message_queue")
        .select(`
          id,
          campaign_id,
          contact_id,
          mensagem_final,
          status,
          scheduled_at,
          sent_at,
          erro,
          phone_attempt_order,
          contacts:contact_id ( name, phone ),
          campaigns:campaign_id ( nome )
        `)
        .in("campaign_id", campaignIds)
        .order("scheduled_at", { ascending: false })
        .limit(queueLimitRef.current);

      if (!error && data) {
        // Map contacts schema mapping
        const mappedData: QueueLog[] = data.map((d: any) => ({
          id: d.id,
          campaign_id: d.campaign_id,
          contact_id: d.contact_id,
          mensagem_final: d.mensagem_final,
          status: d.status,
          scheduled_at: d.scheduled_at,
          sent_at: d.sent_at,
          erro: d.erro,
          phone_attempt_order: d.phone_attempt_order,
          contacts: d.contacts ? { nome: d.contacts.name, phone: d.contacts.phone } : undefined,
          campaigns: d.campaigns ? { nome: d.campaigns.nome } : undefined,
        }));

        // Itens em escada (phone_attempt_order > 1) mostram o TELEFONE1
        // via contacts.phone — busca em lote o telefone real da tentativa
        // atual em contact_phones pra exibir no lugar.
        const escadaItems = mappedData.filter((i) => (i.phone_attempt_order ?? 1) > 1 && i.contact_id);
        if (escadaItems.length > 0) {
          const contactIds = [...new Set(escadaItems.map((i) => i.contact_id as string))];
          const orders = [...new Set(escadaItems.map((i) => i.phone_attempt_order as number))];

          const { data: altPhones } = await supabase
            .from("contact_phones")
            .select("contact_id, phone, ordem")
            .in("contact_id", contactIds)
            .in("ordem", orders);

          const altPhoneMap = new Map(
            (altPhones ?? []).map((r: any) => [`${r.contact_id}:${r.ordem}`, r.phone as string])
          );

          for (const item of mappedData) {
            const order = item.phone_attempt_order ?? 1;
            if (order <= 1 || !item.contact_id) continue;
            const altPhone = altPhoneMap.get(`${item.contact_id}:${order}`);
            if (altPhone) item._displayPhone = altPhone;
          }
        }

        setQueue(mappedData);
        setHasMoreQueue(data.length >= queueLimitRef.current);
      }

      // Fetch Queue Stats (agregado por campanha+status, ver fetchCampaignStats)
      const statRows = await fetchCampaignStats(supabase, campaignIds);
      const counts = { scheduled: 0, sending: 0, success: 0, failed: 0 };
      statRows.forEach(({ status, qty }) => {
        if (status === "agendado") counts.scheduled += qty;
        else if (status === "enviando") counts.sending += qty;
        else if (status === "enviado") counts.success += qty;
        else if (status === "erro") counts.failed += qty;
      });
      setStats(counts);
    } catch (err) {
      console.error("Failed to load queue dashboard stats:", err);
    } finally {
      setLoading(false);
    }
  };

  const normalizarErroMeta = (erro: string | null | undefined): string => {
    if (!erro) return "Falha desconhecida";

    const codigoMatch = erro.match(/code (\d+)/);
    const codigo = codigoMatch ? parseInt(codigoMatch[1]) : null;

    const mensagens: Record<number, string> = {
      // Elegibilidade e pagamento
      131042: "Pendência de pagamento na conta Meta. Verifique o faturamento no Meta Business Manager.",
      131031: "Conta do WhatsApp Business bloqueada pela Meta.",
      131053: "Limite de envio do tier atingido. Aguarde ou solicite aumento de tier.",

      // Janela e template
      131026: "Janela de 24h encerrada. Use um template aprovado para este contato.",
      132000: "Template não encontrado. Verifique o nome do template.",
      132001: "Template pausado ou desativado pela Meta.",
      132005: "Tradução do template não aprovada pela Meta.",
      132007: "Template com conteúdo que viola as políticas da Meta.",
      132012: "Parâmetros do template excedem o limite permitido.",

      // Parâmetros e formato
      131008: "Parâmetro obrigatório ausente. Verifique as variáveis do template.",
      131051: "Tipo de mensagem não suportado para este número.",
      131052: "Mídia inválida ou inacessível. Verifique a URL da mídia.",

      // Número do destinatário
      131030: "Número de telefone inválido ou não registrado no WhatsApp.",
      131045: "Número de telefone não registrado no WhatsApp Business.",
      131047: "Mensagem não entregue. O número pode estar inválido ou bloqueado.",
      131021: "Remetente e destinatário são o mesmo número.",
      131048: "Muitas mensagens enviadas para este número. Aguarde antes de tentar novamente.",
      131049: "Número do remetente não registrado no WhatsApp Business.",

      // Erros de sistema Meta
      131500: "Erro interno da Meta. Tente novamente em alguns minutos.",
      131501: "Serviço da Meta temporariamente indisponível. Tente novamente.",
      131000: "Erro genérico da Meta. Tente novamente.",
      1:      "Erro desconhecido da Meta. Verifique o Meta Business Manager.",
    };

    if (codigo && mensagens[codigo]) {
      return mensagens[codigo];
    }

    // Erros não-Meta (ex: "WhatsApp WAHA connection is not active")
    return erro;
  };

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col space-y-6 p-4 lg:p-6 overflow-hidden">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 border-b border-border/40 pb-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Megaphone className="h-5 w-5" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              Central do Disparador
            </h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Acompanhe o processamento de campanhas e envios em massa na nuvem.
          </p>
        </div>

        <div className="flex gap-2.5">
          <Link href="/disparador/blacklist">
            <Button variant="outline" className="gap-1.5 text-xs h-9">
              <ShieldAlert className="h-4 w-4 text-red-500" /> Blacklist
            </Button>
          </Link>
          <Link href="/disparador/contatos">
            <Button variant="outline" className="gap-1.5 text-xs h-9">
              <FileSpreadsheet className="h-4 w-4 text-primary" /> Importar Contatos
            </Button>
          </Link>
          <Link href="/disparador/campanhas">
            <Button className="gap-1.5 text-xs h-9">
              Gerenciar Campanhas <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-border bg-card p-4 space-y-1.5 shadow-sm">
          <span className="text-[10px] font-bold text-muted-foreground uppercase">Agendados na Fila</span>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-bold tracking-tight text-foreground">{stats.scheduled}</span>
            <Clock className="h-5 w-5 text-zinc-400" />
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 space-y-1.5 shadow-sm">
          <span className="text-[10px] font-bold text-muted-foreground uppercase">Processando</span>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-bold tracking-tight text-primary flex items-center gap-1.5">
              {stats.sending > 0 && <Loader2 className="h-4 w-4 animate-spin" />}
              {stats.sending}
            </span>
            <TrendingUp className="h-5 w-5 text-primary" />
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 space-y-1.5 shadow-sm">
          <span className="text-[10px] font-bold text-emerald-500 uppercase">Sucesso total</span>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-bold tracking-tight text-emerald-500">{stats.success}</span>
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 space-y-1.5 shadow-sm">
          <span className="text-[10px] font-bold text-red-500 uppercase">Falhas</span>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-bold tracking-tight text-red-500">{stats.failed}</span>
            <AlertCircle className="h-5 w-5 text-red-500" />
          </div>
        </div>
      </div>

      {/* Main Content (Log monitor) */}
      <div className="flex-1 flex flex-col rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <header className="border-b border-border px-5 py-4 flex items-center justify-between bg-muted/20">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Monitor da Fila em Tempo Real</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Atualização automática a cada 30 segundos</p>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex h-32 items-center justify-center text-muted-foreground">
              Carregando fila de transmissão...
            </div>
          ) : queue.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center text-center text-muted-foreground border border-dashed border-border rounded-xl">
              <Inbox className="h-10 w-10 opacity-20 mb-2" />
              <h4 className="font-semibold">Nenhuma mensagem na fila</h4>
              <p className="text-xs max-w-xs mt-1">Crie e ative uma campanha para começar a ver o tráfego de mensagens aqui.</p>
            </div>
          ) : (
            <div className="space-y-3 font-mono text-[11px]">
              {queue.map((item) => (
                <div 
                  key={item.id} 
                  className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-border/30 pb-3 last:border-0 last:pb-0 gap-2"
                >
                  <div className="flex items-start gap-2.5 truncate max-w-xl">
                    <div className="mt-0.5">
                      {item.status === "agendado" && <span className="h-2 w-2 rounded-full bg-zinc-400 block" />}
                      {item.status === "enviando" && <Loader2 className="h-3 w-3 text-primary animate-spin" />}
                      {item.status === "enviado" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
                      {item.status === "erro" && <AlertCircle className="h-3.5 w-3.5 text-red-500" />}
                    </div>
                    <div className="truncate">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-foreground">
                          {item.contacts?.nome || "Contato"}
                        </span>
                        <span className="text-muted-foreground">({item._displayPhone || item.contacts?.phone || "Sem Número"})</span>
                        {(item.phone_attempt_order ?? 1) > 1 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded border
                            bg-amber-500/20 text-amber-400 border-amber-500/30 font-medium">
                            Tentativa {item.phone_attempt_order}/3
                          </span>
                        )}
                        <span className="px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground text-[9px] uppercase font-bold">
                          {item.campaigns?.nome || "Sem Campanha"}
                        </span>
                      </div>
                      <p className="text-muted-foreground truncate mt-0.5 text-[10px]">{item.mensagem_final}</p>
                      {item.status === "erro" && (
                        <p className="text-red-500 text-[9px] flex items-center gap-1 mt-0.5">
                          <AlertTriangle className="h-3 w-3" />
                          {normalizarErroMeta(item.erro)}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full ${
                      item.status === "enviado" ? "text-emerald-500 bg-emerald-500/10" :
                      item.status === "erro" ? "text-red-500 bg-red-500/10" :
                      item.status === "enviando" ? "text-primary bg-primary/10" : "text-zinc-500 bg-zinc-100"
                    }`}>
                      {item.status === "agendado" ? "Agendado" : item.status}
                    </span>
                    <span className="block text-[9px] text-muted-foreground mt-1">
                      {item.status === "enviado" && item.sent_at
                        ? new Date(item.sent_at).toLocaleTimeString()
                        : new Date(item.scheduled_at).toLocaleTimeString()
                      }
                    </span>
                  </div>
                </div>
              ))}
              {hasMoreQueue && (
                <button
                  onClick={() => setQueueLimit(prev => prev + 15)}
                  className="w-full py-2 text-xs text-muted-foreground hover:text-foreground transition-colors border-t border-border/30 mt-2"
                >
                  Carregar mais...
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
