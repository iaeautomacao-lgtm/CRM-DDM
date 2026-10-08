import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeTables } from "./fake-db.test-helper";

const audit = vi.fn();
const writeLog = vi.fn();
let current: ReturnType<typeof fakeDb>;
vi.mock("@/lib/audit/log-event", () => ({ logAuditEvent: (...a: unknown[]) => audit(...a) }));
vi.mock("@/lib/logger", () => ({ writeLog: (...a: unknown[]) => writeLog(...a) }));
vi.mock("@/lib/disparador/admin-client", () => ({ supabaseAdmin: () => current.db }));

import { parseRedConfirmation } from "./red-quality-gate";
import { startCampaign } from "./startCampaign";

const ACC = "acc-1";
const CAMP = "camp-1";
const SESSION = "11111111-1111-1111-1111-111111111111";

function seed(quality: string, status = "rascunho"): FakeTables {
  return {
    campaigns: [{ id: CAMP, account_id: ACC, status, session_ids: [SESSION], motivo_falha_inicio: null }],
    whatsapp_config: [{ id: SESSION, account_id: ACC, provider: "meta", display_phone_number: "+55 11 99999-0000" }],
    channel_health: [{ session_id: SESSION, account_id: ACC, quality_rating: quality }],
    dispatch_rate_policy: [],
    dispatch_channel_rate_history: [],
  };
}

beforeEach(() => {
  audit.mockClear();
  writeLog.mockClear();
});

describe("parseRedConfirmation", () => {
  const body = { confirm_red_quality: true, red_quality_reason: "cliente VIP urgente" };
  it("só owner, com caixa marcada e motivo", () => {
    expect(parseRedConfirmation("owner", "u1", body)).toEqual({ actorId: "u1", reason: "cliente VIP urgente" });
    expect(parseRedConfirmation("admin", "u1", body)).toBeUndefined();
    expect(parseRedConfirmation("owner", "u1", { ...body, confirm_red_quality: false })).toBeUndefined();
    expect(parseRedConfirmation("owner", "u1", { ...body, red_quality_reason: " a " })).toBeUndefined();
    expect(parseRedConfirmation("owner", null, body)).toBeUndefined();
    expect(parseRedConfirmation("owner", "u1", null)).toBeUndefined();
  });
});

describe("startCampaign com número vermelho", () => {
  it("admin / sem confirmação: 409 com código, lista de números e nada é preparado", async () => {
    current = fakeDb(seed("RED"));
    const result = await startCampaign(CAMP, ACC);
    expect(result).toMatchObject({ ok: false, status: 409, code: "red_quality_owner_required" });
    expect(!result.ok && result.channels).toEqual([{ id: SESSION, display_phone_number: "+55 11 99999-0000" }]);
    expect(current.tables.campaigns[0].status).toBe("rascunho");
    expect(current.tables.dispatch_channel_rate_history).toHaveLength(0);
  });

  it("owner com confirmação: passa o gate e grava histórico + auditoria", async () => {
    current = fakeDb(seed("RED"));
    const result = await startCampaign(CAMP, ACC, { redConfirmation: { actorId: "u-owner", reason: "cliente VIP urgente" } });
    expect(!result.ok && result.code).toBeFalsy();
    expect(current.tables.dispatch_channel_rate_history[0]).toMatchObject({ actor_id: "u-owner", reason: "cliente VIP urgente", quality_new: "RED" });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toMatchObject({ action: "campaign.red_quality_confirmed", resourceId: CAMP });
  });

  it("agendada que vence: não prepara, segue 'agendado' com motivo e avisa uma vez só", async () => {
    current = fakeDb(seed("RED", "agendado"));
    await startCampaign(CAMP, ACC);
    await startCampaign(CAMP, ACC);
    expect(current.tables.campaigns[0].status).toBe("agendado");
    expect(String(current.tables.campaigns[0].motivo_falha_inicio)).toMatch(/Aguardando confirmação do owner/);
    const warns = writeLog.mock.calls.filter((c) => (c[0] as { event: string }).event === "campaign_red_quality_blocked");
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({ level: "warn", account_id: ACC });
  });

  it("verde e amarelo seguem inalterados (gate não interfere)", async () => {
    for (const quality of ["GREEN", "YELLOW"]) {
      current = fakeDb(seed(quality));
      const result = await startCampaign(CAMP, ACC);
      expect(!result.ok && result.code, quality).toBeFalsy();
      expect(current.tables.dispatch_channel_rate_history, quality).toHaveLength(0);
    }
  });

  it("sem as tabelas da migration 190: inerte", async () => {
    current = fakeDb(seed("RED"), ["channel_health"]);
    const result = await startCampaign(CAMP, ACC);
    expect(!result.ok && result.code).toBeFalsy();
  });
});
