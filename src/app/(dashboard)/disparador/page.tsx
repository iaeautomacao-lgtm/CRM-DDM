"use client";

import { useEffect, useState } from "react";
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
  mensagem_final: string;
  status: string;
  scheduled_at: string;
  sent_at?: string;
  erro?: string;
  contacts?: { nome: string; phone: string };
  campaigns?: { nome: string };
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

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000); // refresh queue status every 5s
    return () => clearInterval(interval);
  }, []);

  const loadData = async () => {
    try {
      const supabase = createClient();

      // wacrm.disp_message_queue has no account_id yet (migration 040 not
      // applied), so scope it through the caller's account's campaigns
      // instead of reading the whole table — see getDisparadorScope.
      const { campaignIds } = await getDisparadorScope(supabase);

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
          mensagem_final,
          status,
          scheduled_at,
          sent_at,
          erro,
          contacts:contact_id ( name, phone ),
          campaigns:campaign_id ( nome )
        `)
        .in("campaign_id", campaignIds)
        .order("scheduled_at", { ascending: false })
        .limit(15);

      if (!error && data) {
        // Map contacts schema mapping
        const mappedData: QueueLog[] = data.map((d: any) => ({
          id: d.id,
          campaign_id: d.campaign_id,
          mensagem_final: d.mensagem_final,
          status: d.status,
          scheduled_at: d.scheduled_at,
          sent_at: d.sent_at,
          erro: d.erro,
          contacts: d.contacts ? { nome: d.contacts.name, phone: d.contacts.phone } : undefined,
          campaigns: d.campaigns ? { nome: d.campaigns.nome } : undefined,
        }));
        setQueue(mappedData);
      }

      // Fetch Queue Stats
      const { data: countData } = await supabase
        .from("disp_message_queue")
        .select("status")
        .in("campaign_id", campaignIds);

      if (countData) {
        const counts = { scheduled: 0, sending: 0, success: 0, failed: 0 };
        countData.forEach((item) => {
          if (item.status === "agendado") counts.scheduled++;
          else if (item.status === "enviando") counts.sending++;
          else if (item.status === "enviado") counts.success++;
          else if (item.status === "erro") counts.failed++;
        });
        setStats(counts);
      }
    } catch (err) {
      console.error("Failed to load queue dashboard stats:", err);
    } finally {
      setLoading(false);
    }
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
            <p className="mt-0.5 text-xs text-muted-foreground">Atualização automática a cada 5 segundos</p>
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
                        <span className="text-muted-foreground">({item.contacts?.phone || "Sem Número"})</span>
                        <span className="px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground text-[9px] uppercase font-bold">
                          {item.campaigns?.nome || "Sem Campanha"}
                        </span>
                      </div>
                      <p className="text-muted-foreground truncate mt-0.5 text-[10px]">{item.mensagem_final}</p>
                      {item.status === "erro" && (
                        <p className="text-red-500 text-[9px] flex items-center gap-1 mt-0.5">
                          <AlertTriangle className="h-3 w-3" /> Erro: {item.erro || "Falha desconhecida"}
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
