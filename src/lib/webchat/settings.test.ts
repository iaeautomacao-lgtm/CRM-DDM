import { describe, expect, it } from "vitest";
import { normalizeWebchatSettings, renderWelcome, WEBCHAT_SESSION_HOURS_MAX } from "./settings";

describe("normalizeWebchatSettings", () => {
  it("corta textos, valida cor e limita a validade", () => {
    const s = normalizeWebchatSettings({
      display_name: "  Grupo DDM  ",
      welcome_message: "",
      accent_color: "#FF5706",
      session_hours: 500,
      default_button_text: "Abrir o atendimento agora mesmo",
      default_flow_id: "nao-e-uuid",
    });
    expect(s.display_name).toBe("Grupo DDM");
    expect(s.welcome_message).toBeNull();
    expect(s.accent_color).toBe("#ff5706");
    expect(s.session_hours).toBe(WEBCHAT_SESSION_HOURS_MAX);
    expect(s.default_button_text).toHaveLength(20);
    expect(s.default_flow_id).toBeNull();
  });

  it("valores inválidos voltam ao padrão", () => {
    const s = normalizeWebchatSettings({ accent_color: "red", session_hours: "abc" });
    expect(s.accent_color).toBeNull();
    expect(s.session_hours).toBe(24);
  });
});

describe("renderWelcome", () => {
  it("padrão com e sem nome", () => {
    expect(renderWelcome(null, "Ana")).toBe("Olá, Ana! Já vamos te atender.");
    expect(renderWelcome(null, null)).toBe("Olá! Já vamos te atender.");
  });
  it("troca {nome} e ajusta a pontuação quando falta o nome", () => {
    expect(renderWelcome("Oi {nome}, tudo bem?", "Ana")).toBe("Oi Ana, tudo bem?");
    expect(renderWelcome("Oi {nome}, tudo bem?", null)).toBe("Oi, tudo bem?");
  });
});
