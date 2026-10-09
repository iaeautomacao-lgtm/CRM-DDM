// Integrações (redesenho DDM): abas por papel, menu lateral e helpers da aba Webhooks.
import { describe, expect, it } from 'vitest';

import { resolveSection, showInRail, visibleIntegrationTabs } from '../settings-sections';
import { displayUrl, endpointHealth } from './webhooks-settings';

describe('abas de Integrações por papel', () => {
  it('proprietário vê todas; admin sem Provedores de IA; supervisor sem Webhooks; operador só chaves de API', () => {
    expect(visibleIntegrationTabs('owner')).toEqual(['api', 'secrets', 'tools', 'webhooks', 'ai', 'api-docs']);
    expect(visibleIntegrationTabs('admin')).toEqual(['api', 'secrets', 'tools', 'webhooks', 'api-docs']);
    expect(visibleIntegrationTabs('supervisor')).toEqual(['api', 'secrets', 'tools', 'api-docs']);
    expect(visibleIntegrationTabs('agent')).toEqual(['api']);
  });

  it('o menu mostra "Integrações" no lugar das abas; os links antigos continuam válidos', () => {
    expect(showInRail('integrations', 'admin')).toBe(true);
    for (const tab of ['api', 'secrets', 'tools', 'webhooks', 'ai', 'api-docs'] as const) {
      expect(showInRail(tab, 'owner')).toBe(false);
      expect(resolveSection(tab)).toBe(tab);
    }
    expect(resolveSection('integrations')).toBe('integrations');
  });
});

describe('Webhooks: situação e URL na lista', () => {
  it('pausado, falhando (com contagem) e ativo — sempre com texto', () => {
    expect(endpointHealth({ status: 'paused', consecutive_failures: 3 })).toEqual({ label: 'Pausado', tone: 'mute' });
    expect(endpointHealth({ status: 'active', consecutive_failures: 1 })).toEqual({ label: '1 falha seguida', tone: 'warn' });
    expect(endpointHealth({ status: 'active', consecutive_failures: 4 })).toEqual({ label: '4 falhas seguidas', tone: 'warn' });
    expect(endpointHealth({ status: 'active', consecutive_failures: 0 })).toEqual({ label: 'Ativo', tone: 'ok' });
  });

  it('mostra host + caminho, sem a query (pode ter token de quem integra)', () => {
    expect(displayUrl('https://erp.example.com/hooks/crm?token=segredo')).toBe('erp.example.com/hooks/crm');
    expect(displayUrl('https://erp.example.com/')).toBe('erp.example.com');
    expect(displayUrl('não é url')).toBe('não é url');
  });
});
