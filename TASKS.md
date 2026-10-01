# Estado Atual do Projeto — CRM-DDM

Atualizado em: 2026-10-01

## Em Produção (estável)
- Disparador: campanha, monitor, blacklist, modo segmentado
- BEN v3 + Aleh v2: triagem e negociação via Flow Builder
- API v1.7: text→caption, salvar_bd, media_url
- RLS migration 117: agente vê só conversas atribuídas a ele
- max_simultaneous_chats por operador (migration 116)

## Bugs Conhecidos / Workarounds Ativos
- `app_secret` salvo via UI chega em plaintext (bypass da criptografia) — workaround: salvar direto no banco
- `/api/v1/disparador/campaigns` não usa `startCampaign()` — não tem filtro de import_draft_id
- Race condition BEN→Aleh: `hasRunLeftNodeSnapshot` implementado mas eficácia não 100% confirmada

## Pendente / Backlog
- [ ] `team_id` nos nós de handoff do Flow Builder (hoje usa `selectAnyAgentForAccount` que pode retornar null)
- [ ] Confirmar se `/api/conversations/retry-assignment` cron está agendado em produção
- [ ] Migração Supabase Cloud → Self-Hosted (planejamento em andamento)
- [ ] Apresentação para supervisores (Disparador e Settings ainda não documentados)
- [ ] Documentação de variáveis de ambiente

## Decisões de Arquitetura Já Tomadas (não reverter)
- WAHA e Meta têm caminhos separados em toda a stack — incompatíveis por design
- Substituição de `{{N}}` para WAHA acontece no enqueue (startCampaign.ts), não no processamento
- Contatos de campanha sem `tags_filtro` são restritos ao `import_draft_id` quando existe
- `||` substituído por `??` para defaults numéricos após bug com `intervalo_min=0`
