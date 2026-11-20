/**
 * Serviço de Parcelas (debts) e Recebimentos (debtPayments) de devedores (VF-2-03b2).
 * Contrato = firestore.rules. Registrar recebimento é ATÔMICO (um lote): grava o
 * recebimento, atualiza a parcela (paga ao completar o principal) e o devedor
 * (receivedCents/status paid) com as auditorias no mesmo lote.
 *
 * Recebimentos entram em accountBalances (saldo da conta aumenta); o saldo continua derivado.
 * Limitações: leitura prévia + lote sem transação (janela de concorrência; as Rules
 * não validam a soma); recebimento é imutável (sem estorno) — registrar errado exige novo VF.
 */
import { COLLECTIONS } from '../utils/constants.js';
import {
  list,
  getById,
  createAudited,
  updateAudited,
  commitAtomic,
} from './firestore.js';
import { loadDebtorStatements } from './debtors.js';
import {
  buildEntity,
  applyPaymentToDebtor,
  debtorObligations,
  pendingInstallmentsOfMonth,
  receivedByInstallment,
  addMonths,
  isValidIsoDate,
  clampDayInMonth,
  splitInstallments,
  centsToMoneyString,
  DEBT_STATUSES,
  formatCents,
  parseMoneyToCents,
} from '../core/model.js';

const DEBTS = COLLECTIONS.debts;
const PAYMENTS = COLLECTIONS.debtPayments;
const DEBTORS = COLLECTIONS.debtors;
const MAX_INSTALLMENT = 360;
const MAX_SETTLE_INSTALLMENTS = 120; // teto de parcelas por quitação de dívida (gravadas em blocos atômicos, ver RECEIPT_BATCH_SIZE)
const MAX_PLAN_INSTALLMENTS = 120; // 2 escritas por parcela (+ devedor) no mesmo lote (limite de 500)

export async function listDebts(uid, debtorId) {
  return list(uid, DEBTS, { where: [['debtorId', '==', debtorId]] });
}

export async function listDebtPayments(uid, options = {}) {
  const constraints = {};
  if (options.where) constraints.where = options.where;
  return list(uid, PAYMENTS, constraints);
}

/** Cria parcela (status sempre `pending`). Devedor precisa existir e estar em aberto (para dívida nova use `createDebtPlan`). */
export async function createDebt(uid, rawData, deps = {}) {
  const fetch = deps.getById ?? getById;
  const debtor = rawData?.debtorId ? await fetch(uid, DEBTORS, String(rawData.debtorId)) : null;
  if (!debtor) return { ok: false, errors: { debtorId: 'Devedor não encontrado.' } };
  if (debtor.status !== 'open') {
    return { ok: false, errors: { _form: 'Só é possível criar parcelas para devedor em aberto.' } };
  }
  let installmentNumber = rawData.installmentNumber;
  if (installmentNumber === undefined || installmentNumber === null || installmentNumber === '') {
    const existing = await (deps.list ?? list)(uid, DEBTS, { where: [['debtorId', '==', debtor.id ?? rawData.debtorId]] });
    installmentNumber = existing.reduce((max, d) => Math.max(max, Number(d.installmentNumber) || 0), 0) + 1;
    if (installmentNumber > MAX_INSTALLMENT) {
      return { ok: false, errors: { installmentNumber: `Máximo de ${MAX_INSTALLMENT} parcelas.` } };
    }
  }
  const { ok, data, errors } = buildEntity('debts', { ...rawData, installmentNumber, status: 'pending' });
  if (!ok) return { ok: false, errors };
  const id = await createAudited(uid, DEBTS, data, deps);
  return { ok: true, id };
}

/**
 * Cria uma dívida do devedor, à vista (`installments` 1) ou parcelada (N), em UM lote atômico (VF-2-03m).
 * `rawData`: { debtorId, description, totalCents (string pt-BR), installments (padrão 1), firstDueDate }.
 * Parcelas mensais no mesmo dia (com clamp ao fim do mês), valores em centavos inteiros (a 1ª leva o
 * resto da divisão), todas com `installmentsTotal` e o mesmo `debtGroupId`. O total soma ao `lentCents`
 * do devedor (agregado mantido pelo service; o pendente continua `lentCents − receivedCents`).
 * Devedor precisa existir e estar em aberto ou quitado (quitado é reaberto no mesmo lote). `io`: getById, commitAtomic, groupId() injetáveis.
 */
export async function createDebtPlan(uid, rawData, io = {}) {
  const fetch = io.getById ?? getById;
  const debtor = rawData?.debtorId ? await fetch(uid, DEBTORS, String(rawData.debtorId)) : null;
  if (!debtor) return { ok: false, errors: { debtorId: 'Devedor não encontrado.' } };
  // Devedor QUITADO (`paid`) pode receber nova dívida: ela o reabre no mesmo lote. Só o cancelado fica de fora.
  if (!['open', 'paid'].includes(debtor.status)) return { ok: false, errors: { _form: 'Reabra o devedor cancelado antes de criar dívidas.' } };

  const rawN = rawData.installments === undefined || rawData.installments === '' ? 1 : Number(rawData.installments);
  if (!Number.isInteger(rawN) || rawN < 1 || rawN > MAX_PLAN_INSTALLMENTS) {
    return { ok: false, errors: { installments: `Informe de 1 a ${MAX_PLAN_INSTALLMENTS} parcelas.` } };
  }
  const total = parseMoneyToCents(rawData.totalCents);
  if (!Number.isInteger(total) || total <= 0) return { ok: false, errors: { totalCents: 'Informe um valor maior que zero.' } };
  const parts = splitInstallments(total, rawN);
  if (!parts) return { ok: false, errors: { totalCents: 'O valor deve ser de ao menos 1 centavo por parcela.' } };
  const first = /^(\d{4}-\d{2})-(\d{2})$/.exec(rawData.firstDueDate ?? '');
  if (!first || !isValidIsoDate(rawData.firstDueDate)) return { ok: false, errors: { firstDueDate: 'Data inválida (use AAAA-MM-DD).' } };
  const day = Number(first[2]);

  const groupId = io.groupId ? io.groupId() : `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const ops = [];
  for (let n = 1; n <= rawN; n += 1) {
    const month = addMonths(first[1], n - 1);
    const built = buildEntity('debts', {
      debtorId: debtor.id ?? rawData.debtorId, description: rawData.description, principalCents: centsToMoneyString(parts[n - 1]),
      dueDate: clampDayInMonth(month, day), installmentNumber: n, installmentsTotal: rawN, debtGroupId: groupId, status: 'pending',
    });
    if (!built.ok) return { ok: false, errors: built.errors };
    ops.push({ type: 'create', collection: DEBTS, data: built.data });
  }
  // Soma por `increment` (não valor absoluto de leitura velha); devedor quitado volta a `open` no mesmo lote.
  ops.push({
    type: 'update', collection: DEBTORS, docId: debtor.id ?? rawData.debtorId, action: 'debt-plan',
    data: debtor.status === 'paid' ? { status: 'open' } : {}, increments: { lentCents: total },
  });
  const ids = await (io.commitAtomic ?? commitAtomic)(uid, ops, io);
  return { ok: true, ids, groupId, installments: rawN, totalCents: total };
}

/**
 * Quita (dá baixa no restante de) as parcelas pendentes de um devedor em UM lote atômico (VF-2-03n).
 * `scope.groupId` limita a uma dívida (`debtGroupId`; parcela legada sem grupo usa o próprio id);
 * sem `groupId`, quita todas as dívidas em aberto. Cada parcela recebe um recebimento com o restante
 * (principal − já recebido), vira `paid`, e o devedor soma o total em `receivedCents`
 * (`applyPaymentToDebtor`: nunca acima do pendente; `paid` só quando recebido == emprestado — compras de
 * cartão e valor sem parcela mantêm o devedor em aberto). Parcelas pagas/canceladas e compras de cartão
 * não são tocadas. `rawData`: { date, accountId, notes? }. Retorna { ok, count, totalCents, debtorPaid, errors }.
 */
export async function settleDebts(uid, debtorId, scope = {}, rawData = {}, io = {}) {
  const fetch = io.getById ?? getById;
  const fetchList = io.list ?? list;
  const debtor = await fetch(uid, DEBTORS, debtorId);
  if (!debtor) return { ok: false, errors: { _form: 'Devedor não encontrado.' } };
  if (debtor.status !== 'open') return { ok: false, errors: { _form: 'Só é possível quitar dívidas de devedor em aberto.' } };

  const [debts, payments] = await Promise.all([
    fetchList(uid, DEBTS, { where: [['debtorId', '==', debtorId]] }),
    fetchList(uid, PAYMENTS, { where: [['debtorId', '==', debtorId]] }),
  ]);
  const received = new Map();
  for (const p of payments) received.set(p.debtId, (received.get(p.debtId) ?? 0) + (Number(p.amountCents) || 0));
  const targets = debts
    .filter((d) => ['pending', 'late'].includes(d.status) && (!scope.groupId || (d.debtGroupId ?? d.id) === scope.groupId))
    .map((d) => ({ debt: d, remaining: (Number(d.principalCents) || 0) - (received.get(d.id) ?? 0) }))
    .sort((a, b) => (a.debt.dueDate < b.debt.dueDate ? -1 : 1));
  if (!targets.length) return { ok: false, errors: { _form: 'Não há parcelas pendentes para quitar.' } };
  if (targets.length > MAX_SETTLE_INSTALLMENTS) {
    return { ok: false, errors: { _form: `Quite em partes: máximo de ${MAX_SETTLE_INSTALLMENTS} parcelas por vez.` } };
  }

  const probe = buildEntity('debtPayments', { ...rawData, amountCents: '0,01', debtId: targets[0].debt.id, debtorId });
  if (!probe.ok) return { ok: false, errors: probe.errors }; // valida data/conta/observações uma vez
  const account = await fetch(uid, COLLECTIONS.accounts, rawData.accountId);
  if (!account) return { ok: false, errors: { accountId: 'Conta não encontrada.' } };
  if (account.status !== 'active') return { ok: false, errors: { accountId: 'A conta precisa estar ativa.' } };

  const units = [];
  let totalCents = 0;
  for (const { debt, remaining } of targets) {
    const ops = [];
    if (remaining > 0) {
      const built = buildEntity('debtPayments', { ...rawData, amountCents: centsToMoneyString(remaining), debtId: debt.id, debtorId });
      if (!built.ok) return { ok: false, errors: built.errors };
      ops.push({ type: 'create', collection: PAYMENTS, data: built.data, docId: receiptPaymentId(debt.id, payments) });
      totalCents += remaining;
    }
    ops.push({ type: 'update', collection: DEBTS, docId: debt.id, data: { status: 'paid' }, action: 'settle' });
    units.push({ ops, cents: Math.max(0, remaining) });
  }
  const applied = totalCents > 0 ? applyPaymentToDebtor(debtor, totalCents) : { ok: true, status: 'open' };
  if (!applied.ok) return { ok: false, errors: { _form: applied.error } };
  const written = await commitReceiptUnits(uid, debtorId, units, applied, io);
  const reconcile = await reconcileDebtorStatus(uid, debtorId, io);
  if (!written.ok) return { ...partialFailure(written, targets.length), reconcile };
  return { ok: true, count: targets.length, totalCents, debtorPaid: totalCents > 0 && applied.status === 'paid', reconcile };
}

// ---------------------------------------------------------------------------------------------------------------
// Quitação por parcela e por mês (VF-2-03ak)
// ---------------------------------------------------------------------------------------------------------------

/**
 * ID EXCLUSIVO e SEQUENCIAL de cada recebimento de uma parcela: `pay-<parcela>-<n>`, com n = (maior entre a
 * quantidade de recebimentos e o maior sufixo já usado) + 1, lido do histórico atual. Cada recebimento é um
 * documento independente (parcial ou final) e o histórico nunca é sobrescrito. IDEMPOTÊNCIA/CONCORRÊNCIA: duas
 * operações que leram o mesmo histórico geram o MESMO ID; a 2ª cai em `update` de documento existente e as Rules
 * (`debtPayments` é imutável) negam o lote inteiro — impossível receber duas vezes sobre a mesma leitura, e por isso
 * a soma dos recebimentos de uma parcela nunca passa do valor dela.
 */
export function receiptPaymentId(installmentId, payments = []) {
  const prefix = `pay-${installmentId}-`;
  const mine = payments.filter((p) => p.debtId === installmentId || p.purchaseId === installmentId).length;
  const maxSeq = payments.reduce((max, p) => (typeof p.id === 'string' && p.id.startsWith(prefix) ? Math.max(max, Number(p.id.slice(prefix.length)) || 0) : max), 0);
  return `${prefix}${Math.max(mine, maxSeq) + 1}`;
}

/** Chave de idempotência de UMA operação do usuário (gerada ao abrir o formulário; retry/duplo clique reutilizam). */
export const newOperationId = () => globalThis.crypto.randomUUID();

/**
 * IDEMPOTÊNCIA por `operationId`: se a operação já foi gravada (ex.: o servidor gravou mas a resposta se perdeu e o
 * usuário repetiu), devolve os recebimentos dela em vez de gravar de novo. Dois envios SIMULTÂNEOS com a mesma chave
 * ainda passam por esta checagem ao mesmo tempo; o que os impede de duplicar é o ID sequencial do recebimento (as
 * Rules negam o segundo). Falha de leitura propaga (fail-closed: não grava sem saber se já foi gravado).
 */
async function findOperationPayments(uid, debtorId, operationId, io) {
  if (!operationId) return [];
  const rows = await (io.list ?? list)(uid, PAYMENTS, { where: [['operationId', '==', operationId]] });
  return rows.filter((p) => p.debtorId === debtorId);
}

/**
 * Soma ao devedor o valor recebido de forma ATÔMICA (`increment`, não valor absoluto de uma leitura que pode estar
 * velha) e só grava `status: paid` quando esta operação zera o pendente. Recebimentos simultâneos em parcelas
 * diferentes do mesmo devedor, então, não se sobrescrevem; as Rules (`receivedCents <= lentCents`) barram excesso.
 */
const debtorReceiveOp = (debtorId, totalCents, applied) => ({
  type: 'update', collection: DEBTORS, docId: debtorId, action: 'receive',
  data: applied.status === 'paid' ? { status: 'paid' } : {}, increments: { receivedCents: totalCents },
});

/**
 * Conciliação do status do devedor: se, com recebimentos concorrentes, o total recebido alcançou o emprestado mas o
 * status ficou `open` (cada operação via "pendente > 0" na sua leitura), marca `paid`. Corrige SÓ esse estado (nunca
 * mexe em valores nem em recebimentos), é idempotente e pode ser chamada de novo a qualquer momento para recuperar.
 * Retorna { ok, changed, error? }: falha NÃO é engolida — os chamadores repassam `reconcile` no resultado e a
 * auditoria (`auditFinancialIntegrity`) a detecta como DEBTOR_STATUS_OPEN_WITH_ZERO_PENDING.
 */
export async function reconcileDebtorStatus(uid, debtorId, io = {}) {
  try {
    const fresh = await (io.getById ?? getById)(uid, DEBTORS, debtorId);
    if (!fresh) return { ok: false, changed: false, error: 'Devedor não encontrado.' };
    const lent = Number(fresh.lentCents) || 0;
    if (fresh.status === 'open' && lent > 0 && (Number(fresh.receivedCents) || 0) >= lent) {
      await (io.commitAtomic ?? commitAtomic)(uid, [{ type: 'update', collection: DEBTORS, docId: debtorId, data: { status: 'paid' }, action: 'reconcile' }], io);
      return { ok: true, changed: true };
    }
    return { ok: true, changed: false };
  } catch (error) {
    console.error('[debtPayments] falha ao conciliar o status do devedor', error);
    return { ok: false, changed: false, error: error?.message ?? String(error), code: error?.code };
  }
}

/**
 * Razão do devedor lido do Firestore: dívidas, compras de cartão vinculadas, faturas e recebimentos (uma leitura
 * por coleção). Retorna { debts, payments, purchases, invoicesById } — insumo de `debtorObligations`.
 * Falha propaga (os chamadores são fail-closed: não quitam sem conhecer os recebimentos existentes).
 */
export async function loadDebtorLedger(uid, debtor, io = {}) {
  const map = await loadDebtorStatements(uid, [debtor], '2000-01', { list: io.list, includeAll: true });
  const st = map.get(debtor.id);
  return { debts: st?.debts ?? [], payments: st?.payments ?? [], purchases: st?.purchases ?? [], invoicesById: st?.invoicesById ?? new Map() };
}

function ledgerInput(debtor, ledger) {
  const { byDebt, byPurchase } = receivedByInstallment(ledger.payments);
  return { debtor, debts: ledger.debts, receivedByDebt: byDebt, receivedByPurchase: byPurchase, purchases: ledger.purchases, invoicesById: ledger.invoicesById };
}

/** Valida conta (existente e ativa) e os campos comuns (data, observações) uma vez. */
async function checkReceiptTarget(uid, rawData, probeFields, fetch) {
  const probe = buildEntity('debtPayments', { ...rawData, amountCents: '0,01', ...probeFields });
  if (!probe.ok) return { ok: false, errors: probe.errors };
  const account = await fetch(uid, COLLECTIONS.accounts, rawData.accountId);
  if (!account) return { ok: false, errors: { accountId: 'Conta não encontrada.' } };
  if (account.status !== 'active') return { ok: false, errors: { accountId: 'A conta precisa estar ativa.' } };
  return { ok: true };
}

/**
 * Grava `units` ({ ops, cents }[]) em blocos atômicos de RECEIPT_BATCH_SIZE, cada bloco com o `increment` do devedor
 * pelo total do bloco (o `status: paid` só no último e só se a operação inteira quita o devedor). Para no primeiro
 * bloco que falhar e devolve o que já foi gravado — sem engolir o erro. Retorna
 * { ok, done (unidades gravadas), ids, error? , code? }.
 */
async function commitReceiptUnits(uid, debtorId, units, applied, io) {
  const ids = [];
  let done = 0;
  for (let i = 0; i < units.length; i += RECEIPT_BATCH_SIZE) {
    const chunk = units.slice(i, i + RECEIPT_BATCH_SIZE);
    const last = i + RECEIPT_BATCH_SIZE >= units.length;
    const cents = chunk.reduce((t, u) => t + u.cents, 0);
    const ops = chunk.flatMap((u) => u.ops);
    if (cents > 0) ops.push(debtorReceiveOp(debtorId, cents, { status: last ? applied.status : 'open' }));
    try {
      ids.push(...await (io.commitAtomic ?? commitAtomic)(uid, ops, io));
      done += chunk.length;
    } catch (error) {
      console.error('[debtPayments] bloco de recebimentos recusado', error);
      return { ok: false, done, ids, error: error?.message ?? String(error), code: error?.code };
    }
  }
  return { ok: true, done, ids };
}

/** Resultado de erro de uma quitação em blocos que parou no meio (o que foi gravado permanece consistente). */
const partialFailure = (r, total) => ({
  ok: false, partial: r.done > 0, done: r.done, remaining: total - r.done, code: r.code,
  errors: { _form: r.done > 0
    ? `Quitação interrompida: ${r.done} de ${total} parcela(s) gravada(s) e consistentes; repita a operação para concluir as ${total - r.done} restante(s).`
    : 'A quitação foi recusada e nada foi gravado. Tente novamente.' },
});

/**
 * QUITA UMA parcela do devedor: `target` = { debtId } (parcela de dívida) ou { purchaseId } (parcela de compra no
 * cartão). Grava UM recebimento (`debtPayments`, com `debtId`/`purchaseId`, `date`, `accountId` e o valor
 * efetivamente recebido — padrão: o restante da parcela) e soma ao `receivedCents` do devedor, tudo em UM lote com
 * auditoria. Só a parcela escolhida muda: parcela de dívida vira `paid` quando o restante zera; parcela de cartão é
 * "paga" por derivação (recebido ≥ valor). Valor menor que o restante = recebimento parcial (parcela segue pendente).
 * DUPLICIDADE: (1) parcela já quitada é recusada; (2) cada recebimento tem ID exclusivo e sequencial
 * (`pay-<parcela>-<n>`, ver `receiptPaymentId`) — um segundo envio sobre a mesma leitura gera o mesmo ID e as Rules
 * (histórico imutável) negam o lote inteiro; (3) o devedor soma por `increment` atômico.
 * `rawData`: { date, accountId, amountCents? (pt-BR), notes? }. Retorna { ok, id, settled, remainingCents,
 * amountCents, debtorPaid, anticipated, errors }.
 */
export async function settleInstallment(uid, debtorId, target = {}, rawData = {}, io = {}) {
  const fetch = io.getById ?? getById;
  const installmentId = target.debtId ?? target.purchaseId;
  if (!installmentId || (target.debtId && target.purchaseId)) return { ok: false, errors: { _form: 'Informe a parcela a quitar.' } };
  const debtor = await fetch(uid, DEBTORS, debtorId);
  if (!debtor) return { ok: false, errors: { _form: 'Devedor não encontrado.' } };

  let ledger;
  try {
    // Idempotência PRIMEIRO: uma repetição de operação já gravada (que pode ter quitado o devedor) deve devolver o resultado.
    const done = await findOperationPayments(uid, debtorId, rawData.operationId, io);
    if (done.length) {
      const mine = done.find((p) => (p.debtId ?? p.purchaseId) === installmentId);
      if (!mine) return { ok: false, errors: { _form: 'Esta operação já foi usada em outra parcela; recarregue a tela.' } };
      return { ok: true, idempotent: true, id: mine.id, amountCents: mine.amountCents };
    }
    if (debtor.status !== 'open') return { ok: false, errors: { _form: debtor.status === 'paid' ? 'Devedor já quitado: não há parcelas a receber.' : 'Só é possível quitar parcelas de devedor em aberto.' } };
    ledger = await loadDebtorLedger(uid, debtor, io);
  } catch (error) {
    console.error('[debtPayments] falha ao ler recebimentos', error);
    return { ok: false, errors: { _form: 'Não foi possível verificar os recebimentos do devedor. A quitação foi cancelada por segurança; tente novamente.' } };
  }
  const source = target.debtId ? 'debt' : 'card';
  const item = debtorObligations(ledgerInput(debtor, ledger)).items.find((i) => i.source === source && i.id === installmentId);
  if (!item) return { ok: false, errors: { _form: 'Parcela não encontrada para este devedor.' } };
  if (item.status === 'paid' || item.remainingCents <= 0) return { ok: false, errors: { _form: 'Esta parcela já foi quitada.' } };
  if (item.status === 'cancelled') return { ok: false, errors: { _form: 'Esta parcela está cancelada.' } };

  const amountCents = rawData.amountCents === undefined || rawData.amountCents === ''
    ? item.remainingCents : parseMoneyToCents(rawData.amountCents);
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, errors: { amountCents: 'Informe um valor maior que zero.' } };
  if (amountCents > item.remainingCents) {
    return { ok: false, errors: { amountCents: `O valor excede o restante da parcela (${formatCents(item.remainingCents)}).` } };
  }
  const idField = target.debtId ? { debtId: installmentId } : { purchaseId: installmentId };
  const checked = await checkReceiptTarget(uid, rawData, { ...idField, debtorId }, fetch);
  if (!checked.ok) return checked;
  const built = buildEntity('debtPayments', { date: rawData.date, accountId: rawData.accountId, notes: rawData.notes, operationId: rawData.operationId, amountCents: centsToMoneyString(amountCents), ...idField, debtorId });
  if (!built.ok) return { ok: false, errors: built.errors };
  const applied = applyPaymentToDebtor(debtor, amountCents);
  if (!applied.ok) return { ok: false, errors: { amountCents: applied.error } };

  const settled = amountCents === item.remainingCents;
  const ops = [{ type: 'create', collection: PAYMENTS, data: built.data, docId: receiptPaymentId(installmentId, ledger.payments), action: settled ? 'settle' : 'receive' }];
  if (settled && source === 'debt') ops.push({ type: 'update', collection: DEBTS, docId: installmentId, data: { status: 'paid' }, action: 'pay' });
  ops.push(debtorReceiveOp(debtorId, amountCents, applied));
  const [id] = await (io.commitAtomic ?? commitAtomic)(uid, ops, io);
  const reconcile = await reconcileDebtorStatus(uid, debtorId, io);
  const anticipated = typeof item.dueDate === 'string' && built.data.date < item.dueDate;
  return { ok: true, id, settled, amountCents, remainingCents: item.remainingCents - amountCents, debtorPaid: applied.status === 'paid', anticipated, reconcile };
}

/** Máximo de parcelas por quitação em lote (escritas por parcela cabem no lote de 500 do Firestore). */
export const MAX_MONTH_SETTLE_ITEMS = 200;

/**
 * Parcelas por lote atômico. LIMITE REAL do Firestore: as Security Rules acessam documentos (`get`/`exists`/`getAfter`)
 * e um lote só pode acessar ~20 documentos; medido no emulador, 17 recebimentos passam e 20 são negados
 * (`permission-denied`). Blocos de 10 deixam folga. Cada bloco é ATÔMICO (recebimentos + parcelas + devedor juntos);
 * um mês maior é gravado em blocos e, se um bloco falhar, os anteriores seguem consistentes e repetir a operação
 * continua de onde parou (parcelas já quitadas são ignoradas).
 */
export const RECEIPT_BATCH_SIZE = 10;

/**
 * Parcelas pendentes de um mês de referência (prévia para a confirmação da tela). Puro sobre o razão já lido.
 * Retorna { items, count, totalCents } — o mesmo conjunto que `settleMonthInstallments` efetivaria.
 */
export function previewMonthSettlement({ debtor, ledger, month }) {
  return pendingInstallmentsOfMonth({ month, ...ledgerInput(debtor, ledger) });
}

/**
 * QUITA, em lote, TODAS as parcelas pendentes de um mês de referência ("AAAA-MM") do devedor: dívidas pelo
 * vencimento e compras de cartão pelo mês da fatura. Cada parcela recebe um recebimento com o seu restante e a
 * mesma `date`/`accountId`; parcelas de dívida viram `paid`; o devedor soma o total uma única vez. Parcelas já
 * pagas/canceladas e de outros meses não são tocadas. UM lote atômico (falhou → nada foi gravado). O conjunto é
 * recalculado a partir de uma leitura nova (não confia na prévia da tela), e cada recebimento usa o ID sequencial
 * da sua parcela (`receiptPaymentId`): repetir a operação não duplica (a parcela já está quitada; um envio concorrente
 * sobre a mesma leitura é negado pelas Rules). Parcela com recebimento PARCIAL entra pelo RESTANTE.
 * `rawData`: { date, accountId, notes? }. Retorna { ok, count, totalCents, month, debtorPaid, ids, errors }.
 */
export async function settleMonthInstallments(uid, debtorId, month, rawData = {}, io = {}) {
  const fetch = io.getById ?? getById;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '')) return { ok: false, errors: { _form: 'Mês de referência inválido (use AAAA-MM).' } };
  const debtor = await fetch(uid, DEBTORS, debtorId);
  if (!debtor) return { ok: false, errors: { _form: 'Devedor não encontrado.' } };
  let ledger;
  let done;
  try {
    done = await findOperationPayments(uid, debtorId, rawData.operationId, io);
    ledger = await loadDebtorLedger(uid, debtor, io);
  } catch (error) {
    console.error('[debtPayments] falha ao ler recebimentos', error);
    return { ok: false, errors: { _form: 'Não foi possível verificar os recebimentos do devedor. A quitação foi cancelada por segurança; tente novamente.' } };
  }
  const { items, totalCents } = previewMonthSettlement({ debtor, ledger, month });
  if (!items.length) {
    // Repetição de uma operação já concluída (ex.: resposta perdida): devolve o resultado, não grava nada.
    if (done.length) return { ok: true, idempotent: true, month, count: done.length, totalCents: done.reduce((t, p) => t + (Number(p.amountCents) || 0), 0), ids: done.map((p) => p.id) };
    return { ok: false, errors: { _form: debtor.status === 'paid' ? 'Devedor já quitado: não há parcelas a receber.' : 'Não há parcelas pendentes neste mês.' } };
  }
  if (debtor.status !== 'open') return { ok: false, errors: { _form: 'Só é possível quitar parcelas de devedor em aberto.' } };
  if (items.length > MAX_MONTH_SETTLE_ITEMS) return { ok: false, errors: { _form: `Quite em partes: máximo de ${MAX_MONTH_SETTLE_ITEMS} parcelas por vez.` } };
  const checked = await checkReceiptTarget(uid, rawData, { debtId: items.find((i) => i.source === 'debt')?.id, purchaseId: items.find((i) => i.source === 'card' && !items.some((x) => x.source === 'debt'))?.id, debtorId }, fetch);
  if (!checked.ok) return checked;
  const applied = applyPaymentToDebtor(debtor, totalCents);
  if (!applied.ok) return { ok: false, errors: { _form: applied.error } };

  const units = [];
  for (const item of items) {
    const idField = item.source === 'debt' ? { debtId: item.id } : { purchaseId: item.id };
    const built = buildEntity('debtPayments', { date: rawData.date, accountId: rawData.accountId, notes: rawData.notes, operationId: rawData.operationId, amountCents: centsToMoneyString(item.remainingCents), ...idField, debtorId });
    if (!built.ok) return { ok: false, errors: built.errors };
    const ops = [{ type: 'create', collection: PAYMENTS, data: built.data, docId: receiptPaymentId(item.id, ledger.payments), action: 'settle' }];
    if (item.source === 'debt') ops.push({ type: 'update', collection: DEBTS, docId: item.id, data: { status: 'paid' }, action: 'pay' });
    units.push({ ops, cents: item.remainingCents });
  }
  const written = await commitReceiptUnits(uid, debtorId, units, applied, io);
  const reconcile = await reconcileDebtorStatus(uid, debtorId, io);
  if (!written.ok) return { ...partialFailure(written, items.length), reconcile };
  return { ok: true, month, count: items.length, totalCents, debtorPaid: applied.status === 'paid', ids: written.ids, resumed: done.length > 0, reconcile };
}

/** Cancela parcela pendente/atrasada sem recebimentos. `paid` só nasce de recebimentos. */
export async function cancelDebt(uid, debtId, io = {}) {
  const debt = await (io.getById ?? getById)(uid, DEBTS, debtId);
  if (!debt) return { ok: false, errors: { _form: 'Parcela não encontrada.' } };
  if (!['pending', 'late'].includes(debt.status)) {
    return { ok: false, errors: { _form: 'Só é possível cancelar parcelas pendentes ou atrasadas.' } };
  }
  const received = await sumPayments(uid, debtId, io);
  if (received > 0) {
    return { ok: false, errors: { _form: 'A parcela já possui recebimentos e não pode ser cancelada.' } };
  }
  await updateAudited(uid, DEBTS, debtId, { status: 'cancelled' }, io, 'cancel');
  return { ok: true };
}

async function listPaymentsOfDebt(uid, debtId, io) {
  return (io.list ?? list)(uid, PAYMENTS, { where: [['debtId', '==', debtId]] });
}

async function sumPayments(uid, debtId, io) {
  const payments = await listPaymentsOfDebt(uid, debtId, io);
  return payments.reduce((total, p) => total + (Number(p.amountCents) || 0), 0);
}

/**
 * Registra um recebimento de uma parcela. Retorna { ok, id, debtPaid, debtorPaid, errors }.
 * `rawData`: { amountCents, date, accountId, notes? } (dinheiro como string pt-BR).
 * `io`: getById, list, commitAtomic injetáveis.
 */
export async function registerDebtPayment(uid, debtId, rawData, io = {}) {
  const fetch = io.getById ?? getById;
  const debt = await fetch(uid, DEBTS, debtId);
  if (!debt) return { ok: false, errors: { _form: 'Parcela não encontrada.' } };
  if (!['pending', 'late'].includes(debt.status)) {
    return { ok: false, errors: { _form: 'Esta parcela não aceita recebimentos.' } };
  }
  const debtor = await fetch(uid, DEBTORS, debt.debtorId);
  if (!debtor) return { ok: false, errors: { _form: 'Devedor não encontrado.' } };

  const { ok, data, errors } = buildEntity('debtPayments', { ...rawData, debtId, debtorId: debt.debtorId });
  if (!ok) return { ok: false, errors };

  const account = await fetch(uid, COLLECTIONS.accounts, data.accountId);
  if (!account) return { ok: false, errors: { accountId: 'Conta não encontrada.' } };
  if (account.status !== 'active') return { ok: false, errors: { accountId: 'A conta precisa estar ativa.' } };

  const applied = applyPaymentToDebtor(debtor, data.amountCents);
  if (!applied.ok) return { ok: false, errors: { amountCents: applied.error } };

  const history = await listPaymentsOfDebt(uid, debtId, io);
  const alreadyReceived = history.reduce((total, p) => total + (Number(p.amountCents) || 0), 0);
  const debtPending = debt.principalCents - alreadyReceived;
  if (data.amountCents > debtPending) {
    return { ok: false, errors: { amountCents: `O valor excede o saldo pendente da parcela (${formatCents(Math.max(0, debtPending))}).` } };
  }
  const debtPaid = data.amountCents === debtPending;

  // ID exclusivo e sequencial (`receiptPaymentId`): um segundo envio sobre a mesma leitura é negado pelas Rules.
  const ops = [{ type: 'create', collection: PAYMENTS, data, docId: receiptPaymentId(debtId, history) }];
  if (debtPaid) ops.push({ type: 'update', collection: DEBTS, docId: debtId, data: { status: 'paid' }, action: 'pay' });
  ops.push(debtorReceiveOp(debt.debtorId, data.amountCents, applied));

  const [id] = await (io.commitAtomic ?? commitAtomic)(uid, ops, io);
  const reconcile = await reconcileDebtorStatus(uid, debt.debtorId, io);
  // Antecipação (VF-2-03n): recebimento (total ou parcial) antes do vencimento da parcela.
  const anticipated = typeof debt.dueDate === 'string' && typeof data.date === 'string' && data.date < debt.dueDate;
  return { ok: true, id, debtPaid, debtorPaid: applied.status === 'paid', anticipated, reconcile };
}

export function getDebtStatusOptions() {
  return DEBT_STATUSES.map((s) => ({ value: s.value, label: s.label }));
}

export { formatCents, parseMoneyToCents };
