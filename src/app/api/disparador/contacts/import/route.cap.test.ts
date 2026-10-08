// Importação por ARQUIVO numa requisição só: acima do teto o servidor não parseia/processa na hora — manda usar o job.
// O caminho por blocos JSON (até 10.000 linhas por requisição) não muda.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/disparador/route-auth", () => ({ requireDisparadorAccess: async () => ({ accountId: "acc-1", userId: "u1" }) }));
vi.mock("@/lib/disparador/admin-client", () => ({ supabaseAdmin: () => { throw new Error("não deveria tocar no banco"); } }));
vi.mock("@/lib/logger", () => ({ writeLog: vi.fn() }));

import { POST } from "./route";
import { IMPORT_SYNC_FILE_MAX_ROWS } from "@/lib/disparador/import-jobs";

describe("POST /api/disparador/contacts/import — arquivo grande", () => {
  it(`CSV com mais de ${IMPORT_SYNC_FILE_MAX_ROWS} linhas: 409 import_too_large com o endpoint do job, sem tocar no banco`, async () => {
    const lines = ["nome;telefone"];
    for (let i = 0; i <= IMPORT_SYNC_FILE_MAX_ROWS; i++) lines.push(`Contato ${i};119${String(10_000_000 + i)}`);
    const form = new FormData();
    form.set("file", new File([lines.join("\n")], "base.csv", { type: "text/csv" }));
    const res = await POST(new Request("https://crm.test/api", { method: "POST", body: form }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "import_too_large", async_endpoint: "/api/disparador/imports", max_sync_rows: IMPORT_SYNC_FILE_MAX_ROWS });
  });
});
