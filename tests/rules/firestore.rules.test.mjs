/**
 * Testes das Security Rules no Firebase Emulator Suite.
 *
 * Executar:  npm run test:rules
 * (sobe Firestore + Auth no emulador, roda os testes e derruba)
 *
 * Cobre, no mínimo, exigido na Fase 2:
 *  1. leitura de dados de outro usuário negada
 *  2. escrita em documento de outro usuário negada
 *  3. valor fracionário/negativo negado
 *  4. campo não previsto negado
 *  5. sem login negado
 *  6. criação/leitura válidas permitidas
 *  7. update/delete de auditLog negados
 */
import { readFileSync } from 'node:fs';
import { describe, it, before, after, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, addDoc, writeBatch } from 'firebase/firestore';
import { serverTimestamp } from 'firebase/firestore';

const here = dirname(fileURLToPath(import.meta.url));
const rules = readFileSync(join(here, '..', '..', 'firestore.rules'), 'utf8');

const PROJECT_ID = 'demo-vault-finance';
const ALICE = 'alice-uid';
const BOB = 'bob-uid';

let testEnv;

/** Contexto autenticado como um usuário. */
const asUser = (uid) => testEnv.authenticatedContext(uid).firestore();
const asAnonymous = () => testEnv.unauthenticatedContext().firestore();

const account = {
  institution: 'Banco Exemplo',
  name: 'Conta principal',
  type: 'checking',
  initialBalanceCents: 150000,
  color: '#1f7a5c',
  status: 'active',
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp(),
};

const category = {
  name: 'Casa',
  kind: 'expense',
  color: '#c0392b',
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp(),
};

function expensePayload(overrides = {}) {
  return {
    description: 'Conta de luz',
    categoryId: 'cat-casa',
    amountCents: 12990,
    accountId: 'acc-main',
    purchaseDate: new Date('2026-11-01'),
    dueDate: new Date('2026-11-10'),
    status: 'pending',
    recurrence: 'monthly',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules,
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

after(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  // Semeia documentos referenciados sem passar pelas Rules (setup de teste).
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'users', ALICE, 'accounts', 'acc-main'), account);
    await setDoc(doc(db, 'users', ALICE, 'categories', 'cat-casa'), category);
    await setDoc(doc(db, 'users', ALICE, 'accounts', 'acc-main2'), {
      ...account,
      name: 'Reserva',
      type: 'savings',
    });
    await setDoc(doc(db, 'users', BOB, 'accounts', 'acc-bob'), account);
    await setDoc(doc(db, 'users', ALICE, 'auditLog', 'entry-1'), {
      action: 'create',
      entity: 'accounts',
      entityId: 'acc-main',
      actorUid: ALICE,
      createdAt: new Date('2026-11-01'),
    });
  });
});

describe('Sem autenticação', () => {
  it('nega leitura da própria árvore', async () => {
    const db = asAnonymous();
    await assertFails(getDoc(doc(db, 'users', ALICE, 'accounts', 'acc-main')));
  });

  it('nega escrita em qualquer coleção', async () => {
    const db = asAnonymous();
    await assertFails(setDoc(doc(db, 'users', ALICE, 'accounts', 'novo'), account));
    await assertFails(
      addDoc(collection(db, 'users', ALICE, 'expenses'), expensePayload())
    );
  });
});

describe('Isolamento entre usuários', () => {
  it('nega leitura de dados de outro usuário', async () => {
    const db = asUser(BOB);
    await assertFails(getDoc(doc(db, 'users', ALICE, 'accounts', 'acc-main')));
    await assertFails(getDoc(doc(db, 'users', ALICE, 'auditLog', 'entry-1')));
  });

  it('nega escrita em documento de outro usuário', async () => {
    const db = asUser(BOB);
    await assertFails(
      setDoc(doc(db, 'users', ALICE, 'accounts', 'invasao'), account)
    );
    await assertFails(
      setDoc(doc(db, 'users', ALICE, 'accounts', 'acc-main'), { ...account, name: 'Hackeada' })
    );
  });

  it('nega consulta à coleção raiz users', async () => {
    const db = asUser(ALICE);
    await assertFails(getDoc(doc(db, 'users', ALICE)));
  });
});

describe('Validação de valores monetários e campos', () => {
  it('nega valor fracionário (centavos devem ser inteiros)', async () => {
    const db = asUser(ALICE);
    await assertFails(
      addDoc(collection(db, 'users', ALICE, 'expenses'), expensePayload({ amountCents: 129.9 }))
    );
  });

  it('nega valor negativo', async () => {
    const db = asUser(ALICE);
    await assertFails(
      addDoc(collection(db, 'users', ALICE, 'expenses'), expensePayload({ amountCents: -5000 }))
    );
  });

  it('nega zero em movimentação', async () => {
    const db = asUser(ALICE);
    await assertFails(
      addDoc(collection(db, 'users', ALICE, 'expenses'), expensePayload({ amountCents: 0 }))
    );
  });

  it('nega campo não previsto', async () => {
    const db = asUser(ALICE);
    await assertFails(
      addDoc(
        collection(db, 'users', ALICE, 'expenses'),
        expensePayload({ saldoGravado: 999999 }) // snapshot de saldo é proibido por decisão de arquitetura
      )
    );
  });

  it('nega tipo de conta inválido', async () => {
    const db = asUser(ALICE);
    await assertFails(
      setDoc(doc(db, 'users', ALICE, 'accounts', 'acc-x'), { ...account, type: 'conta-hacker' })
    );
  });

  it('nega status inválido', async () => {
    const db = asUser(ALICE);
    await assertFails(
      addDoc(collection(db, 'users', ALICE, 'expenses'), expensePayload({ status: 'quitada' }))
    );
  });
});

describe('Operações válidas', () => {
  it('permite leitura dos próprios dados', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(getDoc(doc(db, 'users', ALICE, 'accounts', 'acc-main')));
  });

  // VF-1-02: as Rules não têm como contar vínculos na exclusão; a integridade
  // referencial de contas é garantida por services/accounts.js (fail-closed).
  // Este teste documenta o contrato: o dono exclui; terceiros não.
  it('exclusão de conta: dono permitido (integridade no service), outro usuário negado', async () => {
    await assertFails(deleteDoc(doc(asUser(BOB), 'users', ALICE, 'accounts', 'acc-main')));
    await assertSucceeds(deleteDoc(doc(asUser(ALICE), 'users', ALICE, 'accounts', 'acc-main')));
  });

  it('permite criar despesa com centavos inteiros e referências válidas', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(
      addDoc(collection(db, 'users', ALICE, 'expenses'), expensePayload())
    );
  });

  it('permite criar transferência entre contas distintas', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(
      addDoc(collection(db, 'users', ALICE, 'transfers'), {
        fromAccountId: 'acc-main',
        toAccountId: 'acc-main2',
        amountCents: 5000,
        date: new Date('2026-11-02'),
        reason: 'Reserva',
        status: 'confirmed',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );
  });

  it('nega transferência para a mesma conta', async () => {
    const db = asUser(ALICE);
    await assertFails(
      addDoc(collection(db, 'users', ALICE, 'transfers'), {
        fromAccountId: 'acc-main',
        toAccountId: 'acc-main',
        amountCents: 5000,
        date: new Date('2026-11-02'),
        reason: 'Erro',
        status: 'confirmed',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );
  });

  it('nega referência a documento inexistente', async () => {
    const db = asUser(ALICE);
    await assertFails(
      addDoc(
        collection(db, 'users', ALICE, 'expenses'),
        expensePayload({ accountId: 'acc-fantasma' })
      )
    );
  });

  it('nega referência a documento de outro usuário', async () => {
    const db = asUser(BOB);
    await assertFails(
      addDoc(
        collection(db, 'users', BOB, 'expenses'),
        expensePayload({ accountId: 'acc-main' }) // pertence a Alice
      )
    );
  });
});

describe('auditLog imutável', () => {
  it('permite leitura do próprio log', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(getDoc(doc(db, 'users', ALICE, 'auditLog', 'entry-1')));
  });

  it('permite criar entrada com actorUid correto', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(
      addDoc(collection(db, 'users', ALICE, 'auditLog'), {
        action: 'create',
        entity: 'expenses',
        entityId: 'exp-1',
        actorUid: ALICE,
        createdAt: serverTimestamp(),
      })
    );
  });

  it('permite entrada com before e after (payload do writeAudit)', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(
      addDoc(collection(db, 'users', ALICE, 'auditLog'), {
        action: 'update',
        entity: 'accounts',
        entityId: 'acc-main',
        before: { name: 'Antes', initialBalanceCents: 100 },
        after: { name: 'Depois', initialBalanceCents: 200 },
        actorUid: ALICE,
        createdAt: serverTimestamp(),
      })
    );
  });

  it('nega before/after que não sejam mapa', async () => {
    const db = asUser(ALICE);
    await assertFails(
      addDoc(collection(db, 'users', ALICE, 'auditLog'), {
        action: 'update',
        entity: 'accounts',
        entityId: 'acc-main',
        after: 'texto',
        actorUid: ALICE,
        createdAt: serverTimestamp(),
      })
    );
  });

  it('nega campos fora do schema (formato antigo collection/docId)', async () => {
    const db = asUser(ALICE);
    await assertFails(
      addDoc(collection(db, 'users', ALICE, 'auditLog'), {
        action: 'create',
        collection: 'accounts',
        docId: 'acc-main',
        actorUid: ALICE,
        createdAt: serverTimestamp(),
      })
    );
  });

  it('nega update', async () => {
    const db = asUser(ALICE);
    await assertFails(
      updateDoc(doc(db, 'users', ALICE, 'auditLog', 'entry-1'), { action: 'adulterado' })
    );
  });

  it('nega delete', async () => {
    const db = asUser(ALICE);
    await assertFails(deleteDoc(doc(db, 'users', ALICE, 'auditLog', 'entry-1')));
  });

  it('nega entrada com actorUid de outro usuário', async () => {
    const db = asUser(ALICE);
    await assertFails(
      addDoc(collection(db, 'users', ALICE, 'auditLog'), {
        action: 'create',
        entity: 'expenses',
        entityId: 'exp-2',
        actorUid: BOB,
        createdAt: serverTimestamp(),
      })
    );
  });
});

describe('Negação padrão', () => {
  it('nega coleção não prevista', async () => {
    const db = asUser(ALICE);
    await assertFails(setDoc(doc(db, 'users', ALICE, 'colecaoInventada', 'x'), { a: 1 }));
  });

  it('nega coleção fora da árvore do usuário', async () => {
    const db = asUser(ALICE);
    await assertFails(setDoc(doc(db, 'publico', 'x'), { a: 1 }));
  });
});

describe('Perfil e configurações (VF-2-02)', () => {
  const profileDoc = (db) => doc(db, 'users', ALICE, 'profile', 'main');
  const settingsDoc = (db) => doc(db, 'users', ALICE, 'settings', 'main');
  const profile = () => ({
    name: 'Ana',
    email: 'ana@exemplo.com',
    currency: 'BRL',
    locale: 'pt-BR',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  const settings = (overrides = {}) => ({
    theme: 'dark',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  });

  it('permite criar perfil válido e atualizar o nome via merge (como o service)', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(profileDoc(db), profile(), { merge: true }));
    await assertSucceeds(
      setDoc(profileDoc(db), { name: 'Ana Maria', updatedAt: serverTimestamp() }, { merge: true })
    );
  });

  it('nega perfil com moeda/idioma diferentes, nome vazio ou campo extra', async () => {
    const db = asUser(ALICE);
    await assertFails(setDoc(profileDoc(db), { ...profile(), currency: 'USD' }));
    await assertFails(setDoc(profileDoc(db), { ...profile(), locale: 'en-US' }));
    await assertFails(setDoc(profileDoc(db), { ...profile(), name: '' }));
    await assertFails(setDoc(profileDoc(db), { ...profile(), admin: true }));
  });

  it('nega alterar createdAt do perfil e excluir perfil', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(profileDoc(db), profile()));
    await assertFails(
      setDoc(profileDoc(db), { createdAt: new Date('2000-01-01'), updatedAt: serverTimestamp() }, { merge: true })
    );
    await assertFails(deleteDoc(profileDoc(db)));
  });

  it('permite criar configurações e trocar tema via merge sem reenviar createdAt', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(settingsDoc(db), settings(), { merge: true }));
    await assertSucceeds(
      setDoc(settingsDoc(db), { theme: 'light', updatedAt: serverTimestamp() }, { merge: true })
    );
  });

  it('nega tema inválido, firstWeekday fora de 0–6, hideValues não booleano e campo extra', async () => {
    const db = asUser(ALICE);
    await assertFails(setDoc(settingsDoc(db), settings({ theme: 'neon' })));
    await assertFails(setDoc(settingsDoc(db), settings({ firstWeekday: 7 })));
    await assertFails(setDoc(settingsDoc(db), settings({ hideValues: 'sim' })));
    await assertFails(setDoc(settingsDoc(db), settings({ extra: 1 })));
  });

  it('nega alterar createdAt das configurações e excluí-las', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(settingsDoc(db), settings()));
    await assertFails(
      setDoc(settingsDoc(db), { createdAt: new Date('2000-01-01'), updatedAt: serverTimestamp() }, { merge: true })
    );
    await assertFails(deleteDoc(settingsDoc(db)));
  });

  it('isola perfil/configurações entre usuários', async () => {
    await assertFails(setDoc(doc(asUser(BOB), 'users', ALICE, 'settings', 'main'), settings()));
    await assertFails(getDoc(doc(asUser(BOB), 'users', ALICE, 'profile', 'main')));
  });
});

describe('Assinaturas (VF-2-03a)', () => {
  const subDoc = (db, id = 'sub1') => doc(db, 'users', ALICE, 'subscriptions', id);
  // Payload equivalente ao gravado por js/services/subscriptions.js (datas = meio-dia UTC).
  const sub = (overrides = {}) => ({
    name: 'Netflix',
    amountCents: 3990,
    periodicity: 'monthly',
    nextChargeDate: new Date('2026-12-05T12:00:00.000Z'),
    accountId: 'acc-main',
    categoryId: 'cat-casa',
    status: 'active',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  });

  it('permite criar, pausar (patch de status) e excluir', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(subDoc(db), sub({ notes: 'plano padrão' })));
    await assertSucceeds(updateDoc(subDoc(db), { status: 'paused', updatedAt: serverTimestamp() }));
    await assertSucceeds(deleteDoc(subDoc(db)));
  });

  it('nega valor não positivo/fracionário, periodicidade e status inválidos, campo extra', async () => {
    const db = asUser(ALICE);
    await assertFails(setDoc(subDoc(db), sub({ amountCents: 0 })));
    await assertFails(setDoc(subDoc(db), sub({ amountCents: 39.9 })));
    await assertFails(setDoc(subDoc(db), sub({ periodicity: 'daily' })));
    await assertFails(setDoc(subDoc(db), sub({ status: 'none' })));
    await assertFails(setDoc(subDoc(db), sub({ extra: 1 })));
  });

  it('nega data como string, conta/categoria inexistentes e conta de outro usuário', async () => {
    const db = asUser(ALICE);
    await assertFails(setDoc(subDoc(db), sub({ nextChargeDate: '2026-12-05' })));
    await assertFails(setDoc(subDoc(db), sub({ accountId: 'nao-existe' })));
    await assertFails(setDoc(subDoc(db), sub({ categoryId: 'nao-existe' })));
    await assertFails(setDoc(subDoc(db), sub({ accountId: 'acc-bob' })));
  });

  it('nega alterar createdAt e acesso de outro usuário/anônimo', async () => {
    await assertSucceeds(setDoc(subDoc(asUser(ALICE)), sub()));
    await assertFails(
      updateDoc(subDoc(asUser(ALICE)), { createdAt: new Date('2000-01-01'), updatedAt: serverTimestamp() })
    );
    await assertFails(getDoc(subDoc(asUser(BOB))));
    await assertFails(setDoc(subDoc(asUser(BOB), 'sub2'), sub()));
    await assertFails(getDoc(subDoc(asAnonymous())));
  });
});

describe('Devedores (VF-2-03b)', () => {
  const debtorDoc = (db, id = 'dev1') => doc(db, 'users', ALICE, 'debtors', id);
  // Payload equivalente ao gravado por js/services/debtors.js (loanDate = meio-dia UTC).
  const debtor = (overrides = {}) => ({
    name: 'João',
    loanDate: new Date('2026-11-10T12:00:00.000Z'),
    lentCents: 100000,
    receivedCents: 0,
    status: 'open',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  });

  it('permite criar, editar valor emprestado, cancelar (patch) e excluir', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(debtorDoc(db), debtor({ notes: 'amigo' })));
    await assertSucceeds(updateDoc(debtorDoc(db), { lentCents: 50000, updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(debtorDoc(db), { status: 'cancelled', updatedAt: serverTimestamp() }));
    await assertSucceeds(deleteDoc(debtorDoc(db)));
  });

  it('nega emprestado <= 0/fracionário, recebido negativo ou maior que emprestado', async () => {
    const db = asUser(ALICE);
    await assertFails(setDoc(debtorDoc(db), debtor({ lentCents: 0 })));
    await assertFails(setDoc(debtorDoc(db), debtor({ lentCents: 10.5 })));
    await assertFails(setDoc(debtorDoc(db), debtor({ receivedCents: -1 })));
    await assertFails(setDoc(debtorDoc(db), debtor({ receivedCents: 100001 })));
    await assertSucceeds(setDoc(debtorDoc(db), debtor({ receivedCents: 100000, status: 'paid' })));
  });

  it('nega reduzir emprestado abaixo do recebido (patch)', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(debtorDoc(db), debtor({ receivedCents: 30000 })));
    await assertFails(updateDoc(debtorDoc(db), { lentCents: 20000, updatedAt: serverTimestamp() }));
  });

  it('nega status inválido, data como string e campo extra', async () => {
    const db = asUser(ALICE);
    await assertFails(setDoc(debtorDoc(db), debtor({ status: 'late' })));
    await assertFails(setDoc(debtorDoc(db), debtor({ loanDate: '2026-11-10' })));
    await assertFails(setDoc(debtorDoc(db), debtor({ extra: 1 })));
  });

  it('nega alterar createdAt e acesso de outro usuário/anônimo', async () => {
    await assertSucceeds(setDoc(debtorDoc(asUser(ALICE)), debtor()));
    await assertFails(
      updateDoc(debtorDoc(asUser(ALICE)), { createdAt: new Date('2000-01-01'), updatedAt: serverTimestamp() })
    );
    await assertFails(getDoc(debtorDoc(asUser(BOB))));
    await assertFails(setDoc(debtorDoc(asUser(BOB), 'dev2'), debtor()));
    await assertFails(getDoc(debtorDoc(asAnonymous())));
  });
});

describe('Parcelas e recebimentos de devedores (VF-2-03b2)', () => {
  const debtorDoc = (db) => doc(db, 'users', ALICE, 'debtors', 'dev1');
  const debtDoc = (db, id = 'd1') => doc(db, 'users', ALICE, 'debts', id);
  const payDoc = (db, id = 'p1') => doc(db, 'users', ALICE, 'debtPayments', id);
  const accountDoc = (db) => doc(db, 'users', ALICE, 'accounts', 'acc1');
  const noon = (d) => new Date(`${d}T12:00:00.000Z`);
  // Payloads equivalentes aos gravados por js/services/debtPayments.js (datas = meio-dia UTC).
  const debt = (o = {}) => ({
    debtorId: 'dev1', description: 'Parcela 1', principalCents: 50000, dueDate: noon('2026-12-10'),
    installmentNumber: 1, status: 'pending', createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...o,
  });
  const payment = (o = {}) => ({
    debtId: 'd1', debtorId: 'dev1', amountCents: 20000, date: noon('2026-11-18'), accountId: 'acc1',
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...o,
  });

  async function seed() {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(accountDoc(db), account));
    await assertSucceeds(setDoc(debtorDoc(db), {
      name: 'João', loanDate: noon('2026-11-10'), lentCents: 50000, receivedCents: 0, status: 'open',
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(setDoc(debtDoc(db), debt()));
    return db;
  }

  it('lote atômico do recebimento: pagamento + parcela paga + devedor quitado', async () => {
    const db = await seed();
    const batch = writeBatch(db);
    batch.set(payDoc(db), payment({ amountCents: 50000, notes: 'pix' }));
    batch.update(debtDoc(db), { status: 'paid', updatedAt: serverTimestamp() });
    batch.update(debtorDoc(db), { receivedCents: 50000, status: 'paid', updatedAt: serverTimestamp() });
    await assertSucceeds(batch.commit());
  });

  it('lote inteiro falha se o recebimento excede o emprestado (nada gravado)', async () => {
    const db = await seed();
    const batch = writeBatch(db);
    batch.set(payDoc(db), payment());
    batch.update(debtorDoc(db), { receivedCents: 50001, updatedAt: serverTimestamp() });
    await assertFails(batch.commit());
    const snap = await getDoc(payDoc(db));
    if (snap.exists()) throw new Error('o recebimento não deveria ter sido gravado (lote não atômico)');
  });

  it('parcelas: valida schema (principal, número 1..360, status, data, devedor existente)', async () => {
    const db = await seed();
    await assertSucceeds(setDoc(debtDoc(db, 'd2'), debt({ installmentNumber: 360, status: 'late' })));
    await assertFails(setDoc(debtDoc(db, 'd3'), debt({ principalCents: 0 })));
    await assertFails(setDoc(debtDoc(db, 'd3'), debt({ installmentNumber: 361 })));
    await assertFails(setDoc(debtDoc(db, 'd3'), debt({ installmentNumber: 1.5 })));
    await assertFails(setDoc(debtDoc(db, 'd3'), debt({ status: 'open' })));
    await assertFails(setDoc(debtDoc(db, 'd3'), debt({ dueDate: '2026-12-10' })));
    await assertFails(setDoc(debtDoc(db, 'd3'), debt({ debtorId: 'inexistente' })));
    await assertFails(setDoc(debtDoc(db, 'd3'), debt({ extra: 1 })));
    await assertSucceeds(updateDoc(debtDoc(db), { status: 'cancelled', updatedAt: serverTimestamp() }));
  });

  it('recebimentos: valida schema, referências e isolamento', async () => {
    const db = await seed();
    await assertSucceeds(setDoc(payDoc(db), payment()));
    await assertFails(setDoc(payDoc(db, 'p2'), payment({ amountCents: 0 })));
    await assertFails(setDoc(payDoc(db, 'p2'), payment({ amountCents: 10.5 })));
    await assertFails(setDoc(payDoc(db, 'p2'), payment({ date: '2026-11-18' })));
    await assertFails(setDoc(payDoc(db, 'p2'), payment({ debtId: 'zzz' })));
    await assertFails(setDoc(payDoc(db, 'p2'), payment({ accountId: 'zzz' })));
    await assertFails(setDoc(payDoc(db, 'p2'), payment({ extra: 1 })));
    await assertFails(getDoc(payDoc(asUser(BOB))));
    await assertFails(setDoc(payDoc(asUser(BOB), 'p3'), payment()));
    await assertFails(getDoc(payDoc(asAnonymous())));
  });
});

describe('Metas e movimentações (VF-2-03c)', () => {
  const goalDoc = (db, id = 'g1') => doc(db, 'users', ALICE, 'goals', id);
  const txDoc = (db, id = 't1') => doc(db, 'users', ALICE, 'goalTransactions', id);
  const accountDoc = (db) => doc(db, 'users', ALICE, 'accounts', 'acc1');
  const noon = (d) => new Date(`${d}T12:00:00.000Z`);
  // Payloads equivalentes aos gravados por js/services/goals.js (datas = meio-dia UTC).
  const goal = (o = {}) => ({
    name: 'Viagem', targetCents: 100000, deadline: noon('2027-01-10'), accountId: 'acc1', status: 'active',
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...o,
  });
  const tx = (o = {}) => ({
    goalId: 'g1', type: 'deposit', amountCents: 30000, date: noon('2026-11-18'), accountId: 'acc1',
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...o,
  });
  async function seed() {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(accountDoc(db), account));
    await assertSucceeds(setDoc(goalDoc(db), goal()));
    return db;
  }

  it('metas: cria (com e sem opcionais), edita, cancela e exclui', async () => {
    const db = await seed();
    await assertSucceeds(setDoc(goalDoc(db, 'g2'), { name: 'Reserva', targetCents: 5000, status: 'active', createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(goalDoc(db), { targetCents: 200000, updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(goalDoc(db), { status: 'cancelled', updatedAt: serverTimestamp() }));
    await assertSucceeds(deleteDoc(goalDoc(db, 'g2')));
  });

  it('metas: nega alvo <= 0, status inválido, prazo string, conta inexistente e campo extra', async () => {
    const db = await seed();
    await assertFails(setDoc(goalDoc(db, 'g3'), goal({ targetCents: 0 })));
    await assertFails(setDoc(goalDoc(db, 'g3'), goal({ status: 'paid' })));
    await assertFails(setDoc(goalDoc(db, 'g3'), goal({ deadline: '2027-01-10' })));
    await assertFails(setDoc(goalDoc(db, 'g3'), goal({ accountId: 'zzz' })));
    await assertFails(setDoc(goalDoc(db, 'g3'), goal({ extra: 1 })));
  });

  it('lote atômico do aporte que conclui a meta: movimentação + status', async () => {
    const db = await seed();
    const batch = writeBatch(db);
    batch.set(txDoc(db), tx({ amountCents: 100000, notes: 'bônus' }));
    batch.update(goalDoc(db), { status: 'completed', updatedAt: serverTimestamp() });
    await assertSucceeds(batch.commit());
    const resgate = writeBatch(db);
    resgate.set(txDoc(db, 't2'), tx({ type: 'withdraw', amountCents: 1000 }));
    resgate.update(goalDoc(db), { status: 'active', updatedAt: serverTimestamp() });
    await assertSucceeds(resgate.commit());
  });

  it('lote inteiro falha se uma operação é inválida (nada gravado)', async () => {
    const db = await seed();
    const batch = writeBatch(db);
    batch.set(txDoc(db), tx());
    batch.update(goalDoc(db), { status: 'paid', updatedAt: serverTimestamp() });
    await assertFails(batch.commit());
    if ((await getDoc(txDoc(db))).exists()) throw new Error('movimentação gravada apesar do lote inválido');
  });

  it('movimentações: valida schema, referências e isolamento', async () => {
    const db = await seed();
    await assertSucceeds(setDoc(txDoc(db), tx()));
    await assertFails(setDoc(txDoc(db, 't2'), tx({ type: 'transfer' })));
    await assertFails(setDoc(txDoc(db, 't2'), tx({ amountCents: 0 })));
    await assertFails(setDoc(txDoc(db, 't2'), tx({ amountCents: 10.5 })));
    await assertFails(setDoc(txDoc(db, 't2'), tx({ date: '2026-11-18' })));
    await assertFails(setDoc(txDoc(db, 't2'), tx({ goalId: 'zzz' })));
    await assertFails(setDoc(txDoc(db, 't2'), tx({ accountId: 'zzz' })));
    await assertFails(setDoc(txDoc(db, 't2'), tx({ notes: 'x'.repeat(301) })));
    await assertFails(setDoc(txDoc(db, 't2'), tx({ extra: 1 })));
    await assertFails(getDoc(txDoc(asUser(BOB))));
    await assertFails(setDoc(doc(asUser(BOB), 'users', ALICE, 'goalTransactions', 't9'), tx()));
    await assertFails(getDoc(txDoc(asAnonymous())));
  });
});

