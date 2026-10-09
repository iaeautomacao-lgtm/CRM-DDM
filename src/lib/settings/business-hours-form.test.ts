import { describe, expect, it } from "vitest";

import { validateBusinessHours } from "./account-config";
import { emptyHoursForm, formToHours, hoursFormEqual, hoursToForm } from "./business-hours-form";

describe("business-hours-form", () => {
  it("null/lixo vira formulário vazio", () => {
    expect(hoursToForm(null)).toEqual(emptyHoursForm());
    expect(hoursToForm([1, 2])).toEqual(emptyHoursForm());
  });

  it("ida e volta preserva só os dias com intervalo", () => {
    const api = { mon: [{ start: "08:00", end: "12:00" }, { start: "13:00", end: "18:00" }], sat: [] };
    const form = hoursToForm(api);
    expect(form.mon).toHaveLength(2);
    expect(form.sat).toEqual([]);
    expect(formToHours(form)).toEqual({ mon: api.mon });
  });

  it("descarta intervalos malformados vindos da API", () => {
    const form = hoursToForm({ tue: [{ start: "08:00" }, { start: "09:00", end: "10:00" }] });
    expect(form.tue).toEqual([{ start: "09:00", end: "10:00" }]);
  });

  it("o que o formulário gera passa no validador do servidor", () => {
    const form = emptyHoursForm();
    form.fri = [{ start: "08:00", end: "17:00" }];
    expect(validateBusinessHours(formToHours(form)).ok).toBe(true);
    form.fri = [{ start: "18:00", end: "08:00" }];
    expect(validateBusinessHours(formToHours(form)).ok).toBe(false);
  });

  it("compara ignorando dias vazios", () => {
    const a = emptyHoursForm();
    const b = emptyHoursForm();
    expect(hoursFormEqual(a, b)).toBe(true);
    b.mon = [{ start: "08:00", end: "12:00" }];
    expect(hoursFormEqual(a, b)).toBe(false);
  });
});
