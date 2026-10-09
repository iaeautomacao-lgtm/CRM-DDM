import { describe, expect, it } from "vitest";

import { ACCOUNT_SETTINGS, resolveSettings, settingDef, validateBusinessHours, validateNotificationPreferences, validateSetting, validateTimezone } from "./account-config";

describe("timezone", () => {
  it("aceita nomes IANA e recusa lixo", () => {
    expect(validateTimezone("America/Sao_Paulo")).toEqual({ ok: true, value: "America/Sao_Paulo" });
    expect(validateTimezone("UTC").ok).toBe(true);
    for (const bad of ["Brasilia", "GMT-3 maluco", "", 3, null, "x".repeat(65)]) expect(validateTimezone(bad).ok).toBe(false);
  });
});

describe("business_hours", () => {
  it("normaliza e ordena os intervalos por dia; dia ausente ou vazio = sem atendimento", () => {
    const out = validateBusinessHours({ mon: [{ start: "13:00", end: "18:00" }, { start: "08:00", end: "12:00" }], sat: [] });
    expect(out).toEqual({ ok: true, value: { mon: [{ start: "08:00", end: "12:00" }, { start: "13:00", end: "18:00" }], sat: [] } });
    expect(validateBusinessHours({})).toEqual({ ok: true, value: {} });
  });

  it.each([
    ["dia inválido", { segunda: [] }, /Dia inválido/],
    ["formato", { mon: [{ start: "8:00", end: "12:00" }] }, /HH:MM/],
    ["hora impossível", { mon: [{ start: "08:00", end: "25:00" }] }, /HH:MM/],
    ["início depois do fim", { mon: [{ start: "12:00", end: "08:00" }] }, /antes do fim/],
    ["início = fim", { mon: [{ start: "08:00", end: "08:00" }] }, /antes do fim/],
    ["sobreposição", { mon: [{ start: "08:00", end: "12:00" }, { start: "11:00", end: "13:00" }] }, /sobrepor/],
    ["muitos intervalos", { mon: Array.from({ length: 6 }, (_, i) => ({ start: `0${i}:00`, end: `0${i}:30` })) }, /0 a 5/],
    ["não é objeto", [], /objeto/],
    ["intervalo não é objeto", { mon: ["08:00-12:00"] }, /HH:MM/],
  ])("recusa: %s", (_n, value, message) => {
    const out = validateBusinessHours(value);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toMatch(message);
  });

  it("intervalos encostados (12:00–12:00 de pontas) são permitidos", () => {
    expect(validateBusinessHours({ tue: [{ start: "08:00", end: "12:00" }, { start: "12:00", end: "18:00" }] }).ok).toBe(true);
  });
});

describe("notification_preferences", () => {
  it("valida só a FORMA (evento, canais conhecidos, booleanos)", () => {
    const prefs = { "conversation.assigned": { in_app: true, email: false }, sla_alert: { email: true } };
    expect(validateNotificationPreferences(prefs)).toEqual({ ok: true, value: prefs });
    expect(validateNotificationPreferences({})).toEqual({ ok: true, value: {} });
  });

  it.each([
    ["evento com nome inválido", { "Evento Ruim": { email: true } }],
    ["canal desconhecido", { a: { sms: true } }],
    ["valor não booleano", { a: { email: "sim" } }],
    ["evento sem canal", { a: {} }],
    ["evento não é objeto", { a: true }],
    ["raiz não é objeto", "x"],
    ["lista", [{ a: { email: true } }]],
  ])("recusa: %s", (_n, value) => {
    expect(validateNotificationPreferences(value).ok).toBe(false);
  });

  it("limita a 50 eventos", () => {
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`evento_${i}`, { email: true }]));
    expect(validateNotificationPreferences(many).ok).toBe(false);
    expect(validateNotificationPreferences(Object.fromEntries(Object.entries(many).slice(0, 50))).ok).toBe(true);
  });
});

describe("registro e resolução", () => {
  it("o fuso padrão é Brasília; horário e notificações não têm valor inventado", () => {
    expect(ACCOUNT_SETTINGS.map((s) => [s.key, s.default])).toEqual([["timezone", "America/Sao_Paulo"], ["business_hours", null], ["notification_preferences", {}]]);
    expect(settingDef("timezone")?.type).toBe("timezone");
    expect(settingDef("inventada")).toBeNull();
  });

  it("validateSetting: null só onde o registro permite", () => {
    expect(validateSetting(settingDef("business_hours")!, null)).toEqual({ ok: true, value: null });
    expect(validateSetting(settingDef("timezone")!, null).ok).toBe(false);
    expect(validateSetting(settingDef("timezone")!, "UTC")).toEqual({ ok: true, value: "UTC" });
  });

  it("resolveSettings: o que a conta gravou vence o padrão; source e editable corretos", () => {
    const out = resolveSettings(new Map<string, unknown>([["timezone", "America/Manaus"]]), false);
    expect(out.find((s) => s.key === "timezone")).toMatchObject({ value: "America/Manaus", source: "account", default: "America/Sao_Paulo", editable: false });
    expect(out.find((s) => s.key === "business_hours")).toMatchObject({ value: null, source: "default" });
    expect(resolveSettings(new Map(), true).every((s) => s.editable)).toBe(true);
  });
});
