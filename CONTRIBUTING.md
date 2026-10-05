# Contribuindo com o CRM DDM

Este repositório evolui um sistema operacional usado pelo Grupo DDM. Mudanças devem privilegiar correção, rastreabilidade e baixo risco de regressão.

## Fluxo

1. atualize `main`;
2. crie uma branch descritiva;
3. faça uma mudança lógica por PR;
4. adicione/ajuste testes;
5. atualize documentação se houver mudança de contrato;
6. rode os checks locais;
7. abra PR com impacto e plano de teste.

Exemplo:

```bash
git checkout main
git pull
git checkout -b fix/ai-tool-failure

npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

## Critério de pronto

Uma mudança está pronta quando:

- comportamento esperado está claro;
- edge cases relevantes estão cobertos;
- lint/typecheck/test/build passam;
- migrations foram revisadas contra o schema live quando necessário;
- segredos/PII não aparecem no diff;
- documentação acompanha mudança operacional;
- o PR explica risco e validação.

## Banco

Antes de escrever migration:

1. inspecione o schema live;
2. identifique dependências;
3. considere dados existentes;
4. prefira mudanças compatíveis e idempotentes;
5. atualize `schema:check` se o objeto virar requisito de deploy.

Nunca altere migration aplicada como forma de corrigir produção.

## WhatsApp

Meta Cloud API e WAHA possuem semânticas distintas. Preserve a bifurcação de provider quando o comportamento divergir.

Teste recebimento, envio e status no provider afetado.

## IA e tools

- resposta de LLM não substitui dados autoritativos;
- tool result é input não confiável;
- erro de integração precisa terminar em retry controlado, fallback ou handoff;
- nunca deixe run ativo indefinidamente;
- não logue segredos ou PII desnecessária.

## Concorrência

Antes de remover lock, claim, lease, debounce ou idempotency key, documente qual corrida o mecanismo previne e crie teste que demonstre que a remoção é segura.

## Commits

Prefira mensagens curtas e imperativas:

```text
fix: classify textual DDM tool errors
docs: document flow engine recovery
feat: add supervisor report scope
```

## Pull request

Inclua:

- resumo;
- motivação;
- mudanças;
- riscos;
- plano de teste;
- impacto em banco/configuração/deploy;
- screenshots quando a UI mudar.

## Segurança

Não abra issue pública com vulnerabilidade ou credencial. Consulte [`.github/SECURITY.md`](./.github/SECURITY.md).

## Documentação

O índice fica em [docs/README.md](./docs/README.md). Atualize a seção correta sempre que mudar:

- variável de ambiente;
- endpoint;
- integração;
- schema;
- operação de deploy;
- procedimento de incidente.
