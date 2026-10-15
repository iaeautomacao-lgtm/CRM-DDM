import { describe, expect, it } from "vitest";
import type { Message } from "@/types";
import { rowPropsEqual, type MessageRowProps } from "./message-row";

const message = { id: "m1", conversation_id: "c1", created_at: "2026-10-15T12:00:00.000Z" } as unknown as Message;
const onReply = () => {};
const onReact = () => {};

const base = (): MessageRowProps => ({
  message,
  author: { label: "Você", className: "text-primary-text", bot: false },
  reply: { authorLabel: "Ana", preview: "oi" },
  reactions: undefined,
  campaign: { name: "Campanha", href: "/disparador/campanhas/1" },
  currentUserId: "u1",
  onReply,
  onReact,
});

describe("rowPropsEqual", () => {
  it("objetos novos com o mesmo conteúdo não renderizam de novo", () => {
    expect(rowPropsEqual(base(), base())).toBe(true);
  });
  it("mudou a mensagem, as reações ou o usuário: renderiza", () => {
    expect(rowPropsEqual(base(), { ...base(), message: { ...message } })).toBe(false);
    expect(rowPropsEqual(base(), { ...base(), reactions: [] })).toBe(false);
    expect(rowPropsEqual(base(), { ...base(), currentUserId: "u2" })).toBe(false);
  });
  it("mudou autor, citação ou campanha: renderiza", () => {
    expect(rowPropsEqual(base(), { ...base(), author: null })).toBe(false);
    expect(rowPropsEqual(base(), { ...base(), reply: { authorLabel: "Ana", preview: "outra" } })).toBe(false);
    expect(rowPropsEqual(base(), { ...base(), campaign: { name: "Campanha", href: null } })).toBe(false);
  });
  it("função nova (não estável) renderiza", () => {
    expect(rowPropsEqual(base(), { ...base(), onReact: () => {} })).toBe(false);
  });
});
