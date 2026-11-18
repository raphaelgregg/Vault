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
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, addDoc } from 'firebase/firestore';
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
