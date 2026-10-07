import { describe, expect, it } from 'vitest';
import { validateAgentConfig } from '@/lib/ai/agents/schema';
import {
  createInitialAgentFormData,
  formDataFromPublished,
  formDataToAgentConfig,
  formDataToSavePayload,
} from './defaults';

describe('agents defaults and config conversion', () => {
  it('initial form data converts to valid agent config', () => {
    const formData = createInitialAgentFormData();
    const config = formDataToAgentConfig(formData);
    const validation = validateAgentConfig(config);
    expect(validation.success).toBe(true);
  });

  it('handles external RAG valid configuration', () => {
    const formData = createInitialAgentFormData();
    formData.knowledge.rag_external.enabled = true;
    formData.knowledge.rag_external.url = 'https://api.external-rag.com/v1/search';
    formData.knowledge.rag_external.credential = '{{cred.MY_RAG_TOKEN}}';
    formData.knowledge.rag_external.top_k = 10;
    formData.knowledge.rag_external.timeout_ms = 8000;

    const config = formDataToAgentConfig(formData);
    const validation = validateAgentConfig(config);
    expect(validation.success).toBe(true);
    expect(config.knowledge.rag_external.enabled).toBe(true);
    expect(config.knowledge.rag_external.credential).toBe('{{cred.MY_RAG_TOKEN}}');
    expect(config.knowledge.rag_external.top_k).toBe(10);
  });

  it('omits optional LLM fields when "use default" is true', () => {
    const formData = createInitialAgentFormData();
    formData.llm.temperatureUseDefault = true;
    formData.llm.maxTokensUseDefault = true;
    formData.llm.topPUseDefault = true;

    const config = formDataToAgentConfig(formData);
    expect(config.llm.temperature).toBeUndefined();
    expect(config.llm.max_tokens).toBeUndefined();
    expect(config.llm.top_p).toBeUndefined();

    formData.llm.temperatureUseDefault = false;
    formData.llm.temperature = 1.2;
    const configWithTemp = formDataToAgentConfig(formData);
    expect(configWithTemp.llm.temperature).toBe(1.2);
  });

  it('creates correct save payload', () => {
    const formData = createInitialAgentFormData();
    formData.name = 'Atendente Financeiro';
    formData.prompt_content = 'Você é um assistente de negociação.';
    formData.rules = [
      { id: '1', content: 'Nunca prometa descontos acima de 40%', enabled: true },
      { id: '2', content: 'Sempre peça confirmação do CPF', enabled: false },
    ];
    formData.tools = [
      { tool_id: '11111111-1111-1111-1111-111111111111', enabled: true },
    ];

    const savePayload = formDataToSavePayload(formData);
    expect(savePayload.name).toBe('Atendente Financeiro');
    expect(savePayload.prompt_content).toBe('Você é um assistente de negociação.');
    expect(savePayload.composition).toBe('sections_v1');
    expect(savePayload.rules).toHaveLength(2);
    expect(savePayload.tool_ids).toEqual(['11111111-1111-1111-1111-111111111111']);
    expect(savePayload.config.schema_version).toBe(1);
  });

  it('reconstructs form data from published details', () => {
    const formData = createInitialAgentFormData();
    formData.name = 'Agente Teste';
    formData.llm.temperatureUseDefault = false;
    formData.llm.temperature = 0.5;
    const config = formDataToAgentConfig(formData);

    const reconstructed = formDataFromPublished(
      { id: 'agent-1', name: 'Agente Teste', enabled: true },
      {
        version_id: 'v-1',
        version: 1,
        config,
        prompt_content: 'Instruções',
        composition: 'sections_v1',
        rules: [{ content: 'Regra 1', enabled: true, position: 0 }],
        tools: [{ id: '11111111-1111-1111-1111-111111111111', name: 'Consulta CPF', enabled: true }],
        knowledge: { selection_mode: 'legacy_account_all' },
      },
    );

    expect(reconstructed.name).toBe('Agente Teste');
    expect(reconstructed.prompt_content).toBe('Instruções');
    expect(reconstructed.rules).toHaveLength(1);
    expect(reconstructed.rules[0].content).toBe('Regra 1');
    expect(reconstructed.tools).toHaveLength(1);
    expect(reconstructed.llm.temperatureUseDefault).toBe(false);
    expect(reconstructed.llm.temperature).toBe(0.5);
  });
});

describe('editar um agente existente preserva o que o formulário não edita', () => {
  it('mantém exit_tags, mídia, conexões e parâmetros de proteção; sobrescreve só os campos do formulário', () => {
    const base = formDataToAgentConfig(createInitialAgentFormData());
    base.behavior.exit_tags = [...(base.behavior.exit_tags ?? []), 'TAG_DO_FLUXO'];
    base.media.multimodal_enabled = true;
    base.protections.anti_loop.min_messages = 7;
    base.legacy.account_id = '11111111-1111-4111-8111-111111111111';

    const form = formDataFromPublished(
      { id: 'a', name: 'A', enabled: true },
      {
        version_id: 'v',
        version: 1,
        config: base,
        prompt_content: 'p',
        composition: 'sections_v1',
        rules: [{ rule_version_id: 'rv-1', content: 'r', enabled: true, position: 0 }],
        tools: [],
        knowledge: { selection_mode: 'legacy_account_all' },
      },
    );
    expect(form.rules[0].id).toBe('rv-1');
    form.protections.anti_loop = false;
    form.behavior.max_turns = 3;

    const next = formDataToAgentConfig(form, base);
    expect(validateAgentConfig(next).success).toBe(true);
    expect(next.behavior.exit_tags).toContain('TAG_DO_FLUXO');
    expect(next.media.multimodal_enabled).toBe(true);
    expect(next.protections.anti_loop.min_messages).toBe(7);
    expect(next.protections.anti_loop.enabled).toBe(false);
    expect(next.behavior.max_turns).toBe(3);
    expect(next.legacy.account_id).toBe('11111111-1111-4111-8111-111111111111');
  });
});
