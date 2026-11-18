# PLAN.md — Estado operacional do Vault Finance

Última auditoria: 2026-11-18 (branch `claude`). Somente diagnóstico; nenhum código alterado.
Legenda de confiança: **[C]** comprovado por leitura do código · **[R]** risco potencial · **[M]** melhoria · **[NV]** não verificado.
Convenção de IDs: `VF-<fase>-<nn>`. Preservar IDs; não remover tarefas concluídas.

## Diagnóstico

- Propósito: controle financeiro pessoal (contas, receitas, despesas, transferências, categorias) por usuário.
- Stack: HTML/CSS/JS ES Modules puro, Firebase Auth + Firestore (SDK 10.12.2 via CDN/importmap), Vercel estático, npm só para dev.
- Maturidade: fases 2–4 (etapa 2) entregues; 6 módulos ainda são casca (dashboard, devedores, metas, cartões, relatórios, orçamentos); assinaturas (VF-2-03a) e devedores (VF-2-03b) entregues.
- Testes: 44 de modelo passam (executado); testes de serviço e Rules **não executados** (sem `node_modules`; emulador exige instalação).
- Sem lint, sem CI, sem build.

## Gap Analysis

- **Ausentes:** dashboard real, assinaturas, devedores/dívidas, metas, cartões/faturas, orçamentos, relatórios, import/export, backup, perfil/settings persistidos (`js/modules/configuracoes.js`), busca global (`js/components/topbar.js:21`).
- **Fluxos incompletos:** exclusão de conta sem checar vínculos; confirmação de transferência sem validação de transição; persistência de tema/perfil.
- **Segurança:** auditoria nunca persiste (VF-1-01); ausência de CSP e SRI em scripts de CDN; criação de contas abertas (App Check previsto na Fase 6).
- **Falhas funcionais:** ver VF-1-01, VF-1-02, VF-2-01, VF-2-02.
- **Testes:** sem testes de UI; testes de serviço não entram em nenhum script npm; sem teste que valide o payload de auditoria contra as Rules.
- **Arquitetura:** CRUD repetido entre services (accounts/incomes/expenses/transfers/categories); módulos de 570–640 linhas misturando render, estado e handlers.

## Débitos técnicos

- ~~[Impacto: Crítico] js/services/firestore.js:144 + firestore.rules:438-449 — `writeAudit` envia `collection/docId/before/after`; as Rules só aceitam `action/entity/entityId/actorUid/createdAt` (schema fechado) → toda gravação de auditoria é negada e o `catch` apenas faz `console.warn`. Auditoria inexistente em produção [C] → alinhar payload ao schema (ou ajustar Rules com teste), e tornar a falha visível.~~ (resolvido em VF-1-01)
- ~~[Impacto: Alto] js/services/accounts.js:73-87 e js/modules/bancos.js:356 — `deleteAccount` não verifica vínculos; a UI afirma que "as Security Rules impedirão", mas as Rules (`firestore.rules:152`) permitem `delete` ao dono [C]. Excluir conta deixa receitas/despesas/transferências órfãs e distorce `accountBalances` (`js/core/model.js:339-357`, ignora ids desconhecidos) → aplicar o mesmo padrão fail-closed de `deleteCategory` (`js/services/categories.js:140-165`) e corrigir o texto.~~ (resolvido em VF-1-02)
- ~~[Impacto: Alto] package.json:9 — `node --test tests/rules` (diretório) falha em Node 22 ("Cannot find module") [C, reproduzido para o formato de diretório]; README declara Node 18+ → usar glob `tests/rules/*.mjs` e fixar `engines`.~~ (resolvido em VF-4-01)
- ~~[Impacto: Médio] js/services/transfers.js:88-110 — `confirmTransfer`/`cancelTransfer` fazem `update` sem ler o estado atual: permite confirmar transferência cancelada e não revalida contas existentes (o `exists()` das Rules cobre a existência, não a transição) [C] → validar transição de status.~~ (resolvido em VF-2-01)
- [Impacto: Médio] vercel.json:3-30 — sem `Content-Security-Policy`; scripts de `unpkg.com` (lucide, `pages/*.html:18`) e `gstatic.com` (SDK) sem SRI [C]; `innerHTML` só com literais próprios (`js/core/ui.js:10`) [sem XSS comprovado] → CSP restritiva + SRI/versão fixa; avaliar vendorizar lucide.
- [Impacto: Médio] vercel.json:16-27 — não há rewrite para `/categorias` apesar de existir em `js/utils/nav.js` [R]: com `cleanUrls` os links relativos `categorias.html` funcionam, mas a rota limpa fica inconsistente com as demais [NV em deploy].
- [Impacto: Médio] js/modules/{bancos,receitas,despesas,transferencias}.js — `list*` sem `limit`/paginação e saldo calculado no cliente varrendo todas as coleções (README:5 cota Spark 50k leituras/dia) [R].
~~- [Impacto: Médio] js/services/firestore.js:32-40 — `toFirestoreData` converte qualquer string `YYYY-MM-DD` (inclusive `description`/`notes` que casem o padrão) e usa `T12:00:00` local; `fromFirestoreDoc` usa `toISOString` (UTC) — risco de deslocar um dia em fusos extremos [R].~~ (resolvido em VF-3-03)
- [Impacto: Médio] js/services/{accounts,incomes,expenses,transfers,categories}.js — update sem checar existência/concorrência; auditoria grava `after` completo (dados financeiros duplicados) [M].
- [Impacto: Baixo] js/services/accounts.js:95-102 — `getStatusOptions` duplica enum do modelo (`js/core/model.js`) [M].
- [Impacto: Baixo] js/modules/bancos.js:51 — comentário "Por simplicidade Fase 3" indica carga ansiosa de movimentos; `js/core/ui.js:43` mensagem "Disponível na Fase 3" já defasada [M].
- [Impacto: Baixo] README.md:30-31,98-103 — desatualizado: lista 24 testes só de Rules, não cita categorias nem testes de modelo/serviço; diz "Fase atual: 2" [C].
- [Impacto: Baixo] firebase.json — sem bloco `hosting`/`rules` de teste; sem `.firebaserc` (projeto selecionado manualmente) [NV].

## Roadmap

### Fase 1 — Segurança, integridade e falhas críticas

- [x] **VF-1-01 — Auditoria nunca persiste** (Crítico) — CONCLUÍDA 2026-11-18
- Problema: payload de `writeAudit` viola schema fechado de `auditLog`; falha engolida.
- Solução: padronizar `entry` como `{action, entity, entityId}` (e decidir se `before/after` entram na Rule com limite de tamanho); manter `try/catch` mas expor falha ao usuário/log; ajustar chamadas em 5 services.
- Arquivos: `js/services/firestore.js`, `js/services/{accounts,categories,incomes,expenses,transfers}.js`, `firestore.rules`, `tests/rules/firestore.rules.test.mjs`, `tests/services/*`.
- Dependências: nenhuma (decisão de produto sobre `before/after` antes de mexer nas Rules).
- Aceite: teste de Rules cria entrada com o payload real do service e passa; testes de serviço verificam o shape; `npm run test:rules` verde; deploy das Rules documentado.

- [x] **VF-1-02 — Exclusão de conta com vínculos** (Alto) — concluída
- Problema: ver Débitos; contas excluídas deixam referências órfãs.
- Solução: contar vínculos em incomes/expenses/transfers (origem e destino) fail-closed como `deleteCategory`; corrigir texto de `bancos.js:356`; sugerir arquivar (`status: archived`).
- Arquivos: `js/services/accounts.js`, `js/modules/bancos.js`, `tests/services/accounts.test.mjs`.
- Dependências: nenhuma.
- Aceite: testes cobrem conta em uso (bloqueia), sem uso (exclui) e falha de verificação (bloqueia).
- Resolução: `deleteAccount` (`js/services/accounts.js`) conta vínculos via `count()` em incomes, expenses, transfers (origem e destino), subscriptions, debtPayments e goalTransactions (todas com `ref(...'accounts')` nas Rules); bloqueia com mensagem por coleção, fail-closed em erro de contagem, sem remover nem auditar. Texto de `bancos.js` corrigido (sugere arquivar). `firestore.rules` NÃO alterado: Rules não consultam/contam coleções no `delete`; teste de Rules documenta o contrato. Limitação: checagem client-side com janela de concorrência (mesma de `deleteCategory`). Sem deploy de Rules necessário. Testes: `test:unit` 109 ok, `test:rules` 28 ok.

- [x] **VF-1-03 — Cabeçalhos de segurança (CSP/SRI)** (Médio) — concluída
- Solução: CSP em `vercel.json` compatível com importmap injetado por JS e com gstatic/unpkg; SRI ou versão fixa/vendorizada para lucide.
- Arquivos: `vercel.json`, `pages/*.html`, `js/importmap.js`.
- Dependências: validar em deploy preview. Aceite: páginas carregam sem violação CSP no console; `X-Frame-Options`/CSP presentes.
- Resolução: CSP em `vercel.json` (default-src 'self'; script-src 'self' + hash sha256 do import map injetado + gstatic/unpkg/apis.google.com, sem unsafe-inline/eval; connect-src só Firebase; object-src 'none'; frame-ancestors 'none'; form-action/base-uri 'self'). SRI sha384 + `crossorigin="anonymous"` no lucide (12 páginas em `pages/*.html`) e `integrity` no import map (`js/importmap.js`) para os 3 módulos Firebase 10.12.2 (hashes calculados do pacote npm `firebase@10.12.2`). Teste de sincronia: `tests/services/security-headers.test.mjs` (6 ok). Validação local (Chromium + servidor com o CSP, CDNs servidos via cópia npm): sem violações de CSP, módulos Firebase e lucide carregam com SRI. Ressalvas: `style-src 'unsafe-inline'` mantido (atributos `style=` em `index.html`); o gstatic estava inacessível no sandbox, então os hashes do Firebase assumem arquivo idêntico ao pacote npm — **confirmar em deploy preview** (aceite original). Ao trocar `FIREBASE_VERSION`, recalcular hashes e o hash CSP (o teste falha se divergirem).

### Fase 2 — Funcionalidades incompletas e correções

- [x] **VF-2-01 — Transições de status de transferência** (Médio): validar leitura do estado antes de confirmar/cancelar. Arquivos: `js/services/transfers.js`, `tests/services/transfers.test.mjs`. Aceite: confirmar cancelada é rejeitado, testado. — CONCLUÍDA 2026-11-18
- Resolução: `confirmTransfer`/`cancelTransfer` (`js/services/transfers.js`) leem o estado atual e validam a transição (`TRANSFER_TRANSITIONS`: pending→confirmed|cancelled, confirmed→cancelled, cancelled terminal); confirmar revalida a existência das contas de origem/destino, fail-closed; sem update/auditoria quando rejeitado. `transferencias.js` exibe a mensagem do service. Rules não alteradas (não validam transição); limitação: leitura+escrita não atômica. Testes: `test:unit` 124 ok (9 novos em `tests/services/transfers.test.mjs`).
- [x] **VF-2-02 — Persistir perfil/settings/tema** (Médio): implementar `profile/main` e `settings/main` (Rules já existem). Arquivos: `js/modules/configuracoes.js`, `js/components/theme.js`, `js/services/firestore.js`. Dependências: VF-1-01. Aceite: tema e perfil sobrevivem a reload e a novo dispositivo. — CONCLUÍDA 2026-11-18
- Resolução: novo `js/services/preferences.js` (`getProfile/getSettings/saveProfile/saveSettings`, validação espelhando as Rules, `io` injetável, auditoria `create`/`update` com entidade `profile`/`settings`; na criação grava `createdAt` e defaults exigidos pelas Rules — `theme: 'system'`, `currency BRL`, `locale pt-BR`; no update não reenvia `createdAt`; e-mail do perfil vem do Auth e não é editável). `js/components/theme.js`: preferência `light|dark|system` (`resolveTheme`, `applyThemePreference`), cache em localStorage só contra flash e `setThemePersister`; `js/app.js` aplica o tema salvo na conta após a sessão (novo dispositivo) e o botão da barra persiste em `settings/main`. `js/modules/configuracoes.js`: formulário real de nome + tema. `firestore.rules` NÃO alterado; 7 testes de Rules novos documentam o contrato. Testes: `test:unit` 143 ok, `test:rules` 35 ok. Fora de escopo: `hideValues`/`firstWeekday` têm suporte no service mas não na UI. Pendente: validar reload/novo dispositivo em navegador com emulador.
**VF-2-03 — Módulos pendentes** (feature): assinaturas, devedores, metas, cartões, dashboard, relatórios, orçamentos conforme roadmap do README (fases 3–5). Cada módulo vira tarefa própria (`VF-2-03a…`) quando priorizado. Dependências: VF-1-01, VF-3-01.
- [x] **VF-2-03a — Assinaturas** (feature) — CONCLUÍDA 2026-11-18. Primeiro da fila: schema já fechado em `firestore.rules:238` e a página de assinaturas é a menos acoplada (sem saldo/fatura).
- Resolução: schema `subscriptions` em `js/core/model.js` (+ `REF_FIELDS`; enums `SUBSCRIPTION_PERIODICITIES/STATUSES` em `js/utils/constants.js`); cálculos puros `subscriptionAnnualCents/MonthlyCents/summarizeSubscriptions` (só ativas; semanal ×52, anual ÷12, centavos inteiros, projeção anual soma exata). Novo `js/services/subscriptions.js`: `list/get/create/update/delete` via `createAudited/updateAudited/removeAudited` (`io`/`deps` injetáveis; categoria lida do Firestore e restrita a `expense|both`), `pause/resume/cancel` com leitura prévia e transição validada (ativa⇄pausada, cancelada terminal, fail-closed, auditoria `pause|resume|cancel`). Campo de data `nextChargeDate` (convenção `*Date`, meio-dia UTC). UI: `js/modules/assinaturas.js` (cards mensal/anual, tabela, modal criar/editar, pausar/retomar/cancelar/excluir). `firestore.rules` NÃO alterado; 4 testes de Rules novos documentam o contrato (payload real do service). `deleteAccount` já bloqueia conta com assinaturas (VF-1-02). Testes: `test:unit` 205 ok (17 novos em `tests/services/subscriptions.test.mjs`), `test:rules` 39 ok. Não verificado: UI em navegador com emulador; sem testes de UI. Limitações: `nextChargeDate` não avança sozinha após a cobrança (sem geração de despesa) e `deleteCategory` não conta assinaturas (ver VF-2-03b+).
- [x] **VF-2-03b — Devedores** (feature) — CONCLUÍDA 2026-11-18 (escopo: coleção `debtors`; parcelas e recebimentos movidos para VF-2-03b2).
- Resolução: schema `debtors` em `js/core/model.js` (`DEBTOR_STATUSES` em `constants.js`; `receivedCents` não negativo e `<= lentCents`, espelhando `firestore.rules:259`); cálculos puros `debtorPendingCents/summarizeDebtors` (a receber = só em aberto; cancelados fora) e `centsToMoneyString` (o parser trata número como reais — nunca reenviar centavos crus). Novo `js/services/debtors.js`: `create` força `receivedCents: 0`/`status: open`; `update` lê o estado, só edita em aberto, preserva recebido/status e rejeita `lentCents < receivedCents`; `cancel/reopen` com transição validada (`paid` reservado a recebimentos; auditoria `cancel|reopen`); `delete` bloqueia com `debts`/`debtPayments` vinculados (fail-closed). Todos via `createAudited/updateAudited/removeAudited` com `io` injetável; `loanDate` meio-dia UTC. UI: `js/modules/devedores.js`. `firestore.rules` NÃO alterado; 5 testes de Rules novos documentam o contrato. Testes: `test:unit` 221 ok (16 novos em `tests/services/debtors.test.mjs`), `test:rules` 44 ok. Não verificado: UI em navegador com emulador. Limitação: `receivedCents` fica em 0 até VF-2-03b2; editar `notes` para vazio não remove o campo (update é merge, igual às assinaturas).
- [x] **VF-2-03b2 — Parcelas e recebimentos de devedores** (feature) — CONCLUÍDA 2026-11-18.
- Resolução: schemas `debts`/`debtPayments` em `js/core/model.js` (novo kind `int` p/ `installmentNumber` 1..360; `DEBT_STATUSES` em `constants.js`; `REF_FIELDS`); puro `applyPaymentToDebtor` (só devedor aberto, valor ≤ pendente, `paid` ao zerar). Novo `js/services/debtPayments.js`: `createDebt` (status forçado `pending`, devedor existente e aberto, numeração automática), `cancelDebt` (só pendente/atrasada sem recebimentos), `registerDebtPayment` — lê parcela, devedor e conta (ativa), valida valor contra pendente do devedor e da parcela (soma dos recebimentos anteriores) e grava em UM lote (`commitAtomic` em `firestore.js`): recebimento + parcela `paid` (se completou) + devedor `receivedCents`/`status` + auditorias (`create`/`pay`/`receive`) no mesmo lote. Decisão: recebimentos ENTRAM em `accountBalances` (novo parâmetro `debtPayments`, retrocompatível). `*Date` em meio-dia UTC. `firestore.rules` NÃO alterado; 4 testes de Rules novos (lote atômico, rollback por excesso, schema de parcelas/recebimentos, isolamento). Testes: `test:unit` 236 ok (15 novos em `tests/services/debtPayments.test.mjs`), `test:rules` 48 ok. Não verificado: UI. Limitações: sem UI para parcelas/recebimentos (pendente); recebimento sem estorno e sem edição; leitura prévia + lote sem transação (janela de concorrência; Rules não validam somas); `late` não é calculado automaticamente; `bancos.js` ainda não carrega `debtPayments` (saldo na UI segue stub).
- [x] **VF-2-03c — Metas** (feature) — CONCLUÍDA 2026-11-18 (escopo: modelo, service e testes; UI pendente).
- Resolução: schemas `goals`/`goalTransactions` em `js/core/model.js` (+ `REF_FIELDS`; `GOAL_STATUSES`/`GOAL_TRANSACTION_TYPES` em `constants.js`; `deadline` e `date` em meio-dia UTC); puros `goalSavedCents` (aportes − resgates, derivado, nunca gravado), `goalProgressPercent`, `applyGoalTransaction`. Novo `js/services/goals.js`: `createGoal` (status forçado `active`, conta opcional validada), `updateGoal` (só ativa; preserva status; rejeita alvo ≤ guardado), `deleteGoal` (bloqueia com movimentações, fail-closed), `setGoalStatus/cancel/reopen` (`completed` reservado a aportes; não reabre com alvo já coberto), `registerGoalTransaction/deposit/withdraw` atômico via `commitAtomic` (movimentação + status `completed`/reativação + auditorias `create`/`complete`/`reopen` no mesmo lote; aporte só em meta ativa, resgate ≤ guardado, conta ativa). Decisão: aporte reduz e resgate devolve saldo da conta em `accountBalances` (novo parâmetro `goalTransactions`); `ACCOUNT_LINK_QUERIES` agora inclui `goals.accountId`. `firestore.rules` NÃO alterado; 5 testes de Rules novos. Testes: `test:unit` 250 ok (14 novos em `tests/services/goals.test.mjs`), `test:rules` 53 ok. Não verificado: UI. Limitações: sem UI de metas (módulo ainda casca); movimentações imutáveis (sem estorno); leitura prévia + lote sem transação; remover conta/prazo de meta via edição não limpa o campo (update é merge).
- [ ] **VF-2-03d — Cartões/faturas**.
- [ ] **VF-2-03e — Orçamentos**.
- [ ] **VF-2-03f — Dashboard** (agrega módulos anteriores) e **VF-2-03g — Relatórios** (por último).
- [ ] **VF-2-03h — Follow-ups de assinaturas**: avançar `nextChargeDate` ao registrar cobrança; `deleteCategory` contar `subscriptions`.
- [x] **VF-2-04 — Rota limpa `/categorias`** (Baixo): adicionar rewrite em `vercel.json`. Aceite: `/categorias` abre a página no preview. — CONCLUÍDA 2026-11-18
- Resolução: rewrite `/categorias` → `/pages/categorias.html` adicionado em `vercel.json` (mesmo padrão das demais). Validado só o JSON/arquivo de destino; **abrir no deploy preview** (aceite).

### Fase 3 — Arquitetura, qualidade e refatoração

- [x] **VF-3-01 — Reduzir duplicação nos services** (Médio) — CONCLUÍDA 2026-11-18: extrair helper de create/update/delete com auditoria reutilizando `firestore.js`, sem mudar API pública. Arquivos: `js/services/*.js`. Dependências: VF-1-01. Aceite: testes existentes passam sem alteração; diff líquido de linhas negativo.
- Resolução: `createAudited`/`updateAudited`/`removeAudited` em `js/services/firestore.js` (`io` injetável; `updateAudited` aceita `action` para `confirm`/`cancel`/`mark_*`). `accounts`, `categories`, `transfers`, `incomes`, `expenses` os usam; payload de auditoria idêntico ao anterior (Rules inalteradas). Compatível: `deps` de incomes/expenses e `io` de transfers/deleteAccount continuam valendo; novos parâmetros opcionais `io` em create/update/delete/mark/cancel e `countCategoryUsage(…, countFn)`. Diff líquido do código: −125 linhas (83+/208−, sem contar testes). Testes: `test:unit` 172 ok (27 novos em `tests/services/crud-audit.test.mjs`; os 143 anteriores sem alteração), `test:rules` 35 ok. Fora de escopo: `preferences.js` (singleton) e `markIncomeReceived/markExpensePaid/cancel*` sem leitura prévia de estado (ver débito de concorrência). **Desbloqueia VF-2-03.**
**VF-3-02 — Dividir módulos extensos** (Baixo): separar render/estado/handlers em `receitas.js`, `despesas.js`, `transferencias.js`, `bancos.js` apenas se for tocar nesses arquivos por outra tarefa (evitar refatoração oportunista). Aceite: comportamento idêntico, testes verdes.
- [x] **VF-3-03 — Tratamento de datas** (Médio) — CONCLUÍDA 2026-11-18: restringir conversão ISO→Timestamp a campos de data conhecidos (por schema) e tratar fuso. Arquivos: `js/services/firestore.js`, `js/core/model.js`. Aceite: testes para strings livres e para virada de dia.
- Resolução: conversão ISO→Timestamp restrita a campos de data (`date` e `*Date`, `isDateFieldName` em `js/utils/dates.js`) — texto livre (`description`, `notes`, `reason`) nunca é convertido. Datas gravadas como meio-dia **UTC** (`parseIsoDate`, valida data de calendário real) e lidas em UTC (`dateToIsoDate`): o dia não desloca em nenhum fuso (testado UTC, São Paulo, Los Angeles, Pago Pago, Kiritimati, Kolkata, Auckland). Data inválida em campo de data lança `RangeError` em vez de gravar string. Dados legados (meio-dia local em fusos UTC−12…+11) continuam lendo o mesmo dia. `isValidIsoDate` (modelo) agora delega a `parseIsoDate` (sem duplicar). `toFirestoreData`/`fromFirestoreDoc` exportados para teste. Rules inalteradas. Convenção para módulos novos: campos de data devem se chamar `date` ou `*Date`. Testes: `test:unit` 188 ok (16 novos em `tests/services/dates.test.mjs`), `test:rules` 35 ok.
**VF-3-04 — Atualizar README e mensagens defasadas** (Baixo). Arquivos: `README.md`, `js/core/ui.js:43`, `js/components/topbar.js:21`. Aceite: README descreve fase atual, testes reais e Node suportado.

### Fase 4 — Testes, performance e otimização

- [x] **VF-4-01 — Scripts de teste confiáveis** (Alto) — CONCLUÍDA 2026-11-18: scripts `test:model`, `test:services` e `test:rules` com glob, `engines.node`, sem alterar dependências. Arquivos: `package.json`. Aceite: `npm test` roda os três em Node 18 e 22 (sem alterar lockfile).
**VF-4-02 — CI** (Médio): workflow rodando testes de modelo/serviço e Rules no emulador. Dependências: VF-4-01 e aprovação de nova ferramenta/arquivo. Aceite: pipeline verde no PR.
**VF-4-03 — Paginação e limites de leitura** (Médio): `limit`/filtro por mês nas listagens; saldo incremental/cache revalidado. Arquivos: módulos e services listados. Aceite: leituras por carga de página medidas e dentro de orçamento definido.
**VF-4-04 — Testes de UI (Playwright)** (Baixo): fluxos login → criar conta → receita → saldo. Dependências: aprovação de dependência.
**VF-4-05 — Lint/formatação** (Baixo): avaliar ESLint/Prettier (requer aprovação).

### Registro de execução

- **VF-1-01** (opção A, `before`/`after` completos): `writeAudit` (`js/services/firestore.js`) agora grava `{action, entity, entityId, before?, after?, actorUid, createdAt}` mapeando `collection→entity` e `docId→entityId` (call sites dos 5 services inalterados), remove `undefined` e, em falha, registra `console.error` e devolve `{ok:false, error}` (não lança, para não sinalizar erro após a escrita principal ter sucesso). `firestore.rules` aceita `before`/`after` opcionais do tipo map. Validação: 3 novos testes de Rules (payload com before/after, não-map negado, formato antigo negado). Limite conhecido: sem teste unitário do `writeAudit` contra o SDK (a cobertura do payload está nas Rules). **As Rules precisam ser publicadas** (`firebase deploy --only firestore:rules`) para valer em produção — não executado.
- **VF-4-01**: scripts `test`, `test:unit` (modelo + serviços, 98 testes) e `test:rules` com glob; `engines.node >=18`. Validação: `npm run test:unit` 98/98; `npm run test:rules` 27/27 no Node 22. Node 18 não testado.

## Itens não verificados

- Node 18 (suíte só executada no Node 22); deploy das Rules em produção.
- Comportamento real em Vercel (headers, rotas) e Firestore de produção (Rules publicadas podem divergir de `firestore.rules`).
- Acessibilidade e responsividade (CSS/HTML não auditados em detalhe).
- Módulos `receitas.js`, `despesas.js`, `transferencias.js`, `categorias.js` e `model.js` lidos apenas por busca/trechos.

## Histórico

- 2026-11-18 — VF-2-03a concluída (Assinaturas: modelo, service, UI, testes); VF-2-03b…h listadas.
- 2026-11-18 — VF-2-03b concluída (Devedores); VF-2-03b2 (parcelas/recebimentos) criada.
- 2026-11-18 — VF-3-03 concluída (datas: só campos de data, meio-dia UTC).
- 2026-11-18 — VF-3-01 concluída (helpers CRUD+auditoria; desbloqueia VF-2-03).
- 2026-11-18 — VF-4-01 e VF-1-01 concluídas (ver Registro de execução).
- 2026-11-18 — Criado `CLAUDE.md` (commit 062e13b) e primeira versão deste plano. 16 tarefas: 3 (Fase 1), 4 (Fase 2), 4 (Fase 3), 5 (Fase 4) — ver IDs acima.
- 2026-11-18 — VF-2-03b2 concluída (parcelas e recebimentos: modelo, service atômico, testes); UI de parcelas/recebimentos ainda pendente.
- 2026-11-18 — VF-2-03c concluída (metas: modelo, service atômico, testes); UI de metas pendente.
