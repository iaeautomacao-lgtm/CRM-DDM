// Confirmação do envio EM MICRO-LOTE (migration 188, P1-3b). Cada envio aceito pelo provedor precisa de uma confirmação local
// (mark_queue_item_sent + message_logs + delta de métrica + replay de recibos). Em vez de 1 RPC por envio, acumula até `maxItems` itens ou
// `maxWaitMs` (padrão 20 itens / 150 ms) e chama confirm_dispatch_items_sent UMA vez; cada item tem o mesmo efeito da confirmação unitária.
//
// Janela de perda em crash ≤ ~maxWaitMs: um item aceito pelo provedor e ainda não confirmado fica 'enviando' SEM recibo — o watchdog
// (reconcile-unknown-provider-outcomes) o finaliza como resultado incerto, NUNCA reenvia. Por isso o tick drena o lote pendente no fim
// (drain) e o SIGTERM também (registerShutdownDrain).
//
// Sem a RPC do lote (migration 188 não aplicada) cai na confirmação unitária injetada em `single`.

import type { SupabaseClient } from "@supabase/supabase-js";
import { onShutdownAfterSends } from "@/lib/disparador/shutdown-gate";

type Db = Pick<SupabaseClient, "rpc">;

export interface ConfirmArgs {
  p_item_id: string;
  p_campaign_id: string;
  p_contact_id: string | null;
  p_session_id: string;
  p_mensagem: string;
  p_waha_message_id: string;
  p_tentativas: number;
}

export interface ConfirmResult {
  error: { message: string } | null;
  /** O replay de recibos já rodou dentro da confirmação. */
  replayed: boolean;
}

export interface ConfirmBatcherOptions {
  db: Db;
  /** Confirmação unitária (fallback sem a RPC do lote). */
  single: (args: Record<string, unknown>) => Promise<ConfirmResult>;
  maxItems?: number;
  maxWaitMs?: number;
}

interface Pending {
  args: ConfirmArgs;
  resolve: (result: ConfirmResult) => void;
}

function isMissingRpc(error: { code?: string } | null | undefined): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}

export class ConfirmBatcher {
  private queue: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = new Set<Promise<void>>();
  private batchUnavailable = false;
  private readonly maxItems: number;
  private readonly maxWaitMs: number;
  batches = 0;
  confirmed = 0;

  constructor(private readonly options: ConfirmBatcherOptions) {
    this.maxItems = options.maxItems ?? 20;
    this.maxWaitMs = options.maxWaitMs ?? 150;
  }

  /** Enfileira a confirmação; resolve quando o lote dela for gravado (ou falhar). Nunca rejeita. */
  submit(args: ConfirmArgs): Promise<ConfirmResult> {
    return new Promise<ConfirmResult>((resolve) => {
      this.queue.push({ args, resolve });
      if (this.queue.length >= this.maxItems) {
        void this.flush();
      } else if (!this.timer) {
        this.timer = setTimeout(() => void this.flush(), this.maxWaitMs);
        this.timer.unref?.();
      }
    });
  }

  /** Grava já o que está acumulado. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.queue.splice(0);
    if (batch.length === 0) return Promise.resolve();
    const run = this.writeBatch(batch).finally(() => this.inFlight.delete(run));
    this.inFlight.add(run);
    return run;
  }

  /** Fim do tick / SIGTERM: grava o pendente e espera TODOS os lotes em andamento. */
  async drain(): Promise<void> {
    await this.flush();
    await Promise.allSettled([...this.inFlight]);
  }

  private async writeBatch(batch: Pending[]): Promise<void> {
    try {
      if (this.batchUnavailable) return await this.writeSingles(batch);
      const { data, error } = await this.options.db.rpc("confirm_dispatch_items_sent", { p_items: batch.map((p) => p.args) });
      if (error) {
        if (isMissingRpc(error)) {
          this.batchUnavailable = true;
          console.warn("[Disparador] confirm_dispatch_items_sent indisponível (migration 188 não aplicada); confirmando item a item.");
          return await this.writeSingles(batch);
        }
        // Falha do lote inteiro (rede/timeout): o envio JÁ saiu; cada item devolve o erro e o processQueue guarda o recibo.
        for (const p of batch) p.resolve({ error: { message: error.message }, replayed: false });
        return;
      }
      this.batches++;
      const results = Array.isArray(data) ? (data as Array<{ ok?: boolean; error?: string | null; item_id?: string }>) : [];
      batch.forEach((p, index) => {
        const r = results[index];
        if (r && r.ok === true) {
          this.confirmed++;
          p.resolve({ error: null, replayed: true });
        } else {
          p.resolve({ error: { message: r?.error ?? "confirmação em lote sem resultado para o item" }, replayed: false });
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const p of batch) p.resolve({ error: { message }, replayed: false });
    }
  }

  private async writeSingles(batch: Pending[]): Promise<void> {
    await Promise.all(
      batch.map(async (p) => {
        try {
          p.resolve(await this.options.single({ ...p.args }));
        } catch (error) {
          p.resolve({ error: { message: error instanceof Error ? error.message : String(error) }, replayed: false });
        }
      }),
    );
  }
}

/** Confirmação unitária padrão (a mesma de processQueue.confirmItemSent): confirm_dispatch_item_sent, ou mark_queue_item_sent sem a 167. */
export function singleConfirm(db: Db): (args: Record<string, unknown>) => Promise<ConfirmResult> {
  let confirmUnavailable = false;
  return async (args) => {
    if (!confirmUnavailable) {
      const { error } = await db.rpc("confirm_dispatch_item_sent", args);
      if (!error) return { error: null, replayed: true };
      if (!isMissingRpc(error)) return { error, replayed: false };
      confirmUnavailable = true;
    }
    const { error } = await db.rpc("mark_queue_item_sent", args);
    return { error, replayed: false };
  };
}

// SIGTERM (deploy/restart do Passenger): primeiro espera os envios em voo (shutdown-gate, até 8 s: assim a confirmação deles entra no
// micro-lote), depois drena os lotes pendentes antes de sair. Registra-se uma vez; o callback só age sobre os batchers ativos.
const active = new Set<ConfirmBatcher>();
let drainRegistered = false;

export function registerShutdownDrain(batcher: ConfirmBatcher): () => void {
  active.add(batcher);
  if (!drainRegistered) {
    drainRegistered = true;
    onShutdownAfterSends(async () => {
      await Promise.allSettled([...active].map((b) => b.drain()));
    });
  }
  return () => {
    active.delete(batcher);
  };
}
