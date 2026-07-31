import { describe, expect, it } from "vitest";
import { classifyAcordoFormalizado } from "./acordo-tagging";
import { callLlmForAnalysis } from "./llm-shared";

/**
 * Live-LLM validation of the "Acordo Realizado" prompt against real
 * billing-adjacent edge cases. Spends real tokens against a real provider —
 * gated behind RUN_LIVE_LLM=1 so it never runs in CI or a normal
 * `vitest run` by accident.
 *
 * Usage:
 *   RUN_LIVE_LLM=1 npx vitest run src/lib/ai/acordo-tagging.live.test.ts
 *
 * Provider/key: same env vars the app's master-key fallback uses
 * (src/lib/ai/llm-shared.ts resolveActiveApiKey), selected via
 * LIVE_LLM_PROVIDER (default "openai"). No ai_config/DB read here — this
 * is the classifier in isolation, not the full pipeline.
 */

const RUN_LIVE = process.env.RUN_LIVE_LLM === "1";
const PROVIDER = process.env.LIVE_LLM_PROVIDER || "openai";

function resolveTestApiKey(provider: string): string | undefined {
  if (provider === "hermes") return process.env.OPENROUTER_API_KEY;
  if (provider === "openai") return process.env.OPENAI_API_KEY;
  if (provider === "claude") return process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (provider === "gemini") return process.env.GEMINI_API_KEY;
  return undefined;
}

const API_KEY = resolveTestApiKey(PROVIDER);
const shouldRun = RUN_LIVE && !!API_KEY;

function skipReason(): string {
  if (!RUN_LIVE) {
    return (
      "RUN_LIVE_LLM is not '1' — set RUN_LIVE_LLM=1 to run this suite (it spends real LLM tokens). " +
      "Example: RUN_LIVE_LLM=1 npx vitest run src/lib/ai/acordo-tagging.live.test.ts"
    );
  }
  return (
    `RUN_LIVE_LLM=1 is set but no API key was found for provider "${PROVIDER}". ` +
    "Set one of OPENAI_API_KEY / CLAUDE_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY, " +
    "or point LIVE_LLM_PROVIDER at a provider whose key you do have set."
  );
}

interface Case {
  id: number;
  label: string;
  expected: boolean;
  history: string;
}

// Transcripts are formatted exactly like fetchRecentHistoryText's output
// ("Cliente:"/"Atendente:" lines), so the prompt sees the same shape the
// real pipeline would feed it.
const CASES: Case[] = [
  {
    id: 1,
    label: 'Negociando juros — "talvez eu feche" (condicional)',
    expected: false,
    history: [
      "Cliente: Recebi uma cobrança de vocês, posso negociar?",
      "Atendente: Sim! Consigo parcelar em até 3x sem juros.",
      "Cliente: Consegue tirar os juros? Aí talvez eu feche.",
    ].join("\n"),
  },
  {
    id: 2,
    label: 'Adiou — "vou ver com minha esposa e te falo amanhã"',
    expected: false,
    history: [
      "Atendente: Consigo fechar hoje em 3x de R$150, o que acha?",
      "Cliente: Vou ver com minha esposa e te falo amanhã.",
    ].join("\n"),
  },
  {
    id: 3,
    label: 'Já pagou — "já paguei isso semana passada"',
    expected: false,
    history: [
      "Atendente: Identificamos uma pendência em aberto no valor de R$450.",
      "Cliente: Já paguei isso semana passada.",
    ].join("\n"),
  },
  {
    id: 4,
    label: "Só perguntou a condição, não aceitou",
    expected: false,
    history: [
      "Cliente: Quanto ficaria em 3x?",
      "Atendente: Fica R$150 cada em 3x.",
    ].join("\n"),
  },
  {
    id: 5,
    label: 'Recusou — "tá caro isso, não tenho como agora"',
    expected: false,
    history: [
      "Atendente: Consigo fechar em 5x de R$120.",
      "Cliente: Tá caro isso, não tenho como pagar agora.",
    ].join("\n"),
  },
  {
    id: 6,
    label: '"ok" isolado, sem nenhum valor/condição discutido',
    expected: false,
    history: ["Cliente: ok"].join("\n"),
  },
  {
    id: 7,
    label: 'Enrolou — "pode mandar os dados que depois eu vejo"',
    expected: false,
    history: [
      "Atendente: Posso te enviar os detalhes da proposta de acordo?",
      "Cliente: Pode mandar os dados que depois eu vejo.",
    ].join("\n"),
  },
  {
    id: 8,
    label: "Atendente propôs e cliente não respondeu",
    expected: false,
    history: [
      "Atendente: Consigo fechar em 4x de R$200, sem juros. Podemos fechar assim?",
    ].join("\n"),
  },
  {
    id: 9,
    label: 'Fechou explícito — "aceito as 3x de 150, pode gerar o boleto"',
    expected: true,
    history: [
      "Atendente: Consigo parcelar em 3x de R$150, sem juros.",
      "Cliente: Aceito as 3x de 150, pode gerar o boleto.",
    ].join("\n"),
  },
  {
    id: 10,
    label: 'Fechou — "fechado, manda o boleto"',
    expected: true,
    history: [
      "Atendente: Fica R$400 à vista.",
      "Cliente: Fechado, manda o boleto.",
    ].join("\n"),
  },
  {
    id: 11,
    label: 'Fechou — "combinado, pode fazer"',
    expected: true,
    history: [
      "Atendente: Consigo 5x de 80.",
      "Cliente: Combinado, pode fazer.",
    ].join("\n"),
  },
];

const RUNS_PER_CASE = 3;

describe("acordo-tagging — live LLM validation (RUN_LIVE_LLM=1)", () => {
  // Always runs (and shows up in the default reporter) when the live suite
  // below is skipped, so the skip reason is visible without needing
  // --reporter=verbose or reading this file's source.
  it.skipIf(shouldRun)(`SKIPPED: ${skipReason()}`, () => {
    console.warn(`[acordo-tagging.live] ${skipReason()}`);
  });

  it.skipIf(!shouldRun)(
    `classifies each of the ${CASES.length} edge cases ${RUNS_PER_CASE}x against the real "${PROVIDER}" provider and prints a summary table`,
    async () => {
      const results: { id: number; label: string; expected: boolean; runs: boolean[] }[] = [];

      for (const c of CASES) {
        const runs: boolean[] = [];
        for (let i = 0; i < RUNS_PER_CASE; i++) {
          // classifyAcordoFormalizado already never throws (it defaults to
          // false internally on any LLM/parse error) — the try/catch here
          // is only a last-resort guard so one bad run can't kill the loop.
          try {
            const decided = await classifyAcordoFormalizado(c.history, (prompt) =>
              callLlmForAnalysis(PROVIDER, API_KEY!, prompt),
            );
            runs.push(decided);
          } catch (err) {
            console.error(`[acordo-tagging.live] case ${c.id} run ${i + 1} threw unexpectedly:`, err);
            runs.push(false);
          }
        }
        results.push({ id: c.id, label: c.label, expected: c.expected, runs });
      }

      // Deliberately no expect() on the LLM's own decisions — a live-model
      // disagreement is data to report, not a reason to fail the suite.
      console.log("\n| # | Caso | Esperado | Execuções (3x) | Instável? | OK? |");
      console.log("|---|------|----------|-----------------|-----------|-----|");
      for (const r of results) {
        const runsStr = r.runs.map((v) => (v ? "true" : "false")).join(", ");
        const unstable = new Set(r.runs).size > 1;
        const allMatch = r.runs.every((v) => v === r.expected);
        console.log(
          `| ${r.id} | ${r.label} | ${r.expected} | ${runsStr} | ${unstable ? "SIM" : "não"} | ${allMatch ? "OK" : "DIVERGIU"} |`,
        );
      }

      // Structural sanity check only (every case produced 3 runs) — not a
      // judgment on what the LLM decided.
      expect(results).toHaveLength(CASES.length);
      for (const r of results) {
        expect(r.runs).toHaveLength(RUNS_PER_CASE);
      }
    },
    240_000,
  );
});
