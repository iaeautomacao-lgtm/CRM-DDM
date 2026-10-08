import { describe, expect, it } from 'vitest';
import { channelLabel, loadChannelIdentities, sortChannels } from './channel-label';
import { fakeDb } from './fake-db.test-helper';

const ACC = 'acc-1';
const META = { id: '1d3a9c52-0000-0000-0000-000000000001', account_id: ACC, provider: 'meta', habilitado: true, display_phone_number: '+55 27 3030-9159', phone_number_id: '123456', waha_session: null };
const WAHA = { id: '9f8e7d6c-0000-0000-0000-000000000002', account_id: ACC, provider: 'waha', habilitado: true, display_phone_number: null, phone_number_id: 'x', waha_session: 'sessao_ddm' };

describe('channelLabel', () => {
  it('Meta: nome e telefone da Meta (channel_health) vencem o que está gravado em whatsapp_config', () => {
    const id = channelLabel(META, { verified_name: 'Grupo DDM Assessoria', display_phone_number: '+55 27 3030-9180', checked_at: '2026-10-08T10:00:00Z', last_error: null });
    expect(id).toMatchObject({ name: 'Grupo DDM Assessoria', phone: '+55 27 3030-9180', connected: true, label: 'Grupo DDM Assessoria · +55 27 3030-9180' });
  });

  it('Meta sem leitura: "Meta sem nome", telefone gravado, nunca pedaço de UUID', () => {
    const id = channelLabel(META, null);
    expect(id.name).toBe('Meta sem nome');
    expect(id.phone).toBe('+55 27 3030-9159');
    expect(id.connected).toBeNull();
    expect(id.label).not.toContain(META.id.slice(0, 8));
  });

  it('telefone cai para phone_number_id quando não há display em lugar nenhum', () => {
    expect(channelLabel({ ...META, display_phone_number: null }, null).phone).toBe('123456');
  });

  it('WAHA usa waha_session como nome', () => {
    expect(channelLabel(WAHA, null).name).toBe('sessao_ddm');
    expect(channelLabel({ ...WAHA, waha_session: ' ' }, null).name).toBe('WAHA sem nome');
  });

  it('último poll com erro → Desconectado', () => {
    const id = channelLabel(META, { checked_at: '2026-10-08T10:00:00Z', last_error: 'Token expirado' });
    expect(id.connected).toBe(false);
    expect(id.connectionError).toBe('Token expirado');
  });
});

describe('sortChannels / loadChannelIdentities', () => {
  it('habilitados primeiro, depois por nome', () => {
    const list = sortChannels([
      { enabled: false, name: 'A' },
      { enabled: true, name: 'Z' },
      { enabled: true, name: 'B' },
    ]);
    expect(list.map((c) => c.name)).toEqual(['B', 'Z', 'A']);
  });

  it('junta whatsapp_config + channel_health e ordena', async () => {
    const { db } = fakeDb({
      whatsapp_config: [{ ...META, habilitado: false }, { ...WAHA }],
      channel_health: [{ session_id: META.id, account_id: ACC, verified_name: 'Grupo DDM', display_phone_number: '+55 27 3030-9180', checked_at: '2026-10-08T10:00:00Z' }],
    });
    const list = await loadChannelIdentities(db, ACC);
    expect(list.map((c) => c.id)).toEqual([WAHA.id, META.id]);
    expect(list[1]).toMatchObject({ name: 'Grupo DDM', phone: '+55 27 3030-9180', enabled: false });
  });

  it('sem channel_health (migration 190/193 pendente) segue só com whatsapp_config', async () => {
    const { db } = fakeDb({ whatsapp_config: [{ ...META }] }, ['channel_health']);
    const list = await loadChannelIdentities(db, ACC);
    expect(list[0]).toMatchObject({ name: 'Meta sem nome', phone: '+55 27 3030-9159', connected: null });
  });

  it('um número só (sessionId) e outra conta não aparece', async () => {
    const { db } = fakeDb({ whatsapp_config: [{ ...META }, { ...WAHA }] });
    expect(await loadChannelIdentities(db, ACC, { sessionId: WAHA.id })).toHaveLength(1);
    expect(await loadChannelIdentities(db, 'outra', { sessionId: WAHA.id })).toHaveLength(0);
  });
});
