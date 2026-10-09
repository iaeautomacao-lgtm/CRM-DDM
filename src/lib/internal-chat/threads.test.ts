import { describe, expect, it } from "vitest";
import { formatThreadTime, normalizeThreads, previewLine, sortWithThreads, unreadBadge } from "./threads";

const row = (peer: string, over: Record<string, unknown> = {}) => ({
  peer_id: peer,
  last_message_id: "m1",
  last_preview: "oi",
  last_at: "2026-10-09T12:00:00Z",
  last_sender_id: peer,
  unread_count: 0,
  last_read_at: null,
  ...over,
});

describe("internal-chat/threads", () => {
  it("normaliza linhas da RPC (bigint como string) e ignora lixo", () => {
    const m = normalizeThreads([row("a", { unread_count: "3" }), { peer_id: "" }, null, row("b", { unread_count: -1 })]);
    expect([...m.keys()]).toEqual(["a", "b"]);
    expect(m.get("a")?.unread_count).toBe(3);
    expect(m.get("b")?.unread_count).toBe(0);
    expect(normalizeThreads(undefined).size).toBe(0);
  });

  it("ordena quem tem conversa pela mais recente e mantém os demais na ordem", () => {
    const threads = normalizeThreads([
      row("b", { last_at: "2026-10-09T10:00:00Z" }),
      row("c", { last_at: "2026-10-09T15:00:00Z" }),
    ]);
    const contacts = [{ user_id: "x" }, { user_id: "b" }, { user_id: "y" }, { user_id: "c" }];
    expect(sortWithThreads(contacts, threads).map((c) => c.user_id)).toEqual(["c", "b", "x", "y"]);
  });

  it("prévia com 'Você:' quando a última mensagem é minha", () => {
    const t = normalizeThreads([row("a", { last_sender_id: "me", last_preview: "[imagem]" })]).get("a");
    expect(previewLine(t, "me")).toBe("Você: [imagem]");
    expect(previewLine(t, "outro")).toBe("[imagem]");
    expect(previewLine(undefined, "me")).toBe("");
  });

  it("formata a hora: hoje HH:mm, ontem e dd/mm", () => {
    const now = new Date(2026, 9, 9, 18, 0, 0);
    expect(formatThreadTime(new Date(2026, 9, 9, 14, 5).toISOString(), now)).toMatch(/14:05/);
    expect(formatThreadTime(new Date(2026, 9, 8, 23, 0).toISOString(), now)).toBe("ontem");
    expect(formatThreadTime(new Date(2026, 9, 1, 9, 0).toISOString(), now)).toBe("01/10");
    expect(formatThreadTime(null, now)).toBe("");
  });

  it("selo de não lidas limita em 99+", () => {
    expect(unreadBadge(4)).toBe("4");
    expect(unreadBadge(150)).toBe("99+");
  });
});
