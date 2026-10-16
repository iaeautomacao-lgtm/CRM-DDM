// Cliente do db-host da bancada (JSON por linha em socket local). Expõe só `rpc`, o mesmo recorte de SupabaseClient que o claim e a
// confirmação em lote usam (Pick<SupabaseClient, "rpc">), então o código de produção roda sem mudança.
import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";

export interface BenchRpcError {
  message: string;
  code?: string;
}
type Reply = { id: number; data?: unknown; error?: BenchRpcError | null; [key: string]: unknown };

export class BenchDb {
  private socket!: Socket;
  private seq = 0;
  private waiting = new Map<number, (reply: Reply) => void>();

  static async connect(port: number): Promise<BenchDb> {
    const client = new BenchDb();
    await new Promise<void>((resolveConnect, reject) => {
      client.socket = createConnection({ host: "127.0.0.1", port }, () => resolveConnect());
      client.socket.once("error", reject);
    });
    client.socket.setNoDelay(true);
    createInterface({ input: client.socket }).on("line", (line) => {
      const reply = JSON.parse(line) as Reply;
      const done = client.waiting.get(reply.id);
      if (done) {
        client.waiting.delete(reply.id);
        done(reply);
      }
    });
    return client;
  }

  private call(body: Record<string, unknown>): Promise<Reply> {
    const id = ++this.seq;
    return new Promise((resolveCall) => {
      this.waiting.set(id, resolveCall);
      this.socket.write(`${JSON.stringify({ id, ...body })}\n`);
    });
  }

  /** Mesma forma do supabase-js: nunca rejeita, devolve { data, error }. */
  async rpc(fn: string, args: Record<string, unknown> = {}): Promise<{ data: any; error: BenchRpcError | null }> {
    const reply = await this.call({ op: "rpc", fn, args });
    return { data: reply.data ?? null, error: reply.error ?? null };
  }

  async seed(body: { account: string; numbers: Array<{ sessionId: string; campaignId: string }>; rowsPerNumber: number }): Promise<void> {
    const reply = await this.call({ op: "seed", ...body });
    if (reply.error) throw new Error(reply.error.message);
  }

  async summary(): Promise<{ statuses: Array<{ status: string; n: number }>; duplicates: number }> {
    return (await this.call({ op: "summary" })) as never;
  }

  async stats(reset = false): Promise<{
    mode: "pglite" | "memory";
    uptime_s: number;
    busy_s: number;
    cpu_ms: number;
    rss_mb: number;
    service: Record<string, number[]>;
  }> {
    return (await this.call({ op: "stats", reset })) as never;
  }

  close(): void {
    this.socket.destroy();
  }
}
