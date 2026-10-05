import { describe, expect, it } from "vitest";
import { HISTORY_LIMIT, createHistory, historyShortcut, recordEdit, redo, undo } from "./history";

describe("histórico do editor", () => {
  it("desfaz e refaz na ordem", () => {
    let h = createHistory<string>();
    h = recordEdit(h, "a", 1000); // a → b
    h = recordEdit(h, "b", 5000); // b → c
    const u1 = undo(h, "c")!;
    expect(u1.state).toBe("b");
    const u2 = undo(u1.history, "b")!;
    expect(u2.state).toBe("a");
    expect(undo(u2.history, "a")).toBeNull();
    const r1 = redo(u2.history, "a")!;
    expect(r1.state).toBe("b");
    const r2 = redo(r1.history, "b")!;
    expect(r2.state).toBe("c");
    expect(redo(r2.history, "c")).toBeNull();
  });

  it("edições rápidas viram um passo só", () => {
    let h = createHistory<string>();
    h = recordEdit(h, "", 1000); // digitou "O"
    h = recordEdit(h, "O", 1200); // "Ol"
    h = recordEdit(h, "Ol", 1400); // "Olá"
    expect(h.past).toEqual([""]);
    expect(undo(h, "Olá")!.state).toBe("");
  });

  it("edição nova depois de desfazer apaga o refazer", () => {
    let h = createHistory<string>();
    h = recordEdit(h, "a", 1000);
    const u = undo(h, "b")!;
    const h2 = recordEdit(u.history, "a", 1100);
    expect(h2.future).toEqual([]);
    // e não se funde com o passo desfeito, mesmo dentro da janela
    expect(h2.past).toEqual(["a"]);
  });

  it("guarda no máximo HISTORY_LIMIT passos", () => {
    let h = createHistory<number>();
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) h = recordEdit(h, i, i * 10_000);
    expect(h.past.length).toBe(HISTORY_LIMIT);
    expect(h.past[0]).toBe(20);
  });
});

describe("historyShortcut", () => {
  const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }>) =>
    historyShortcut({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
  it("reconhece Ctrl/⌘+Z, Shift+Z e Ctrl+Y", () => {
    expect(k("z", { ctrlKey: true })).toBe("undo");
    expect(k("z", { metaKey: true })).toBe("undo");
    expect(k("Z", { ctrlKey: true, shiftKey: true })).toBe("redo");
    expect(k("y", { ctrlKey: true })).toBe("redo");
    expect(k("z", {})).toBeNull();
    expect(k("z", { ctrlKey: true, altKey: true })).toBeNull();
  });
});
