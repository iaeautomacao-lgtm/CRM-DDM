// Carteira (372) na API de contatos: o nome do dono é lido SEMPRE do perfil da mesma conta do contato (revisão de segurança 16/10, M2).
// Um owner_user_id apontando para usuário de outra conta não vaza o nome nem o id.
import { describe, expect, it } from 'vitest';
import { createMemoryDb, type SimTables } from '@/lib/flows/simulator/memory-db';
import { loadExtras } from './contacts-db';

const A = 'acc-a';
const B = 'acc-b';

function db(tables: SimTables) {
  return createMemoryDb({ tables, clock: { last: 0 } }) as never;
}
const row = (id: string) => ({ id, phone: '+5511', name: id, email: null, company: null, instituicao: null, cpf: null, created_at: null, updated_at: null });

describe('loadExtras → owner', () => {
  it('dono da mesma conta aparece com id e nome', async () => {
    const t: SimTables = {
      contacts: [{ id: 'c1', account_id: A, owner_user_id: 'u1' }],
      profiles: [{ user_id: 'u1', account_id: A, full_name: '  Ana  ' }],
    };
    const m = await loadExtras(db(t), [row('c1')]);
    expect(m.get('c1')?.owner).toEqual({ id: 'u1', name: 'Ana' });
  });

  it('dono que é de OUTRA conta: owner fica nulo (nem id nem nome vazam)', async () => {
    const t: SimTables = {
      contacts: [{ id: 'c1', account_id: A, owner_user_id: 'u-b' }],
      profiles: [{ user_id: 'u-b', account_id: B, full_name: 'Pessoa de fora' }],
    };
    const m = await loadExtras(db(t), [row('c1')]);
    expect(m.get('c1')?.owner).toBeNull();
    expect(JSON.stringify([...m.values()])).not.toContain('Pessoa de fora');
  });

  it('contatos de contas diferentes na mesma lista: cada um resolve o dono na sua conta', async () => {
    const t: SimTables = {
      contacts: [
        { id: 'c1', account_id: A, owner_user_id: 'u1' },
        { id: 'c2', account_id: B, owner_user_id: 'u1' }, // mesmo usuário, mas o perfil dele é da conta A
      ],
      profiles: [{ user_id: 'u1', account_id: A, full_name: 'Ana' }],
    };
    const m = await loadExtras(db(t), [row('c1'), row('c2')]);
    expect(m.get('c1')?.owner).toEqual({ id: 'u1', name: 'Ana' });
    expect(m.get('c2')?.owner).toBeNull();
  });

  it('dono com nome vazio: "Atendente"; contato sem dono: nulo', async () => {
    const t: SimTables = {
      contacts: [{ id: 'c1', account_id: A, owner_user_id: 'u1' }, { id: 'c2', account_id: A, owner_user_id: null }],
      profiles: [{ user_id: 'u1', account_id: A, full_name: '' }],
    };
    const m = await loadExtras(db(t), [row('c1'), row('c2')]);
    expect(m.get('c1')?.owner).toEqual({ id: 'u1', name: 'Atendente' });
    expect(m.get('c2')?.owner).toBeNull();
  });
});
