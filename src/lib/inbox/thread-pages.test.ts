import { beforeEach, describe, expect, it } from "vitest";
import type { Message } from "@/types";
import {
  THREAD_CACHE_SIZE,
  cacheThread,
  clearCachedThread,
  getCachedThread,
  mergeLatestPage,
  prependOlder,
} from "./thread-pages";

const msg = (id: string, minute: number): Message =>
  ({
    id,
    conversation_id: "c1",
    created_at: `2026-10-15T12:${String(minute).padStart(2, "0")}:00.000Z`,
    received_at: `2026-10-15T12:${String(minute).padStart(2, "0")}:00.000Z`,
  }) as unknown as Message;

const ids = (ms: Message[]) => ms.map((m) => m.id);

describe("mergeLatestPage", () => {
  it("mantém as antigas já carregadas quando há sobreposição", () => {
    const existing = [msg("a", 1), msg("b", 2), msg("c", 3), msg("d", 4)];
    const fetched = [msg("c", 3), msg("d", 4), msg("e", 5)];
    expect(ids(mergeLatestPage(existing, fetched))).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("descarta as antigas quando ficaria um buraco (nada em comum)", () => {
    const existing = [msg("a", 1), msg("b", 2)];
    const fetched = [msg("x", 10), msg("y", 11)];
    expect(ids(mergeLatestPage(existing, fetched))).toEqual(["x", "y"]);
  });
  it("troca as otimistas pelas reais e trata lista vazia", () => {
    const existing = [msg("a", 1), { ...msg("temp-1", 2) }];
    expect(ids(mergeLatestPage(existing, [msg("a", 1), msg("b", 2)]))).toEqual(["a", "b"]);
    expect(mergeLatestPage(existing, [])).toEqual([]);
  });
});

describe("prependOlder", () => {
  it("põe na frente, ordenado e sem repetir", () => {
    const existing = [msg("c", 3), msg("d", 4)];
    expect(ids(prependOlder(existing, [msg("a", 1), msg("b", 2), msg("c", 3)]))).toEqual(["a", "b", "c", "d"]);
  });
  it("não muda nada quando não há novidade", () => {
    const existing = [msg("c", 3)];
    expect(prependOlder(existing, [msg("c", 3)])).toBe(existing);
  });
});

describe("memória das conversas", () => {
  beforeEach(() => clearCachedThread());

  it("guarda sem as otimistas e devolve", () => {
    cacheThread("c1", [msg("a", 1), msg("temp-9", 2)]);
    expect(ids(getCachedThread("c1") ?? [])).toEqual(["a"]);
    expect(getCachedThread("zzz")).toBeNull();
  });
  it("não guarda conversa vazia", () => {
    cacheThread("c1", [msg("a", 1)]);
    cacheThread("c1", []);
    expect(getCachedThread("c1")).toBeNull();
  });
  it("expulsa a menos usada ao passar do limite", () => {
    for (let i = 0; i < THREAD_CACHE_SIZE; i++) cacheThread(`c${i}`, [msg(`m${i}`, 1)]);
    getCachedThread("c0"); // c0 volta a ser a mais recente
    cacheThread("novo", [msg("n", 1)]);
    expect(getCachedThread("c1")).toBeNull();
    expect(getCachedThread("c0")).not.toBeNull();
  });
});
