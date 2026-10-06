import { describe, it, expect } from "vitest";
import { validateFlowForActivation, reachableFromEntry, validateVariableTokens } from "./validate";

const validFlow = {
  name: "Welcome",
  trigger_type: "keyword" as const,
  trigger_config: { keywords: ["support"] },
  entry_node_id: "start",
};

const validNodes = [
  { node_key: "start", node_type: "start", config: { next_node_key: "menu" } },
  {
    node_key: "menu",
    node_type: "send_buttons",
    config: {
      text: "How can we help?",
      buttons: [
        { reply_id: "a", title: "A", next_node_key: "ho" },
        { reply_id: "b", title: "B", next_node_key: "ho" },
      ],
    },
  },
  { node_key: "ho", node_type: "handoff", config: { reason_code: "INDEFINIDO" } },
];

describe("validateFlowForActivation — happy path", () => {
  it("produces no issues on a well-formed flow", () => {
    expect(validateFlowForActivation(validFlow, validNodes)).toEqual([]);
  });
});

describe("validateFlowForActivation — flow-level", () => {
  it("flags empty name", () => {
    expect(
      validateFlowForActivation({ ...validFlow, name: "" }, validNodes),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "flow", field: "name" }),
      ]),
    );
  });

  it("flags whitespace-only name", () => {
    const issues = validateFlowForActivation(
      { ...validFlow, name: "   " },
      validNodes,
    );
    expect(issues.some((i) => i.field === "name")).toBe(true);
  });

  it("flags missing entry_node_id", () => {
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: null },
      validNodes,
    );
    expect(issues.some((i) => i.field === "entry_node_id")).toBe(true);
  });

  it("flags entry_node_id that doesn't exist in nodes", () => {
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "ghost" },
      validNodes,
    );
    expect(
      issues.some(
        (i) =>
          i.field === "entry_node_id" &&
          i.message.includes('"ghost"'),
      ),
    ).toBe(true);
  });

  it("flags empty node list", () => {
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: null },
      [],
    );
    expect(
      issues.some((i) => i.message.includes("pelo menos um nó")),
    ).toBe(true);
  });

  it("flags duplicate node_key", () => {
    const dupes = [
      { node_key: "a", node_type: "start", config: { next_node_key: "b" } },
      { node_key: "a", node_type: "end", config: {} },
      { node_key: "b", node_type: "handoff", config: { reason_code: "INDEFINIDO" } },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "a" },
      dupes,
    );
    expect(
      issues.some(
        (i) =>
          i.message.includes("Chave de nó duplicada") &&
          i.node_key === "a",
      ),
    ).toBe(true);
  });
});

describe("validateFlowForActivation — trigger", () => {
  it("flags keyword trigger with no keywords", () => {
    const issues = validateFlowForActivation(
      {
        ...validFlow,
        trigger_config: { keywords: [] },
      },
      validNodes,
    );
    expect(
      issues.some(
        (i) =>
          i.scope === "trigger" &&
          i.message.includes("pelo menos uma palavra-chave"),
      ),
    ).toBe(true);
  });

  it("flags keyword trigger missing keywords field entirely", () => {
    const issues = validateFlowForActivation(
      { ...validFlow, trigger_config: {} },
      validNodes,
    );
    expect(issues.some((i) => i.scope === "trigger")).toBe(true);
  });

  it("warns when keywords contain blanks", () => {
    const issues = validateFlowForActivation(
      {
        ...validFlow,
        trigger_config: { keywords: ["support", "", " "] },
      },
      validNodes,
    );
    expect(
      issues.some(
        (i) =>
          i.scope === "trigger" &&
          i.severity === "warning" &&
          i.message.includes("em branco"),
      ),
    ).toBe(true);
  });

  it("first_inbound_message trigger needs no config", () => {
    const issues = validateFlowForActivation(
      {
        ...validFlow,
        trigger_type: "first_inbound_message",
        trigger_config: {},
      },
      validNodes,
    );
    expect(issues.filter((i) => i.scope === "trigger")).toEqual([]);
  });
});

describe("validateFlowForActivation — nodes", () => {
  it("flags send_buttons without text", () => {
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "b" } },
      {
        node_key: "b",
        node_type: "send_buttons",
        config: {
          buttons: [{ reply_id: "x", title: "X", next_node_key: "h" }],
        },
      },
      { node_key: "h", node_type: "handoff", config: { reason_code: "INDEFINIDO" } },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some((i) => i.node_key === "b" && i.field === "text"),
    ).toBe(true);
  });

  it("flags send_buttons with zero buttons", () => {
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "b" } },
      {
        node_key: "b",
        node_type: "send_buttons",
        config: { text: "Hi", buttons: [] },
      },
      { node_key: "h", node_type: "handoff", config: { reason_code: "INDEFINIDO" } },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some(
        (i) =>
          i.node_key === "b" &&
          i.field === "buttons" &&
          i.message.includes("pelo menos um"),
      ),
    ).toBe(true);
  });

  it("flags send_buttons with more than 3 buttons (Meta limit)", () => {
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "b" } },
      {
        node_key: "b",
        node_type: "send_buttons",
        config: {
          text: "Hi",
          buttons: [
            { reply_id: "1", title: "1", next_node_key: "h" },
            { reply_id: "2", title: "2", next_node_key: "h" },
            { reply_id: "3", title: "3", next_node_key: "h" },
            { reply_id: "4", title: "4", next_node_key: "h" },
          ],
        },
      },
      { node_key: "h", node_type: "handoff", config: { reason_code: "INDEFINIDO" } },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some(
        (i) =>
          i.node_key === "b" &&
          i.field === "buttons" &&
          i.message.includes("no máximo 3"),
      ),
    ).toBe(true);
  });

  it("flags button title over 20 chars", () => {
    const longTitle = "x".repeat(21);
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "b" } },
      {
        node_key: "b",
        node_type: "send_buttons",
        config: {
          text: "Hi",
          buttons: [
            { reply_id: "1", title: longTitle, next_node_key: "h" },
          ],
        },
      },
      { node_key: "h", node_type: "handoff", config: { reason_code: "INDEFINIDO" } },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some(
        (i) =>
          i.node_key === "b" &&
          i.field === "buttons.0.title" &&
          i.message.includes("passa de 20"),
      ),
    ).toBe(true);
  });

  it("flags button pointing at non-existent next node", () => {
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "b" } },
      {
        node_key: "b",
        node_type: "send_buttons",
        config: {
          text: "Hi",
          buttons: [
            { reply_id: "1", title: "Go", next_node_key: "ghost" },
          ],
        },
      },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some(
        (i) =>
          i.field === "buttons.0.next_node_key" &&
          i.message.includes("ghost"),
      ),
    ).toBe(true);
  });

  it("flags duplicate button reply_ids", () => {
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "b" } },
      {
        node_key: "b",
        node_type: "send_buttons",
        config: {
          text: "Hi",
          buttons: [
            { reply_id: "x", title: "X1", next_node_key: "h" },
            { reply_id: "x", title: "X2", next_node_key: "h" },
          ],
        },
      },
      { node_key: "h", node_type: "handoff", config: { reason_code: "INDEFINIDO" } },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some((i) => i.message.includes("Reply id de botão duplicado")),
    ).toBe(true);
  });

  it("flags send_list with more than 10 rows total", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      reply_id: `r${i}`,
      title: `Row ${i}`,
      next_node_key: "h",
    }));
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "l" } },
      {
        node_key: "l",
        node_type: "send_list",
        config: {
          text: "Pick",
          button_label: "Pick",
          sections: [{ rows: eleven }],
        },
      },
      { node_key: "h", node_type: "handoff", config: { reason_code: "INDEFINIDO" } },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some(
        (i) =>
          i.node_key === "l" &&
          i.field === "sections" &&
          i.message.includes("no máximo 10"),
      ),
    ).toBe(true);
  });

  it("flags list row title over 24 chars", () => {
    const longTitle = "x".repeat(25);
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "l" } },
      {
        node_key: "l",
        node_type: "send_list",
        config: {
          text: "Pick",
          button_label: "Pick",
          sections: [
            {
              rows: [
                {
                  reply_id: "x",
                  title: longTitle,
                  next_node_key: "h",
                },
              ],
            },
          ],
        },
      },
      { node_key: "h", node_type: "handoff", config: { reason_code: "INDEFINIDO" } },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some((i) => i.message.includes("excede 24")),
    ).toBe(true);
  });

  it("warns about unreachable nodes", () => {
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "h" } },
      { node_key: "h", node_type: "handoff", config: { reason_code: "INDEFINIDO" } },
      // Orphaned — nothing points at it.
      { node_key: "orphan", node_type: "end", config: {} },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some(
        (i) =>
          i.node_key === "orphan" &&
          i.severity === "warning" &&
          i.message.includes("alcançável"),
      ),
    ).toBe(true);
  });

  it("warns when a handoff has no structured reason", () => {
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "h" } },
      { node_key: "h", node_type: "handoff", config: {} },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some(
        (i) =>
          i.node_key === "h" &&
          i.field === "reason_code" &&
          i.severity === "warning",
      ),
    ).toBe(true);
  });

  it("doesn't crash on unknown node_type — flags it", () => {
    const nodes = [
      { node_key: "s", node_type: "wibble", config: {} },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some((i) => i.message.includes("Tipo de nó desconhecido")),
    ).toBe(true);
  });
});

describe("validateFlowForActivation — send_media", () => {
  const baseFlow = { ...validFlow, entry_node_id: "s" };
  const nodesWith = (mediaConfig: Record<string, unknown>) => [
    { node_key: "s", node_type: "start", config: { next_node_key: "m" } },
    { node_key: "m", node_type: "send_media", config: mediaConfig },
    { node_key: "h", node_type: "handoff", config: { reason_code: "INDEFINIDO" } },
  ];

  it("passes on a fully-populated send_media node", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith({
        media_type: "document",
        media_url: "https://cdn.example/invoice.pdf",
        caption: "Your invoice",
        filename: "invoice.pdf",
        next_node_key: "h",
      }),
    );
    expect(issues).toEqual([]);
  });

  it("flags missing media_url", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith({
        media_type: "image",
        media_url: "",
        next_node_key: "h",
      }),
    );
    expect(
      issues.some((i) => i.node_key === "m" && i.field === "media_url"),
    ).toBe(true);
  });

  it("flags missing media_type", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith({
        media_url: "https://cdn.example/x.png",
        next_node_key: "h",
      }),
    );
    expect(
      issues.some((i) => i.node_key === "m" && i.field === "media_type"),
    ).toBe(true);
  });

  it("flags next_node_key pointing at a non-existent node", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith({
        media_type: "image",
        media_url: "https://cdn.example/x.png",
        next_node_key: "ghost",
      }),
    );
    expect(
      issues.some(
        (i) =>
          i.node_key === "m" &&
          i.field === "next_node_key" &&
          i.message.includes("ghost"),
      ),
    ).toBe(true);
  });

  it("flags caption exceeding 1024 chars", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith({
        media_type: "image",
        media_url: "https://cdn.example/x.png",
        caption: "x".repeat(1025),
        next_node_key: "h",
      }),
    );
    expect(
      issues.some((i) => i.node_key === "m" && i.field === "caption"),
    ).toBe(true);
  });

  it("contributes its next_node_key to reachability", () => {
    const set = reachableFromEntry(
      "s",
      nodesWith({
        media_type: "image",
        media_url: "https://cdn.example/x.png",
        next_node_key: "h",
      }),
    );
    expect(set).toEqual(new Set(["s", "m", "h"]));
  });
});

describe("reachableFromEntry", () => {
  it("walks the graph from the entry", () => {
    const set = reachableFromEntry("start", validNodes);
    expect(set.has("start")).toBe(true);
    expect(set.has("menu")).toBe(true);
    expect(set.has("ho")).toBe(true);
  });

  it("returns the entry alone when no edges lead out", () => {
    const set = reachableFromEntry("only", [
      { node_key: "only", node_type: "handoff", config: { reason_code: "INDEFINIDO" } },
    ]);
    expect(set).toEqual(new Set(["only"]));
  });

  it("survives a cycle (visited guard)", () => {
    const nodes = [
      { node_key: "a", node_type: "start", config: { next_node_key: "b" } },
      {
        node_key: "b",
        node_type: "send_buttons",
        config: {
          text: "Loop",
          buttons: [{ reply_id: "x", title: "Back", next_node_key: "a" }],
        },
      },
    ];
    const set = reachableFromEntry("a", nodes);
    expect(set).toEqual(new Set(["a", "b"]));
  });
});

describe("validateFlowForActivation — send_webchat", () => {
  const webchatNodes = (config: Record<string, unknown>) => [
    { node_key: "start", node_type: "start", config: { next_node_key: "wc" } },
    { node_key: "wc", node_type: "send_webchat", config },
    { node_key: "ho", node_type: "handoff", config: { reason_code: "INDEFINIDO" } },
  ];

  it("accepts a complete invite that continues on an existing node", () => {
    const issues = validateFlowForActivation(
      validFlow,
      webchatNodes({ message_text: "Vamos pelo chat?", button_text: "Abrir chat", next_node_key: "ho" }),
    );
    expect(issues).toEqual([]);
  });

  it("enforces Meta's 20-char button limit and a continuation node", () => {
    const issues = validateFlowForActivation(
      validFlow,
      webchatNodes({ message_text: "Oi", button_text: "x".repeat(21), next_node_key: "nope" }),
    );
    const fields = issues.filter((i) => i.node_key === "wc").map((i) => i.field);
    expect(fields).toContain("button_text");
    expect(fields).toContain("next_node_key");
  });

  it("follows the webchat continuation when checking reachability", () => {
    const reachable = reachableFromEntry(
      "start",
      webchatNodes({ message_text: "Oi", button_text: "Abrir", next_node_key: "ho" }),
    );
    expect(reachable.has("ho")).toBe(true);
  });
});

describe("validateVariableTokens", () => {
  const node = (config: Record<string, unknown>, node_type = "send_message") => ({ node_key: "msg", node_type, config });
  it("aceita {{vars.x}}", () => {
    expect(validateVariableTokens(node({ text: "Olá {{vars.nome}}" }))).toEqual([]);
  });
  it("avisa {{nome}} e {{1}} que iriam literais", () => {
    const issues = validateVariableTokens(node({ text: "Olá {{nome}}, parcela {{1}}" }));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].message).toContain("{{nome}}");
    expect(issues[0].message).toContain("{{1}}");
  });
  it("olha os valores do Definir variável e ignora o prompt da IA", () => {
    expect(validateVariableTokens(node({ assignments: [{ variable: "a", value: "{{x}}" }] }, "set_variable"))).toHaveLength(1);
    expect(validateVariableTokens(node({ system_prompt_override: "Responda {{assim}}" }, "ai_agent"))).toEqual([]);
  });
});

describe("validateFlowForActivation — token em texto nas ferramentas", () => {
  const flow = { name: "F", trigger_type: "manual" as const, trigger_config: {}, entry_node_id: "ia" };
  const aiNode = (url: string) => ({
    node_key: "ia",
    node_type: "ai_agent",
    config: { mode: "takeover", tools: [{ name: "localizar_devedor", http: { url } }] },
  });
  it("avisa token em texto", () => {
    const issues = validateFlowForActivation(flow, [aiNode("https://www.ddmacordos.com/calc/localiza_dev.php?tk=a1b2c3d4e5f6g7h8&cpf={{cpf}}")]);
    expect(issues.some((i) => i.severity === "warning" && i.message.includes("{{secret.DDM_TOKEN}}"))).toBe(true);
  });
  it("não avisa com o marcador", () => {
    const issues = validateFlowForActivation(flow, [aiNode("https://www.ddmacordos.com/calc/localiza_dev.php?tk={{secret.DDM_TOKEN}}&cpf={{cpf}}")]);
    expect(issues.some((i) => i.message.includes("token em texto"))).toBe(false);
  });
});


describe("validateFlowForActivation — modelo do ai_agent", () => {
  const flow = {
    name: "F",
    trigger_type: "manual" as const,
    trigger_config: {},
    entry_node_id: "ia",
  };

  const nodes = (model: string | null) => [
    {
      node_key: "ia",
      node_type: "ai_agent",
      config: { mode: "takeover", model },
    },
  ];

  it("aceita modelo do provider configurado", () => {
    const issues = validateFlowForActivation(
      flow,
      nodes("gpt-4.1-mini"),
      { aiProvider: "openai" },
    );
    expect(issues.some((i) => i.field === "model")).toBe(false);
  });

  it("bloqueia modelo de outro provider", () => {
    const issues = validateFlowForActivation(
      flow,
      nodes("gemini-3.8-flash"),
      { aiProvider: "openai" },
    );
    expect(
      issues.some(
        (i) =>
          i.field === "model" &&
          i.severity === "error" &&
          i.message.includes("OpenAI"),
      ),
    ).toBe(true);
  });

  it("bloqueia modelo fora do registry", () => {
    const issues = validateFlowForActivation(
      flow,
      nodes("modelo-inventado"),
      { aiProvider: "openai" },
    );
    expect(
      issues.some(
        (i) =>
          i.field === "model" &&
          i.severity === "error" &&
          i.message.includes("registry"),
      ),
    ).toBe(true);
  });

  it("aceita null para usar o padrão da conta/provider", () => {
    const issues = validateFlowForActivation(
      flow,
      nodes(null),
      { aiProvider: "openai" },
    );
    expect(issues.some((i) => i.field === "model")).toBe(false);
  });
});
