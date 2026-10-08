import { describe, expect, it } from "vitest";
import {
  AI_EXIT_TAG_DESCRIPTIONS,
  getAvailableExitTags,
  getExitTagDescription,
} from "./ai-exit-tags";
import { KNOWN_AI_EXIT_TAGS } from "@/lib/ai/exit-tags";

describe("ai-exit-tags", () => {
  describe("getExitTagDescription", () => {
    it("retorna a descrição correta para tags conhecidas", () => {
      expect(getExitTagDescription("#ACORDOFORMALIZADO")).toBe(
        "Acordo aceito e formalizado pelo cliente"
      );
      expect(getExitTagDescription("#RECUSA_CONFIRMADA")).toBe(
        "Cliente confirmou recusa explícita e definitiva da proposta"
      );
      expect(getExitTagDescription("#OPT_OUT")).toBe(
        "Cliente solicitou descadastro e não receber mais mensagens"
      );
    });

    it("retorna texto padrão para tag desconhecida", () => {
      expect(getExitTagDescription("#TAG_DESCONHECIDA")).toBe(
        "Tag de encerramento da IA"
      );
    });

    it("garante que todas as KNOWN_AI_EXIT_TAGS possuem descrição cadastrada", () => {
      for (const tag of KNOWN_AI_EXIT_TAGS) {
        expect(AI_EXIT_TAG_DESCRIPTIONS[tag]).toBeDefined();
        expect(typeof AI_EXIT_TAG_DESCRIPTIONS[tag]).toBe("string");
        expect(AI_EXIT_TAG_DESCRIPTIONS[tag].length).toBeGreaterThan(0);
      }
    });
  });

  describe("getAvailableExitTags", () => {
    it("devolve todas as tags se nenhuma estiver mapeada", () => {
      const available = getAvailableExitTags(KNOWN_AI_EXIT_TAGS, []);
      expect(available).toEqual(KNOWN_AI_EXIT_TAGS);
    });

    it("filtra as tags já mapeadas", () => {
      const mapped = ["#ACORDOFORMALIZADO", "#RECUSA_CONFIRMADA"];
      const available = getAvailableExitTags(KNOWN_AI_EXIT_TAGS, mapped);
      expect(available).not.toContain("#ACORDOFORMALIZADO");
      expect(available).not.toContain("#RECUSA_CONFIRMADA");
      expect(available).toContain("#OPT_OUT");
      expect(available.length).toBe(KNOWN_AI_EXIT_TAGS.length - 2);
    });

    it("devolve array vazio se todas estiverem mapeadas", () => {
      const available = getAvailableExitTags(KNOWN_AI_EXIT_TAGS, KNOWN_AI_EXIT_TAGS);
      expect(available).toEqual([]);
    });
  });
});
