import { describe, expect, it } from "vitest";
import { convertGlobalResponder } from "./convert";
import { parseAgentConfig, validateAgentConfig } from "./schema";

const fixture = () => convertGlobalResponder({ account_id: "00000000-0000-0000-0000-00000000000a", enabled: true, api_provider: "claude" }).config;

describe("schema v1 de perfil", () => {
  it("omissão permanece omissão; zero/false e bytes são preservados", () => {
    const config = fixture(); config.llm = { provider: "claude", temperature: 0, parallel_tool_calls: false };
    expect(parseAgentConfig(config).llm).toEqual(config.llm);
    config.llm = {};
    expect(parseAgentConfig(config).llm).toEqual({});
    expect(parseAgentConfig(config)).not.toBe(config);
    expect(parseAgentConfig(config).prompt.account_content).toBe("");
  });
  it.each([null, [], {}, { schema_version: 2 }])("recusa envelope inválido %j", (value) => {
    expect(validateAgentConfig(value).success).toBe(false);
  });
  it.each([null, -0.1, 2.1, "0.7", NaN, Infinity])("recusa temperatura inválida %s sem coercion", (value) => {
    const config = fixture();
    const input = { ...config, llm: { temperature: value } };
    expect(validateAgentConfig(input).success).toBe(false);
  });
  it("recusa parâmetros desconhecidos e opt-out como opção", () => {
    const config = fixture();
    expect(validateAgentConfig({ ...config, protections: { ...config.protections, opt_out: { enabled: false } } }).success).toBe(false);
    expect(validateAgentConfig({ ...config, llm: { api_key: "segredo" } }).success).toBe(false);
    expect(validateAgentConfig({ ...config, llm: { max_tokens: 1.5 } }).success).toBe(false);
    expect(validateAgentConfig({ ...config, behavior: { ...config.behavior, max_turns: 0 } }).success).toBe(false);
  });
  it("quatro proteções são configuráveis, sem mudar o padrão das outras", () => {
    const config = fixture();
    config.protections.anti_xingamento.enabled = false;
    config.protections.anti_loop.enabled = false;
    config.protections.pedido_humano_contestacao.enabled = false;
    config.protections.pessoa_errada.enabled = false;
    expect(validateAgentConfig(config).success).toBe(true);
  });
  it("RAG é contrato desativado por padrão; habilitado exige conexão completa", () => {
    const config = fixture();
    expect(config.knowledge.rag_external.enabled).toBe(false);
    config.knowledge.rag_external.enabled = true;
    expect(validateAgentConfig(config).success).toBe(false);
    config.knowledge.rag_external.url = "https://rag.test/retrieve";
    config.knowledge.rag_external.credential = "{{cred.RAG_TOKEN}}";
    expect(validateAgentConfig(config).success).toBe(true);
    config.knowledge.rag_external.credential = "token-em-texto";
    expect(validateAgentConfig(config).success).toBe(false);
  });
  it.each(["http://rag.test", "https://user:pass@rag.test", "https://rag.test/#fragmento", "https://"]) ("recusa URL RAG insegura/inválida %s", (url) => {
    const config = fixture(); config.knowledge.rag_external.url = url;
    expect(validateAgentConfig(config).success).toBe(false);
  });
  it("ref de tool sem definição é válida; item sem ref nem definição não", () => {
    const config = fixture();
    config.tools = [{ enabled: false, tool_id: "00000000-0000-0000-0000-000000000001" }];
    expect(validateAgentConfig(config).success).toBe(true);
    config.tools = [{ enabled: true }];
    expect(validateAgentConfig(config).success).toBe(false);
  });
});

describe("conexões inertes: só constantes da plataforma (REVISAO-113 #6)", () => {
  const withConn = (llm: Record<string, unknown>) => ({ ...fixture(), connections: { ...fixture().connections, llm } });
  it("aceita o padrão convertido (endpoint/headers/platform_env da plataforma)", () => {
    expect(validateAgentConfig(fixture()).success).toBe(true);
  });
  it.each([
    ["endpoint de terceiros", { endpoint: "https://atacante.com/v1" }],
    ["header com valor livre", { headers: { Authorization: "Bearer abc" } }],
    ["platform_env desconhecida", { platform_env: ["AWS_SECRET_ACCESS_KEY"] }],
  ])("recusa %s", (_n, llm) => {
    expect(validateAgentConfig(withConn(llm)).success).toBe(false);
  });
  it("recusa endpoint do DDM alterado", () => {
    const config = fixture();
    config.legacy.ddm = { ...config.legacy.ddm, lookup_endpoint: "https://atacante.com/x" };
    expect(validateAgentConfig(config).success).toBe(false);
  });
});
