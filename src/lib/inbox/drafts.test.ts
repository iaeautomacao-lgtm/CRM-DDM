import { describe, expect, it } from "vitest";
import {
  DRAFT_PREFIX,
  DRAFT_TTL_MS,
  clearAllDrafts,
  draftEpoch,
  draftKey,
  purgeExpiredDrafts,
  readDraft,
  writeDraft,
} from "./drafts";

/** Storage em memória com a mesma interface mínima do localStorage. */
function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const A = { accountId: "acc-1", userId: "user-A" };
const B = { accountId: "acc-1", userId: "user-B" };
const OUTRA_CONTA = { accountId: "acc-2", userId: "user-A" };
const NOW = 1_800_000_000_000;

describe("rascunho do operador (LGPD)", () => {
  it("a chave leva conta, usuário e conversa", () => {
    expect(draftKey(A, "conv-1")).toBe("wacrm:draft:v2:acc-1:user-A:conv-1");
  });

  it("outro usuário, ou a mesma pessoa em outra conta, não lê o rascunho", () => {
    const s = memoryStorage();
    writeDraft(A, "conv-1", "proposta com CPF 000.000.000-00", { storage: s, now: NOW });
    expect(readDraft(A, "conv-1", { storage: s, now: NOW })).toBe("proposta com CPF 000.000.000-00");
    expect(readDraft(B, "conv-1", { storage: s, now: NOW })).toBeNull();
    expect(readDraft(OUTRA_CONTA, "conv-1", { storage: s, now: NOW })).toBeNull();
  });

  it("sem usuário/conta resolvidos não grava nem lê", () => {
    const s = memoryStorage();
    writeDraft(null, "conv-1", "texto", { storage: s });
    expect(s.data.size).toBe(0);
    expect(readDraft(null, "conv-1", { storage: s })).toBeNull();
  });

  it("texto vazio apaga o rascunho", () => {
    const s = memoryStorage();
    writeDraft(A, "conv-1", "algo", { storage: s, now: NOW });
    writeDraft(A, "conv-1", "", { storage: s, now: NOW });
    expect(s.data.size).toBe(0);
  });

  it("vence em 7 dias: a leitura devolve null e apaga", () => {
    const s = memoryStorage();
    writeDraft(A, "conv-1", "velho", { storage: s, now: NOW });
    expect(readDraft(A, "conv-1", { storage: s, now: NOW + DRAFT_TTL_MS - 1 })).toBe("velho");
    expect(readDraft(A, "conv-1", { storage: s, now: NOW + DRAFT_TTL_MS })).toBeNull();
    expect(s.data.size).toBe(0);
  });

  it("valor ilegível é descartado", () => {
    const s = memoryStorage();
    s.setItem(draftKey(A, "conv-1"), "não é json");
    expect(readDraft(A, "conv-1", { storage: s, now: NOW })).toBeNull();
    expect(s.data.size).toBe(0);
  });

  it("clearAllDrafts apaga todos os rascunhos (inclusive o formato antigo) e preserva o resto", () => {
    const s = memoryStorage();
    writeDraft(A, "conv-1", "a", { storage: s, now: NOW });
    writeDraft(B, "conv-2", "b", { storage: s, now: NOW });
    s.setItem(`${DRAFT_PREFIX}conv-antiga`, "formato antigo, sem usuário");
    s.setItem("outra-chave", "fica");
    clearAllDrafts(s);
    expect([...s.data.keys()]).toEqual(["outra-chave"]);
  });

  it("gravação agendada antes da limpeza (pagehide do logout) não reescreve o rascunho", () => {
    const s = memoryStorage();
    const epoch = draftEpoch();
    clearAllDrafts(s); // logout
    writeDraft(A, "conv-1", "texto pendente", { storage: s, expectedEpoch: epoch });
    expect(s.data.size).toBe(0);
    // uma gravação nova (depois da limpeza) funciona
    writeDraft(A, "conv-1", "novo", { storage: s, expectedEpoch: draftEpoch() });
    expect(s.data.size).toBe(1);
  });

  it("a varredura ao entrar apaga vencidos, ilegíveis e o formato antigo, e mantém os válidos", () => {
    const s = memoryStorage();
    writeDraft(A, "recente", "fica", { storage: s, now: NOW });
    writeDraft(A, "vencido", "sai", { storage: s, now: NOW - DRAFT_TTL_MS - 1 });
    s.setItem(draftKey(A, "quebrado"), "{");
    s.setItem(`${DRAFT_PREFIX}antigo`, "sem usuário");
    s.setItem("outra-chave", "fica");
    purgeExpiredDrafts({ storage: s, now: NOW });
    expect([...s.data.keys()].sort()).toEqual([draftKey(A, "recente"), "outra-chave"].sort());
  });

  it("storage indisponível não quebra nada", () => {
    expect(() => writeDraft(A, "c", "x", { storage: null })).not.toThrow();
    expect(readDraft(A, "c", { storage: null })).toBeNull();
    expect(() => clearAllDrafts(null)).not.toThrow();
    expect(() => purgeExpiredDrafts({ storage: null })).not.toThrow();
  });
});
