import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BLACKLIST_PRELOAD_CHUNK, channelConfigFor, preloadBlacklist, queueItemPrimaryPhone } from "./tick-preload";
import { phoneKey, phoneVariants } from "./phone-key";

const dbWith = (rpc: (name: string, args: { p_keys: string[] }) => Promise<unknown>) =>
  ({ rpc: vi.fn(rpc) }) as unknown as SupabaseClient & { rpc: ReturnType<typeof vi.fn> };

describe("queueItemPrimaryPhone (mesma regra do processQueueItem)", () => {
  it("contato: só o telefone do contato (mensagem_final é texto, nunca telefone); escada: null; externo: mensagem_final", () => {
    expect(queueItemPrimaryPhone({ contact_id: "c", mensagem_final: "x", contacts: { phone: "+5511999998888" } })).toBe(
      "+5511999998888"
    );
    expect(queueItemPrimaryPhone({ contact_id: "c", mensagem_final: "Seu débito de R$ 1.234,56", contacts: {} })).toBeNull();
    expect(queueItemPrimaryPhone({ contact_id: "c", mensagem_final: "5511", contacts: { phone: "" } })).toBeNull();
    expect(
      queueItemPrimaryPhone({ contact_id: "c", mensagem_final: "x", phone_attempt_order: 2, contacts: { phone: "1" } })
    ).toBeNull();
    expect(queueItemPrimaryPhone({ contact_id: null, mensagem_final: "21987654321" })).toBe("21987654321");
    expect(queueItemPrimaryPhone({ contact_id: null, mensagem_final: "" })).toBeNull();
  });
});

describe("preloadBlacklist", () => {
  it("uma chamada por bloco de chaves únicas; responde só pelos telefones do tick", async () => {
    const db = dbWith(async () => ({ data: [{ key: phoneKey("11999998888") }], error: null }));
    const lookup = await preloadBlacklist(db, ["+5511999998888", "11 99999-8888", "21987654321", null, ""]);
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc.mock.calls[0][1].p_keys).toEqual([phoneKey("11999998888"), phoneKey("21987654321")]);
    expect(lookup?.("5511 9999-8888")).toBe(true);
    expect(lookup?.("+5521987654321")).toBe(false);
    expect(lookup?.("31911112222")).toBeUndefined();
    expect(lookup?.("")).toBeUndefined();
  });

  it("cobre toda variação que a checagem por envio pegaria (chave ⊇ variações)", async () => {
    for (const raw of ["+5511999998888", "1199998888", "+551134567890", "11934567890", "+1 415 555 0100"]) {
      const key = phoneKey(raw);
      for (const variant of phoneVariants(raw)) expect(phoneKey(variant), `${raw} → ${variant}`).toBe(key);
    }
  });

  it("divide em blocos de 1.000 chaves", async () => {
    const db = dbWith(async () => ({ data: [], error: null }));
    const phones = Array.from({ length: BLACKLIST_PRELOAD_CHUNK + 5 }, (_, i) => `1199${String(i).padStart(6, "0")}`);
    const lookup = await preloadBlacklist(db, phones);
    expect(db.rpc).toHaveBeenCalledTimes(2);
    expect(db.rpc.mock.calls[1][1].p_keys).toHaveLength(5);
    expect(lookup?.(phones[0])).toBe(false);
  });

  it("RPC ausente/erro ou sem telefones: undefined (cada envio consulta o banco)", async () => {
    const missing = dbWith(async () => ({ data: null, error: { code: "PGRST202", message: "not found" } }));
    expect(await preloadBlacklist(missing, ["11999998888"])).toBeUndefined();
    const throwing = dbWith(async () => {
      throw new Error("rede");
    });
    expect(await preloadBlacklist(throwing, ["11999998888"])).toBeUndefined();
    const unused = dbWith(async () => ({ data: [], error: null }));
    expect(await preloadBlacklist(unused, [null, ""])).toBeUndefined();
    expect(unused.rpc).not.toHaveBeenCalled();
  });
});

describe("channelConfigFor", () => {
  const configs = new Map([["ch", { id: "ch", account_id: "acc" }]]);
  it("mesmo filtro de conta da leitura por envio", () => {
    expect(channelConfigFor(configs, "ch", "acc")).toEqual({ id: "ch", account_id: "acc" });
    expect(channelConfigFor(configs, "ch", undefined)).toEqual({ id: "ch", account_id: "acc" });
    expect(channelConfigFor(configs, "ch", "outra")).toBeNull();
    expect(channelConfigFor(configs, "nenhum", "acc")).toBeNull();
    expect(channelConfigFor(null, "ch", "acc")).toBeUndefined();
  });
});
