/**
 * Manutenção de dados (VF-2-03u): limpeza, massa de testes e importação/exportação CSV. Rota dedicada
 * `/manutencao-dados`, liberada só em ambiente local/emulador ou para e-mails de `maintenance-config.js`
 * (trava de interface; a segurança real são as Rules por uid). Toda ação destrutiva exige confirmação digitada.
 */
import { el, $, toast, refreshIcons } from '../core/ui.js';
import { field, mount, emptyBlock } from '../components/form-kit.js';
import { isMaintenanceAuthorized, CONFIRM_PHRASES } from '../utils/maintenance-config.js';
import { clearUserData, clearWholeDatabase, auditUserClear } from '../services/maintenance.js';
import { seedFullTestSuite, MAX_VOLUME } from '../services/seed.js';
import {
  IMPORT_ENTITIES, IMPORT_ENTITY_KEYS, MAX_IMPORT_ROWS,
  templateCsv, loadImportContext, dryRunImport, applyImport, exportCsv, exportAllCsv,
} from '../services/importer.js';
import { describeError } from '../utils/errors.js';

export const meta = { title: 'Manutenção de dados', icon: 'wrench' };

let user = null;
let lastPlan = null; // resultado do dry-run da última validação
let lastPlanText = null;

function downloadText(filename, text) {
  downloadBlob(filename, text, 'text/csv;charset=utf-8');
}

function downloadBlob(filename, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Área de log: uma linha por evento; `permission-denied` fica em destaque. */
function makeLog(id) {
  const box = el('div', { id, class: 'maint-log', role: 'log', 'aria-live': 'polite' });
  const write = (text, kind = 'info') => {
    const denied = /permission-denied/i.test(text);
    const line = el('div', { class: `maint-log__line maint-log__line--${denied ? 'denied' : kind}` });
    line.textContent = denied ? `⚠ PERMISSION-DENIED — ${text}` : text;
    box.append(line);
    box.scrollTop = box.scrollHeight;
  };
  return { box, write, clear: () => box.replaceChildren() };
}

export async function render(container, ctx) {
  user = ctx.user;
  if (!isMaintenanceAuthorized({ email: user?.email, hostname: location.hostname })) {
    mount(container, el('section', { class: 'panel' }, [
      el('div', { class: 'panel__body' }, [emptyBlock('lock', 'Acesso restrito', 'O painel de manutenção só está disponível em ambiente local/emulador ou para usuários autorizados em js/utils/maintenance-config.js.')]),
    ]));
    refreshIcons();
    return;
  }

  const cleanLog = makeLog('clean-log');
  const seedLog = makeLog('seed-log');
  const importLog = makeLog('import-log');
  const busy = new Set();
  const guard = (button, fn) => async () => {
    if (busy.size) { toast('Aguarde a operação em andamento.'); return; }
    busy.add(button);
    button.disabled = true;
    try { await fn(); } finally { busy.delete(button); button.disabled = false; }
  };

  // ---------------- Limpeza ----------------
  const modeUser = el('input', { type: 'radio', id: 'mode-user', name: 'clean-mode', value: 'user', checked: true });
  const modeDb = el('input', { type: 'radio', id: 'mode-db', name: 'clean-mode', value: 'database' });
  const extraUids = el('textarea', { id: 'extra-uids', rows: 2, placeholder: 'uids de outros usuários (um por linha) — serão TENTADOS e as Rules devem negar', 'aria-label': 'uids adicionais' });
  const cleanPhrase = el('input', { type: 'text', id: 'clean-phrase', autocomplete: 'off', placeholder: `Digite: ${CONFIRM_PHRASES.user}` });
  const cleanBtn = el('button', { type: 'button', id: 'btn-clean', class: 'btn btn--danger', text: 'Limpar' });
  const updatePlaceholder = () => { cleanPhrase.placeholder = `Digite: ${modeDb.checked ? CONFIRM_PHRASES.database : CONFIRM_PHRASES.user}`; };
  modeUser.addEventListener('change', updatePlaceholder);
  modeDb.addEventListener('change', updatePlaceholder);

  const logClear = (r) => {
    const base = `${r.collection}: ${r.deleted} apagado(s) em ${r.batches ?? 0} lote(s)`;
    if (r.error) cleanLog.write(`${base} — FALHA: ${r.error}${r.collection === 'auditLog' ? ' (auditLog é imutável por regra: create-only)' : ''}`, 'error');
    else cleanLog.write(base, 'ok');
  };
  cleanBtn.addEventListener('click', guard(cleanBtn, async () => {
    const whole = modeDb.checked;
    const phrase = whole ? CONFIRM_PHRASES.database : CONFIRM_PHRASES.user;
    if (cleanPhrase.value.trim() !== phrase) { toast(`Confirmação inválida. Digite exatamente: ${phrase}`, 5000); return; }
    cleanLog.clear();
    cleanLog.write(`Iniciando limpeza (${whole ? 'BANCO INTEIRO' : 'usuário'}) — uid ${user.uid}`);
    if (whole) {
      const uids = extraUids.value.split(/\s+/).filter(Boolean);
      const res = await clearWholeDatabase(user.uid, { extraUids: uids, onLog: (r) => (r.uid === user.uid ? logClear(r) : cleanLog.write(`${r.collection}: ${r.error ? `FALHA: ${r.error}` : 'sem erro (inesperado)'}`, r.error ? 'error' : 'info')) });
      cleanLog.write(`Concluído: ${res.deleted} documento(s) apagado(s). Outros usuários não são enumeráveis nem acessíveis pelo cliente (Rules): limpe-os com Admin SDK/Console.`);
    } else {
      const res = await clearUserData(user.uid, { onLog: logClear });
      await auditUserClear(user.uid, res).catch((e) => cleanLog.write(`auditoria-resumo não gravada: ${describeError(e)}`, 'error'));
      cleanLog.write(`Concluído: ${res.deleted} documento(s) apagado(s); ${res.failures} coleção(ões) com falha${res.permissionDenied ? ` (${res.permissionDenied} permission-denied)` : ''}.`);
    }
    cleanPhrase.value = '';
  }));

  const cleanPanel = el('section', { class: 'panel', id: 'panel-clean' }, [
    el('div', { class: 'panel__header' }, [el('h2', { text: 'Limpeza' })]),
    el('div', { class: 'panel__body' }, [
      el('p', { class: 'notice', role: 'alert', text: `Apaga dados REAIS do Firestore. Escopo: usuário autenticado (uid ${user.uid}).` }),
      el('label', {}, [modeUser, ' Meu usuário — apaga as coleções de domínio e tenta auditLog']),
      el('label', {}, [modeDb, ' Banco inteiro — meu usuário + tentativa nos uids informados (as Rules bloqueiam outros usuários)']),
      field('uids adicionais (modo banco inteiro)', 'extra-uids', extraUids),
      field('Confirmação digitada *', 'clean-phrase', cleanPhrase),
      cleanBtn,
      cleanLog.box,
    ]),
  ]);

  // ---------------- Massa de testes ----------------
  const volume = el('input', { type: 'number', id: 'seed-volume', min: 0, max: MAX_VOLUME, value: 0 });
  const seedBtn = el('button', { type: 'button', id: 'btn-seed', class: 'btn btn--primary', text: 'Gerar massa de testes' });
  const resetPhrase = el('input', { type: 'text', id: 'reset-phrase', autocomplete: 'off', placeholder: `Digite: ${CONFIRM_PHRASES.reset}` });
  const resetBtn = el('button', { type: 'button', id: 'btn-reset', class: 'btn btn--danger', text: 'Resetar + Gerar massa' });
  const runSeed = async () => {
    seedLog.write(`Gerando pacote de testes (volume ×${Number(volume.value) || 0})…`);
    const res = await seedFullTestSuite(user.uid, {
      volume: Number(volume.value) || 0,
      onLog: (s) => seedLog.write(`${s.ok ? '✔' : '✖'} ${s.name}${s.ok ? ` — ${s.detail ?? ''}` : ` — ${s.error}`}`, s.ok ? 'ok' : 'error'),
    });
    seedLog.write(`Fim: ${res.ok} etapa(s) ok, ${res.failed} com falha.`);
    return res;
  };
  seedBtn.addEventListener('click', guard(seedBtn, async () => { seedLog.clear(); await runSeed(); }));
  resetBtn.addEventListener('click', guard(resetBtn, async () => {
    if (resetPhrase.value.trim() !== CONFIRM_PHRASES.reset) { toast(`Confirmação inválida. Digite exatamente: ${CONFIRM_PHRASES.reset}`, 5000); return; }
    seedLog.clear();
    seedLog.write('Limpando meu usuário antes de gerar…');
    const res = await clearUserData(user.uid, { includeAudit: false, onLog: (r) => seedLog.write(`${r.collection}: ${r.deleted} apagado(s)${r.error ? ` — FALHA: ${r.error}` : ''}`, r.error ? 'error' : 'ok') });
    if (res.failures) { seedLog.write('Limpeza com falhas: geração cancelada.', 'error'); return; }
    await runSeed();
    resetPhrase.value = '';
  }));
  const seedPanel = el('section', { class: 'panel', id: 'panel-seed' }, [
    el('div', { class: 'panel__header' }, [el('h2', { text: 'Massa de testes' })]),
    el('div', { class: 'panel__body' }, [
      el('p', { class: 'card__hint', text: 'Contas, caixinha/metas, receitas, despesas, orçamentos (ok/atenção/estourado), cartões e faturas (aberta, fechada, paga, cancelada, consolidada), assinaturas, devedores e dívidas — pelos services do app.' }),
      field(`Volume (0–${MAX_VOLUME}; cada unidade = 20 despesas + 20 receitas)`, 'seed-volume', volume),
      seedBtn,
      field('Confirmação para resetar *', 'reset-phrase', resetPhrase),
      resetBtn,
      seedLog.box,
    ]),
  ]);

  // ---------------- Importação / exportação ----------------
  const entitySelect = el('select', { id: 'import-entity', 'aria-label': 'Entidade' }, IMPORT_ENTITY_KEYS.map((k) => el('option', { value: k }, IMPORT_ENTITIES[k].label)));
  const delimSelect = el('select', { id: 'import-delim', 'aria-label': 'Delimitador do modelo' }, [el('option', { value: ';' }, 'Ponto e vírgula (;)'), el('option', { value: ',' }, 'Vírgula (,)')]);
  const csvText = el('textarea', { id: 'import-text', rows: 8, placeholder: 'Cole o CSV aqui (UTF-8, ; ou ,) ou escolha um arquivo', 'aria-label': 'Conteúdo CSV' });
  const fileInput = el('input', { type: 'file', id: 'import-file', accept: '.csv,text/csv,text/plain' });
  fileInput.addEventListener('change', async () => { const f = fileInput.files?.[0]; if (f) { csvText.value = await f.text(); invalidatePlan(); } });
  csvText.addEventListener('input', invalidatePlan);
  const summary = el('div', { id: 'import-summary', class: 'card__hint', role: 'status' });
  const rowsBox = el('div', { id: 'import-rows' });
  const validateBtn = el('button', { type: 'button', id: 'btn-validate', class: 'btn btn--secondary', text: 'Validar (dry-run, não grava)' });
  const applyBtn = el('button', { type: 'button', id: 'btn-apply', class: 'btn btn--primary', text: 'Importar linhas válidas', disabled: true });

  function invalidatePlan() { lastPlan = null; lastPlanText = null; applyBtn.disabled = true; }

  const renderPlan = (plan) => {
    summary.textContent = `${plan.total} linha(s) lida(s): ${plan.valid} válida(s), ${plan.invalid} com erro, ${plan.warnings} aviso(s). Delimitador "${plan.delimiter}".`;
    const problems = [
      ...plan.fileErrors.map((e) => `Arquivo${e.line ? ` (linha ${e.line})` : ''}: ${e.message}`),
      ...plan.rows.flatMap((r) => [
        ...Object.entries(r.errors).map(([c, m]) => `Linha ${r.line} · ${c}: ${m}`),
        ...r.warnings.map((w) => `Linha ${r.line} · aviso: ${w}`),
      ]),
    ];
    rowsBox.replaceChildren(problems.length
      ? el('ul', { class: 'maint-problems' }, problems.map((p) => el('li', { text: p })))
      : el('p', { class: 'card__hint', text: 'Nenhum erro ou aviso.' }));
  };

  validateBtn.addEventListener('click', guard(validateBtn, async () => {
    importLog.clear();
    const ctxRefs = await loadImportContext(user.uid);
    const plan = dryRunImport(entitySelect.value, csvText.value, ctxRefs);
    renderPlan(plan);
    lastPlan = plan;
    lastPlanText = csvText.value;
    applyBtn.disabled = !(plan.valid > 0 && !plan.fileErrors.some((e) => e.line === 1 && plan.missingColumns.length));
    importLog.write(`Dry-run de "${IMPORT_ENTITIES[plan.key].label}": nada foi gravado.`);
  }));
  applyBtn.addEventListener('click', guard(applyBtn, async () => {
    if (!lastPlan || lastPlanText !== csvText.value) { toast('Valide o conteúdo atual antes de importar.', 4000); return; }
    importLog.clear();
    importLog.write(`Importando ${lastPlan.valid} linha(s) válida(s) de "${IMPORT_ENTITIES[lastPlan.key].label}"…`);
    const res = await applyImport(user.uid, lastPlan, {
      onLog: (e) => importLog.write(`Linha ${e.line}: ${e.ok ? `criada${e.id ? ` (${e.id})` : ''}` : `FALHA — ${e.message}`}`, e.ok ? 'ok' : 'error'),
    });
    importLog.write(`Fim: ${res.created} criada(s), ${res.failed} falha(s)${res.permissionDenied ? ` (${res.permissionDenied} permission-denied)` : ''}.`);
    invalidatePlan();
  }));

  const templateBtn = el('button', { type: 'button', id: 'btn-template', class: 'btn btn--secondary', text: 'Baixar modelo CSV (vazio — só cabeçalhos)' });
  templateBtn.addEventListener('click', () => {
    downloadText(`modelo-${entitySelect.value}.csv`, templateCsv(entitySelect.value, { delimiter: delimSelect.value }));
    importLog.write(`Modelo VAZIO de "${IMPORT_ENTITIES[entitySelect.value].label}" baixado (somente cabeçalhos, nenhum dado).`);
  });
  const exportBtn = el('button', { type: 'button', id: 'btn-export', class: 'btn btn--secondary', text: 'Exportar CSV da base atual (registros existentes)' });
  exportBtn.addEventListener('click', guard(exportBtn, async () => {
    const r = await exportCsv(user.uid, entitySelect.value, { delimiter: delimSelect.value });
    downloadText(r.filename, r.text);
    importLog.write(`Exportados ${r.rowCount} registro(s) existente(s) de "${IMPORT_ENTITIES[entitySelect.value].label}" (${r.filename}).`, 'ok');
  }));
  const exportAllBtn = el('button', { type: 'button', id: 'btn-export-all', class: 'btn btn--primary', text: 'Exportar TODAS as entidades (.zip)' });
  exportAllBtn.addEventListener('click', guard(exportAllBtn, async () => {
    importLog.clear();
    importLog.write(`Exportando as ${IMPORT_ENTITY_KEYS.length} entidades (registros existentes)…`);
    const res = await exportAllCsv(user.uid, {
      delimiter: delimSelect.value,
      onLog: (r) => importLog.write(r.ok ? `✔ ${r.label}: ${r.rowCount} registro(s) → ${r.filename}` : `✖ ${r.label}: FALHA — ${r.error}`, r.ok ? 'ok' : 'error'),
    });
    if (res.exported) downloadBlob(res.filename, res.zip, 'application/zip');
    importLog.write(`Fim: ${res.exported}/${IMPORT_ENTITY_KEYS.length} entidade(s) exportada(s), ${res.totalRows} registro(s) no total${res.failed ? `, ${res.failed} com falha (fora do pacote)` : ''}${res.exported ? ` — arquivo ${res.filename}` : ''}.`, res.failed ? 'error' : 'ok');
  }));

  const hint = () => IMPORT_ENTITIES[entitySelect.value].columns.map((c) => `${c.name}${c.required ? '*' : ''}${c.help ? ` (${c.help})` : ''}`).join(' · ');
  const columnsHint = el('p', { class: 'card__hint', id: 'import-columns', text: hint() });
  entitySelect.addEventListener('change', () => { columnsHint.textContent = hint(); invalidatePlan(); });

  const importPanel = el('section', { class: 'panel', id: 'panel-import' }, [
    el('div', { class: 'panel__header' }, [el('h2', { text: 'Importação e exportação CSV' })]),
    el('div', { class: 'panel__body' }, [
      el('p', { class: 'card__hint', text: `Datas AAAA-MM-DD; valores em reais (1234,56 / 1.234,56) convertidos para centavos inteiros; referências por NOME (conta, categoria, cartão, devedor). Máx. ${MAX_IMPORT_ROWS} linhas por importação. Importe na ordem: contas → categorias → cartões → devedores → demais.` }),
      field('Entidade', 'import-entity', entitySelect),
      columnsHint,
      field('Delimitador do modelo/exportação', 'import-delim', delimSelect),
      el('p', { class: 'card__hint', id: 'import-explain', text: 'Modelo CSV = arquivo VAZIO, só com os cabeçalhos da entidade (nenhum dado). Exportar CSV da base atual = os REGISTROS JÁ EXISTENTES da entidade selecionada. "Exportar todas" gera um .zip com um CSV por entidade (as 11) mais _resumo.txt.' }),
      el('div', {}, [templateBtn, ' ', exportBtn, ' ', exportAllBtn]),
      field('Arquivo CSV', 'import-file', fileInput),
      field('Ou cole o CSV', 'import-text', csvText),
      el('div', {}, [validateBtn, ' ', applyBtn]),
      summary,
      rowsBox,
      importLog.box,
    ]),
  ]);

  mount(container,
    el('section', { class: 'panel' }, [el('div', { class: 'panel__header' }, [el('div', {}, [el('h2', { text: 'Manutenção de dados' }), el('p', { class: 'card__hint', text: 'Painel interno: limpeza, massa de testes e importação/migração CSV. Afeta apenas o usuário autenticado.' })])])]),
    cleanPanel, seedPanel, importPanel);
  refreshIcons();
}
