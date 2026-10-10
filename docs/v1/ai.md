# IA e agentes

## Configuração

`ai_config` live contém provider, chave, prompt, flags multimodal/search e ElevenLabs.

No baseline live **não existe coluna `api_model`**.

## Providers

- OpenAI
- Gemini
- Claude
- Hermes/OpenRouter

## Modelo por nó

`AiAgentNodeConfig.model` é opcional.

Prioridade:

```text
modelo do nó
 -> ai_config.api_model, se existir em ambiente futuro
 -> default do provider
```

A V1 restringe o modelo ao provider configurado na conta.

Defaults do registry:

- OpenAI: `gpt-4o-mini`
- Gemini: `gemini-3.8-flash`
- Claude: `claude-sonnet-5-5`
- Hermes: `nousresearch/hermes-3-llama-3.1-405b`

## Execução

```text
inbound
 -> debounce/claim
 -> ai_config
 -> resolver provider/model
 -> prompt + histórico
 -> guards
 -> LLM
 -> tool loop
 -> exit tag
 -> persistir mensagem
 -> telemetria
```

## Tools

Cada tool possui nome, descrição, parâmetros, método HTTP, URL, headers e body template.

Segredos devem usar placeholders server-side. Tokens inline são detectados pelo validador.

## DDM Acordos

A IA usa integração de cobrança para localizar devedor, consultar débitos e formalizar acordo. Falhas transitórias podem ter retry; falhas definitivas devem levar a saída estruturada/handoff.

## Recovery e proteção

A V1 contém:

- claim/release da mensagem;
- debounce;
- retry seguro antes de efeito externo;
- heartbeat;
- vigia de IA;
- anti-abuso;
- anti-loop;
- fallback de resposta vazia;
- recovery de recusa;
- classificação de erro de tool;
- saída por instabilidade.

## Prompt e telemetria

`ai_prompt_versions` versiona prompts e `ai_decisions.prompt_version` correlaciona decisões.

`ai_decisions` também registra model, node, tool, exit code, handoff e reason.

## Limite arquitetural

Não existe multi-provider por nó com credenciais independentes. A conta continua tendo um provider principal.
