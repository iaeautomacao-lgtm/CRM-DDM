import { describe, expect, it } from "vitest";

import { apiKeyCreatedEvent, apiKeyRevokedEvent, passwordResetEvent } from "./security-events";

// PRD 20, 20.8 (complemento): member.password_reset, api_key.created, api_key.revoked — sem segredo.

describe("passwordResetEvent", () => {
  it("quem redefiniu a senha de quem; sem senha", () => {
    const e = passwordResetEvent({ accountId: "a1", memberProfileId: "p1", targetUserId: "u2", targetName: "Maria", actorUserId: "u1" });
    expect(e).toEqual({
      accountId: "a1",
      eventType: "action",
      resourceType: "member",
      resourceId: "p1",
      resourceLabel: "Maria",
      action: "member.password_reset",
      summary: "Senha de Maria redefinida por um administrador da organização",
      metadata: { target_user_id: "u2", reset_by_user_id: "u1" },
    });
    expect(JSON.stringify(e)).not.toMatch(/password"/i);
  });

  it("membro sem nome usa um rótulo neutro", () => {
    expect(passwordResetEvent({ accountId: "a", memberProfileId: "p", targetUserId: "u", targetName: "  ", actorUserId: "x" }).resourceLabel).toBe("Membro");
  });
});

describe("eventos de chave de API", () => {
  const base = { accountId: "a1", keyId: "k1", name: "Integração CRM", scopes: ["messages:send"], personal: false, ownerUserId: null };

  it("criada: id, nome, escopos, pessoal e validade — nada de segredo/hash", () => {
    const e = apiKeyCreatedEvent({ ...base, expiresAt: "2027-01-01T00:00:00.000Z" });
    expect(e).toMatchObject({
      accountId: "a1",
      eventType: "created",
      resourceType: "api_key",
      resourceId: "k1",
      resourceLabel: "Integração CRM",
      action: "api_key.created",
      summary: "Chave de API Integração CRM criada",
      metadata: { scopes: ["messages:send"], personal: false, owner_user_id: null, expires_at: "2027-01-01T00:00:00.000Z" },
    });
    expect(JSON.stringify(e)).not.toMatch(/plaintext|key_hash|secret/i);
  });

  it("pessoal: marcada no resumo e no metadata com o dono", () => {
    const e = apiKeyCreatedEvent({ ...base, name: "Minha", scopes: ["intelligence:read"], personal: true, ownerUserId: "u9", expiresAt: null });
    expect(e.summary).toBe("Chave de API Minha (pessoal) criada");
    expect(e.metadata).toMatchObject({ personal: true, owner_user_id: "u9" });
  });

  it("revogada: evento 'updated' com os mesmos campos", () => {
    const e = apiKeyRevokedEvent({ ...base, personal: true, ownerUserId: "u9" });
    expect(e).toMatchObject({ eventType: "updated", action: "api_key.revoked", resourceId: "k1", summary: "Chave de API Integração CRM (pessoal) revogada" });
    expect(e.metadata).toEqual({ scopes: ["messages:send"], personal: true, owner_user_id: "u9" });
  });

  it("copia os escopos (o evento não aponta para o array de quem chamou)", () => {
    const scopes = ["a:b"];
    const e = apiKeyRevokedEvent({ ...base, scopes });
    scopes.push("c:d");
    expect((e.metadata as { scopes: string[] }).scopes).toEqual(["a:b"]);
  });
});

describe('sessionRevokedEvent (PRD 24, item 7)', () => {
  it('uma sessão: só o rótulo do aparelho, sem IP/user-agent; todas as outras: contagem', async () => {
    const { sessionRevokedEvent } = await import('./security-events')
    const one = sessionRevokedEvent({ accountId: 'A', userId: 'U', sessionId: 'S', device: 'Chrome em Windows', count: 1 })
    expect(one).toMatchObject({ action: 'session.revoked', resourceType: 'session', resourceId: 'S', resourceLabel: 'Chrome em Windows', metadata: { user_id: 'U', count: 1 } })
    const all = sessionRevokedEvent({ accountId: 'A', userId: 'U', sessionId: null, device: null, count: 3 })
    expect(all).toMatchObject({ action: 'session.revoked_others', resourceId: 'U', summary: '3 outra(s) sessão(ões) encerrada(s)' })
    expect(JSON.stringify([one, all])).not.toMatch(/ip|user_agent|token/i)
  })
})
