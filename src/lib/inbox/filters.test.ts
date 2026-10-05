import { describe, expect, it } from "vitest";
import type { Conversation } from "@/types";
import {
  conversationMatchesFilters,
  DEFAULT_INBOX_FILTERS,
  parseInboxFilters,
  sanitizeSearch,
  writeInboxFilters,
} from "./filters";

const UUID = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

describe("parseInboxFilters / writeInboxFilters", () => {
  it("padrões quando a URL está vazia", () => {
    expect(parseInboxFilters(new URLSearchParams())).toEqual(DEFAULT_INBOX_FILTERS);
  });

  it("descarta valores inválidos", () => {
    const f = parseInboxFilters(new URLSearchParams("canal=telegram&linha=abc&status=foo&atendente=xyz"));
    expect(f.canal).toBeNull();
    expect(f.linha).toBeNull();
    expect(f.status).toBe("active");
    expect(f.atendente).toBeNull();
  });

  it("ida e volta preservando outros parâmetros (?c=)", () => {
    const f = { ...DEFAULT_INBOX_FILTERS, canal: "instagram" as const, atendente: "me", linha: UUID, q: " joão " };
    const qs = writeInboxFilters(new URLSearchParams("c=abc"), f);
    expect(qs.get("c")).toBe("abc");
    expect(qs.has("status")).toBe(false);
    expect(qs.get("q")).toBe("joão");
    expect(parseInboxFilters(qs)).toEqual({ ...f, q: "joão" });
  });

  it("remove filtros limpos", () => {
    const qs = writeInboxFilters(new URLSearchParams("canal=webchat&equipe=" + UUID), DEFAULT_INBOX_FILTERS);
    expect(qs.toString()).toBe("");
  });
});

describe("sanitizeSearch", () => {
  it("remove caracteres que quebrariam o filtro .or()", () => {
    expect(sanitizeSearch("ana,(id.eq.1)%*")).toBe("ana  id.eq.1");
  });
});

describe("conversationMatchesFilters", () => {
  const conv = (over: Partial<Conversation>): Conversation =>
    ({
      id: "c1",
      status: "open",
      unread_count: 0,
      assigned_agent_id: null,
      team_id: null,
      channel_type: "whatsapp",
      ...over,
    }) as Conversation;
  const ctx = { userId: "me-id", line: null };

  it("canal ausente conta como whatsapp", () => {
    const f = { ...DEFAULT_INBOX_FILTERS, canal: "whatsapp" as const };
    expect(conversationMatchesFilters(conv({ channel_type: undefined }), f, ctx)).toBe(true);
    expect(conversationMatchesFilters(conv({ channel_type: "instagram" }), f, ctx)).toBe(false);
  });

  it("atendente: minhas, sem atendente e específico", () => {
    const mine = conv({ assigned_agent_id: "me-id" });
    expect(conversationMatchesFilters(mine, { ...DEFAULT_INBOX_FILTERS, atendente: "me" }, ctx)).toBe(true);
    expect(conversationMatchesFilters(mine, { ...DEFAULT_INBOX_FILTERS, atendente: "unassigned" }, ctx)).toBe(false);
    expect(conversationMatchesFilters(mine, { ...DEFAULT_INBOX_FILTERS, atendente: OTHER }, ctx)).toBe(false);
  });

  it("linha casa por config_id, channel_id ou sessão WAHA antiga", () => {
    const f = { ...DEFAULT_INBOX_FILTERS, linha: UUID };
    const line = { id: UUID, channel_type: "whatsapp", waha_session: "sess" };
    expect(conversationMatchesFilters(conv({ config_id: UUID }), f, { ...ctx, line })).toBe(true);
    expect(conversationMatchesFilters(conv({ waha_session: "sess" }), f, { ...ctx, line })).toBe(true);
    expect(conversationMatchesFilters(conv({ config_id: OTHER }), f, { ...ctx, line })).toBe(false);
  });

  it("status: ativas, não lidas e fechadas", () => {
    expect(conversationMatchesFilters(conv({ status: "closed" }), DEFAULT_INBOX_FILTERS, ctx)).toBe(false);
    const unread = { ...DEFAULT_INBOX_FILTERS, status: "unread" as const };
    expect(conversationMatchesFilters(conv({ unread_count: 2 }), unread, ctx)).toBe(true);
    expect(conversationMatchesFilters(conv({ unread_count: 2, status: "closed" }), unread, ctx)).toBe(false);
  });

  it("cliente e campanha", () => {
    const f = { ...DEFAULT_INBOX_FILTERS, cliente: UUID, campanha: OTHER };
    expect(conversationMatchesFilters(conv({ client_id: UUID, origin_campaign_id: OTHER }), f, ctx)).toBe(true);
    expect(conversationMatchesFilters(conv({ client_id: UUID }), f, ctx)).toBe(false);
  });
});
