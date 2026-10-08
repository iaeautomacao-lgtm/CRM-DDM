import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  META_ERROR_CATALOG,
  describeMetaError,
  lookupMetaError,
  metaCodesWhere,
  reportUnknownMetaCode,
  resetUnknownMetaCodes,
} from "./meta-error-catalog";
import { AUTO_PAUSE_META_CODES } from "./auto-pause";
import { META_RATE_LIMIT_CODES } from "./provider-signals";
import { RATE_LIMIT_ERROR_CODES, detectRateLimitErrors, rateLimitErrorCount } from "./desempenho";
import { classificarTipoErro, extrairCodigoMetaErro, normalizarErroMeta } from "./normalize-meta-error";
import { isDefinitiveRejection, isInvalidPhoneError } from "./processQueue";
import { MetaApiError } from "@/lib/whatsapp/meta-api";

const sorted = (set: Iterable<number>) => [...set].sort((a, b) => a - b);

describe("catálogo único de erros da Meta", () => {
  it("estrutura: sem código repetido, todo código com texto e ação em português, classe válida", () => {
    const codes = META_ERROR_CATALOG.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const entry of META_ERROR_CATALOG) {
      expect(entry.significado.length).toBeGreaterThan(10);
      expect(entry.acao.length).toBeGreaterThan(5);
      expect(["destinatario", "campanha_template", "canal_conta", "limite", "transitorio", "janela24h"]).toContain(entry.classe);
    }
  });

  // As listas do motor DERIVAM do catálogo, mas o comportamento tem que ser EXATAMENTE o de antes
  // (conjuntos literais copiados do código anterior ao catálogo).
  describe("derivação sem mudar o comportamento de retry/pausa/freio", () => {
    it("rejeição definitiva sem retry (antes: META_PERMANENT_CODES)", () => {
      expect(sorted(metaCodesWhere((e) => e.permanente === true))).toEqual(
        sorted([131026, 131031, 131047, 131051, 368, 190, 131008, 131009, 132000, 132001]),
      );
    });
    it("número inválido → escada de telefones (antes: META_INVALID_PHONE_CODES)", () => {
      expect(sorted(metaCodesWhere((e) => e.numeroInvalido === true))).toEqual(sorted([131030, 131045, 131021]));
      for (const code of [131030, 131045, 131021]) expect(isInvalidPhoneError(new MetaApiError("x", code, 400))).toBe(true);
      expect(isInvalidPhoneError(new MetaApiError("x", 131026, 400))).toBe(false);
    });
    it("freio do número (antes: META_RATE_LIMIT_CODES)", () => {
      expect(sorted(META_RATE_LIMIT_CODES)).toEqual(sorted([4, 80007, 130429, 131048, 131056]));
    });
    it("pausa automática (antes: AUTO_PAUSE_META_CODES, já com os 8 códigos de campanha da #131)", () => {
      expect(sorted(AUTO_PAUSE_META_CODES)).toEqual(
        sorted([190, 368, 131005, 131031, 131042, 131008, 131009, 131047, 131051, 132000, 132001, 132005, 132007, 132012, 132015, 132016, 133010]),
      );
    });
    it("rejeição definitiva do envio continua só para HTTP < 500 (códigos 5xx seguem incertos)", () => {
      expect(isDefinitiveRejection(new MetaApiError("x", 131026, 400))).toBe(true);
      expect(isDefinitiveRejection(new MetaApiError("x", null, 503))).toBe(false);
    });
  });

  describe("textos corrigidos (F20)", () => {
    it("131026 é 'não entregável', NÃO janela de 24h (essa é a 131047)", () => {
      const t = normalizarErroMeta("Meta: Message undeliverable (code 131026)");
      expect(t).toMatch(/não entregável/i);
      expect(t).not.toMatch(/janela de 24h encerrada/i);
      expect(normalizarErroMeta("(code 131047)")).toMatch(/janela de 24h/i);
    });
    it("131049 é limite/engajamento de marketing, NÃO 'remetente não registrado'", () => {
      const t = normalizarErroMeta("(#131049) x");
      expect(t).toMatch(/ecossistema|marketing/i);
      expect(t).not.toMatch(/remetente não registrado/i);
      expect(lookupMetaError(131049)?.classe).toBe("destinatario");
    });
    it("131053 é problema de mídia, NÃO limite de tier", () => {
      const t = normalizarErroMeta("(code 131053)");
      expect(t).toMatch(/mídia/i);
      expect(t).not.toMatch(/tier/i);
    });
    it("131045 é registro/certificado do REMETENTE e continua com a escada de telefones", () => {
      const t = normalizarErroMeta("(code 131045)");
      expect(t).toMatch(/remetente/i);
      expect(lookupMetaError(131045)).toMatchObject({ numeroInvalido: true });
    });
    it("132000 = quantidade de parâmetros; 132001 = template inexistente (antes estavam trocados)", () => {
      expect(normalizarErroMeta("(code 132000)")).toMatch(/número de parâmetros/i);
      expect(normalizarErroMeta("(code 132001)")).toMatch(/inexistente/i);
      expect(normalizarErroMeta("(code 132001)")).not.toMatch(/pausado/i);
    });
    it("códigos que o painel não explicava agora têm texto; não-Meta e desconhecido seguem crus", () => {
      for (const code of [131009, 131005, 132015, 132016, 133010, 190, 368, 130429, 80007]) {
        expect(normalizarErroMeta(`(code ${code})`)).not.toContain("code");
      }
      expect(normalizarErroMeta("WhatsApp WAHA connection is not active")).toBe("WhatsApp WAHA connection is not active");
      expect(normalizarErroMeta("Meta: x (code 999999)")).toBe("Meta: x (code 999999)");
      expect(normalizarErroMeta(null)).toBe("Falha desconhecida");
    });
    it("extrairCodigoMetaErro e classificarTipoErro seguem iguais", () => {
      expect(extrairCodigoMetaErro("Meta: x (code 131049)")).toBe(131049);
      expect(extrairCodigoMetaErro("(#131008) y")).toBe(131008);
      expect(classificarTipoErro("(code 131008)")).toBe("Variável vazia");
      expect(classificarTipoErro("(code 131047)")).toBe("Janela 24h");
    });
  });

  describe("código desconhecido: comportamento atual + aviso 'código novo'", () => {
    beforeEach(() => resetUnknownMetaCodes());
    it("describeMetaError devolve classe 'desconhecido' sem nenhuma flag", () => {
      const d = describeMetaError(999999);
      expect(d.classe).toBe("desconhecido");
      expect(d.permanente ?? false).toBe(false);
      expect(d.freio ?? false).toBe(false);
      expect(d.pausaAutomatica ?? false).toBe(false);
      expect(describeMetaError(null).classe).toBe("desconhecido");
    });
    it("avisa 1× por código novo; conhecido, nulo e repetido não avisam; falha no aviso não lança", () => {
      const emit = vi.fn();
      expect(reportUnknownMetaCode(999999, emit)).toBe(true);
      expect(reportUnknownMetaCode(999999, emit)).toBe(false);
      expect(reportUnknownMetaCode(131026, emit)).toBe(false);
      expect(reportUnknownMetaCode(null, emit)).toBe(false);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(() => reportUnknownMetaCode(888888, () => { throw new Error("log fora do ar"); })).not.toThrow();
    });
  });

  describe("painel de Desempenho deriva do catálogo (e agora enxerga as chaves reais da telemetria)", () => {
    it("lista = 429 + todo código com freio", () => {
      expect([...RATE_LIMIT_ERROR_CODES]).toEqual(["429", "4", "80007", "130429", "131048", "131056"]);
    });
    it("telemetria grava 'meta:<código>' / 'meta:http_429' / 'waha:429'; chave pura também vale", () => {
      expect(rateLimitErrorCount({ "meta:131056": 3, "131056": 2 }, "131056")).toBe(5);
      expect(rateLimitErrorCount({ "meta:http_429": 1, "waha:429": 2, "429": 4 }, "429")).toBe(7);
      expect(detectRateLimitErrors({ "meta:130429": 1, "meta:131048": 2, "waha:503": 9 })).toEqual(["130429", "131048"]);
      expect(detectRateLimitErrors({ "429": 3, "500": 1 })).toEqual(["429"]);
    });
  });

  // Se alguém usar um código da Meta no código sem catalogar, este teste falha apontando o arquivo.
  describe("todo código usado no código está no catálogo", () => {
    const ROOTS = [resolve(process.cwd(), "src/lib/disparador"), resolve(process.cwd(), "src/lib/whatsapp/meta-api.ts"), resolve(process.cwd(), "src/app/api/whatsapp/webhook/route.ts")];
    // Códigos da Meta (família 13xxxx) e os de 3 dígitos/avulsos que o motor trata.
    const CODE_RE = /\b(13[0-3]\d{3}|80007)\b/g;
    // Referências legítimas que não são "códigos tratados" (comentários de doc, números de teste etc.).
    const IGNORE_FILES = /(\.test\.ts|meta-error-catalog\.ts|\.sql\.test\.ts)$/;

    function walk(path: string): string[] {
      const st = statSync(path);
      if (st.isFile()) return [path];
      return readdirSync(path).flatMap((f) => walk(join(path, f)));
    }

    it("varre o código-fonte e exige entrada no catálogo", () => {
      const missing: string[] = [];
      for (const root of ROOTS) {
        for (const file of walk(root)) {
          if (!file.endsWith(".ts") || IGNORE_FILES.test(file)) continue;
          const text = readFileSync(file, "utf8");
          for (const match of text.matchAll(CODE_RE)) {
            const code = Number(match[1]);
            if (!lookupMetaError(code)) missing.push(`${file.replace(process.cwd(), "")}: ${code}`);
          }
        }
      }
      expect(missing).toEqual([]);
    });
  });
});
