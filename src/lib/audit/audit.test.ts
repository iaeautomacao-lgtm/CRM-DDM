import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { auditHeaders, clientIp, currentAuditInfo, signAuditHeaders } from "./context";
import { actionLabel, actorLabel, displayValue } from "./labels";

describe("clientIp", () => {
  it("x-real-ip do proxy tem prioridade", () => {
    expect(clientIp(new Headers({ "x-real-ip": "200.9.9.9", "x-forwarded-for": "1.1.1.1" }))).toBe("200.9.9.9");
  });
  it("no x-forwarded-for vale o último item (o primeiro pode ser forjado)", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 200.1.2.3" }))).toBe("200.1.2.3");
  });
  it("sem header = null", () => {
    expect(clientIp(new Headers())).toBeNull();
  });
});

describe("signAuditHeaders", () => {
  it("assina user/ip/ua/source na ordem do SQL e pula vazios", () => {
    process.env.AUDIT_HEADER_SECRET = "x".repeat(32);
    const h = { "x-audit-user-id": "u1", "x-audit-ip": "1.2.3.4", "x-audit-source": "inbox" };
    const expected = createHmac("sha256", "x".repeat(32)).update("u1\n1.2.3.4\ninbox").digest("hex");
    expect(signAuditHeaders(h)).toBe(expected);
    delete process.env.AUDIT_HEADER_SECRET;
    expect(signAuditHeaders(h)).toBeNull();
  });
});

describe("fora de uma requisição", () => {
  it("não anexa headers nem quebra", async () => {
    expect(await auditHeaders()).toEqual({});
    expect(await currentAuditInfo()).toBeNull();
  });
});

describe("rótulos", () => {
  it("ação conhecida e fallback por recurso", () => {
    expect(actionLabel({ action: "conversation.closed", event_type: "updated", resource_type: "conversation" })).toBe(
      "Conversa finalizada"
    );
    expect(actionLabel({ action: null, event_type: "created", resource_type: "contact" })).toBe("Contato — Criado");
  });
  it("autor: nome, usuário removido ou ator automático", () => {
    expect(actorLabel({ user_name: "Ana", user_id: "u", actor_type: "user" })).toBe("Ana");
    expect(actorLabel({ user_name: null, user_id: "u", actor_type: "user" })).toBe("Usuário removido");
    expect(actorLabel({ user_name: null, user_id: null, actor_type: "webhook" })).toBe("Webhook");
    expect(actorLabel({ user_name: null, user_id: null, actor_type: null })).toBe("Sistema");
  });
  it("valores legíveis", () => {
    expect(displayValue(null)).toBe("(vazio)");
    expect(displayValue(true)).toBe("Sim");
    expect(displayValue(["a"])).toBe('["a"]');
  });
});
