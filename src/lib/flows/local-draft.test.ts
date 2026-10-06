import { describe, expect, it } from "vitest";
import {
  FLOW_DRAFT_MAX_AGE_MS,
  clearFlowDraft,
  decideDraftOffer,
  draftDiffers,
  flowDraftKey,
  readFlowDraft,
  stableStringify,
  writeFlowDraft,
  type DraftStorage,
  type FlowDraftRecord,
} from "./local-draft";

interface S {
  name: string;
  nodes: { node_key: string; config: Record<string, unknown> }[];
}

const isS = (v: unknown): v is S =>
  !!v && typeof v === "object" && typeof (v as S).name === "string" && Array.isArray((v as S).nodes);

function memoryStorage(initial: Record<string, string> = {}): DraftStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

const throwingStorage: DraftStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

const SERVER_VERSION = "2026-10-06T12:00:00.000000+00:00";
const SERVER_TIME = Date.parse(SERVER_VERSION);
const server: S = { name: "Boas-vindas", nodes: [{ node_key: "start", config: { next_node_key: "" } }] };
const edited: S = { name: "Boas-vindas 2", nodes: server.nodes };

function record(over: Partial<FlowDraftRecord<S>> = {}): FlowDraftRecord<S> {
  return {
    v: 1,
    flowId: "f1",
    baseVersion: SERVER_VERSION,
    savedAt: SERVER_TIME + 60_000,
    conflict: false,
    state: edited,
    ...over,
  };
}

describe("storage do rascunho", () => {
  it("grava, lê e limpa por fluxo", () => {
    const storage = memoryStorage();
    expect(writeFlowDraft(storage, record())).toBe(true);
    expect(Object.keys(storage.data)).toEqual([flowDraftKey("f1")]);
    expect(readFlowDraft(storage, "f1", isS)).toEqual(record());
    expect(readFlowDraft(storage, "f2", isS)).toBeNull();
    clearFlowDraft(storage, "f1");
    expect(readFlowDraft(storage, "f1", isS)).toBeNull();
  });

  it("ignora conteúdo malformado ou de outro fluxo", () => {
    const key = flowDraftKey("f1");
    for (const raw of [
      "{quebrado",
      "null",
      JSON.stringify({ ...record(), v: 2 }),
      JSON.stringify({ ...record(), flowId: "f2" }),
      JSON.stringify({ ...record(), savedAt: "ontem" }),
      JSON.stringify({ ...record(), state: { name: 1 } }),
    ]) {
      expect(readFlowDraft(memoryStorage({ [key]: raw }), "f1", isS)).toBeNull();
    }
  });

  it("conflict ausente vira false", () => {
    const { conflict: _omit, ...rest } = record({ conflict: true });
    void _omit;
    const storage = memoryStorage({ [flowDraftKey("f1")]: JSON.stringify(rest) });
    expect(readFlowDraft(storage, "f1", isS)?.conflict).toBe(false);
  });

  it("nunca lança com storage indisponível, bloqueado ou cheio", () => {
    expect(readFlowDraft(null, "f1", isS)).toBeNull();
    expect(writeFlowDraft(null, record())).toBe(false);
    expect(() => clearFlowDraft(null, "f1")).not.toThrow();
    expect(readFlowDraft(throwingStorage, "f1", isS)).toBeNull();
    expect(writeFlowDraft(throwingStorage, record())).toBe(false);
    expect(() => clearFlowDraft(throwingStorage, "f1")).not.toThrow();
  });
});

describe("stableStringify / draftDiffers", () => {
  it("ignora a ordem das chaves e campos undefined", () => {
    expect(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"x":1,"y":2}]},"b":1}',
    );
    expect(draftDiffers({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
    expect(draftDiffers({ a: 1 }, { a: 2 })).toBe(true);
    expect(draftDiffers([1, 2], [2, 1])).toBe(true);
  });
});

describe("decideDraftOffer", () => {
  const base = { serverVersion: SERVER_VERSION, serverState: server, now: SERVER_TIME + 120_000 };

  it("sem rascunho não oferece", () => {
    expect(decideDraftOffer({ ...base, draft: null })).toMatchObject({ offer: false, reason: "none" });
  });

  it("oferece edições não salvas feitas sobre a versão atual do servidor", () => {
    expect(decideDraftOffer({ ...base, draft: record() })).toEqual({
      offer: true,
      reason: "same-version",
      basedOnOlderVersion: false,
    });
  });

  it("não oferece rascunho igual ao servidor (mesmo com chaves em outra ordem)", () => {
    const same = { nodes: [{ config: { next_node_key: "" }, node_key: "start" }], name: "Boas-vindas" };
    expect(decideDraftOffer({ ...base, draft: record({ state: same }) })).toMatchObject({
      offer: false,
      reason: "identical",
    });
  });

  it("não oferece rascunho vencido", () => {
    const draft = record({ savedAt: base.now - FLOW_DRAFT_MAX_AGE_MS - 1 });
    expect(decideDraftOffer({ ...base, draft })).toMatchObject({ offer: false, reason: "expired" });
  });

  it("servidor mudou depois: oferece só se o rascunho for mais novo", () => {
    const olderBase = "2026-10-06T11:00:00+00:00";
    expect(decideDraftOffer({ ...base, draft: record({ baseVersion: olderBase }) })).toEqual({
      offer: true,
      reason: "newer",
      basedOnOlderVersion: true,
    });
    expect(
      decideDraftOffer({ ...base, draft: record({ baseVersion: olderBase, savedAt: SERVER_TIME - 1 }) }),
    ).toMatchObject({ offer: false, reason: "obsolete" });
  });

  it("rascunho gravado num conflito continua recuperável mesmo sendo mais antigo", () => {
    const draft = record({ baseVersion: "2026-10-06T11:00:00+00:00", savedAt: SERVER_TIME - 1, conflict: true });
    expect(decideDraftOffer({ ...base, draft })).toEqual({
      offer: true,
      reason: "conflict",
      basedOnOlderVersion: true,
    });
  });

  it("versão do servidor ilegível não conta como mais antiga", () => {
    const draft = record({ baseVersion: "outra" });
    expect(decideDraftOffer({ ...base, serverVersion: "???", draft })).toMatchObject({
      offer: false,
      reason: "obsolete",
    });
  });
});
