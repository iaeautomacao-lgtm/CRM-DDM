import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  // tabela → ids que existem NA conta
  owned: {} as Record<string, string[]>,
  failTable: null as string | null,
}));

vi.mock("./admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => ({
      select: (column: string) => ({
        eq: (_col: string, accountId: string) => ({
          in: async (_c: string, ids: string[]) => {
            if (db.failTable === table) return { data: null, error: { message: "boom" } };
            expect(accountId).toBe("acc-1");
            const have = db.owned[table] ?? [];
            return { data: ids.filter((i) => have.includes(i)).map((i) => ({ [column]: i })), error: null };
          },
        }),
      }),
    }),
  }),
}));

import { collectAutomationRefs, validateAutomationRefs } from "./step-refs";
import type { BuilderStepInput } from "./steps-tree";

const steps: BuilderStepInput[] = [
  { step_type: "add_tag", step_config: { tag_id: "tag-1" } },
  { step_type: "assign_conversation", step_config: { agent_id: "agent-1" } },
  {
    step_type: "condition",
    step_config: {},
    branches: {
      yes: [{ step_type: "create_deal", step_config: { pipeline_id: "pipe-1", stage_id: "stage-1" } }],
      no: [{ step_type: "close_conversation", step_config: { outcome_tag_id: "tag-2" } }],
    },
  },
  { step_type: "send_message", step_config: { text: "oi" } },
];

describe("collectAutomationRefs", () => {
  it("junta gatilho, passos e ramos da condição", () => {
    const refs = collectAutomationRefs({ tag_id: "tag-0" }, steps);
    expect([...refs.tags].sort()).toEqual(["tag-0", "tag-1", "tag-2"]);
    expect([...refs.profiles]).toEqual(["agent-1"]);
    expect([...refs.pipelines]).toEqual(["pipe-1"]);
    expect([...refs.pipeline_stages]).toEqual(["stage-1"]);
  });

  it("ignora config vazia ou sem ids", () => {
    const refs = collectAutomationRefs(null, [{ step_type: "add_tag", step_config: { tag_id: "" } }]);
    expect(refs.tags.size).toBe(0);
  });
});

describe("validateAutomationRefs", () => {
  beforeEach(() => {
    db.owned = {
      tags: ["tag-0", "tag-1", "tag-2"],
      profiles: ["agent-1"],
      pipelines: ["pipe-1"],
      pipeline_stages: ["stage-1"],
    };
    db.failTable = null;
  });

  it("aceita quando tudo é da conta", async () => {
    expect(await validateAutomationRefs("acc-1", { tag_id: "tag-0" }, steps)).toBeNull();
  });

  it("recusa etiqueta de outra conta", async () => {
    db.owned.tags = ["tag-1"];
    expect(await validateAutomationRefs("acc-1", undefined, steps)).toMatch(/etiqueta/);
  });

  it("recusa agente de outra conta", async () => {
    db.owned.profiles = [];
    expect(await validateAutomationRefs("acc-1", undefined, steps)).toMatch(/agente/);
  });

  it("recusa etapa de funil de outra conta", async () => {
    db.owned.pipeline_stages = [];
    expect(await validateAutomationRefs("acc-1", undefined, steps)).toMatch(/etapa/);
  });

  it("falha de consulta bloqueia (fail-closed)", async () => {
    db.failTable = "tags";
    expect(await validateAutomationRefs("acc-1", undefined, steps)).toMatch(/validar/);
  });

  it("sem referências não consulta nada", async () => {
    db.failTable = "tags";
    expect(
      await validateAutomationRefs("acc-1", {}, [{ step_type: "send_message", step_config: { text: "x" } }]),
    ).toBeNull();
  });
});
