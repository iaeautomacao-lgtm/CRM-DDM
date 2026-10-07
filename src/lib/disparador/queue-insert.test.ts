import { describe, expect, it } from "vitest";
import { insertInBlocks } from "./queue-insert";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));
const tick = () => new Promise((r) => setTimeout(r, 2));

describe("insertInBlocks", () => {
  it("blocos de 1.000 (último menor) e todas as linhas gravadas uma vez", async () => {
    const sizes: number[] = [];
    const seen: number[] = [];
    await insertInBlocks(rows(2500), async (block) => {
      sizes.push(block.length);
      seen.push(...block.map((r) => r.i));
      return { error: null };
    });
    expect(sizes.sort((a, b) => b - a)).toEqual([1000, 1000, 500]);
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 2500 }, (_, i) => i));
  });

  it("no máximo 3 blocos em voo ao mesmo tempo", async () => {
    let inFlight = 0;
    let peak = 0;
    await insertInBlocks(rows(10_000), async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
      return { error: null };
    });
    expect(peak).toBe(3);
  });

  it("onBlockDone roda a cada bloco com o acumulado", async () => {
    const written: number[] = [];
    await insertInBlocks(rows(2500), async () => ({ error: null }), {
      concurrency: 1,
      onBlockDone: (n) => void written.push(n),
    });
    expect(written).toEqual([1000, 2000, 2500]);
  });

  it("erro em um bloco aborta: nenhum bloco novo começa e o erro sobe", async () => {
    let started = 0;
    await expect(
      insertInBlocks(
        rows(20_000),
        async () => {
          started++;
          await tick();
          return started === 2 ? { error: { message: "falhou" } } : { error: null };
        },
        { concurrency: 1 },
      ),
    ).rejects.toThrow("falhou");
    expect(started).toBe(2);
  });

  it("lista vazia não chama o banco", async () => {
    let called = false;
    await insertInBlocks([], async () => {
      called = true;
      return { error: null };
    });
    expect(called).toBe(false);
  });
});
