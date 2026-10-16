import { describe, expect, it } from "vitest";
import { reservationBadge } from "./reservation";

const ana = { user_id: "u-ana", full_name: "Ana Souza", mention_alias: "ana" };

describe("reservationBadge", () => {
  it("sem reserva não há selo (assumida ou fechada vêm com o id nulo)", () => {
    expect(reservationBadge({ requested_agent_id: null }, "u-1")).toBeNull();
    expect(reservationBadge({}, "u-1")).toBeNull();
  });

  it("outro operador: 'Aguardando @apelido' com o nome no tooltip", () => {
    const badge = reservationBadge({ requested_agent_id: "u-ana", requested_agent: ana }, "u-1");
    expect(badge).toMatchObject({ label: "Aguardando @ana", mine: false });
    expect(badge?.title).toContain("Ana Souza");
  });

  it("o próprio operador reservado: 'Cliente pediu você' em destaque", () => {
    const badge = reservationBadge({ requested_agent_id: "u-ana", requested_agent: ana }, "u-ana");
    expect(badge).toMatchObject({ label: "Cliente pediu você", mine: true });
  });

  it("no Realtime só chega o id: resolve pelo cadastro de operadores", () => {
    const lookup = (id: string) => (id === "u-ana" ? { name: "Ana Souza", alias: "ana" } : undefined);
    expect(reservationBadge({ requested_agent_id: "u-ana" }, "u-1", lookup)?.label).toBe("Aguardando @ana");
  });

  it("objeto pronto de outra reserva é ignorado (a reserva mudou)", () => {
    const lookup = () => ({ name: "Bia Lima", alias: "bia" });
    const badge = reservationBadge({ requested_agent_id: "u-bia", requested_agent: ana }, "u-1", lookup);
    expect(badge?.label).toBe("Aguardando @bia");
  });

  it("sem apelido nem cadastro, cai no primeiro nome ou no genérico", () => {
    expect(
      reservationBadge({ requested_agent_id: "u-x", requested_agent: { user_id: "u-x", full_name: "Caio Dias", mention_alias: null } }, "u-1")?.label,
    ).toBe("Aguardando Caio");
    expect(reservationBadge({ requested_agent_id: "u-x" }, "u-1")?.label).toBe("Aguardando operador");
  });
});
