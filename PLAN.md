# PLAN.md — Estado operacional do Vault Finance

Última auditoria: 2026-11-18 (branch `claude`). Somente diagnóstico; nenhum código alterado.
Legenda de confiança: **[C]** comprovado por leitura do código · **[R]** risco potencial · **[M]** melhoria · **[NV]** não verificado.
Convenção de IDs: `VF-<fase>-<nn>`. Preservar IDs; não remover tarefas concluídas.

## Diagnóstico

- Propósito: controle financeiro pessoal (contas, receitas, despesas, transferências, categorias) por usuário.
- Stack: HTML/CSS/JS ES Modules puro, Firebase Auth + Firestore (SDK 10.12.2 via CDN/importmap), Vercel estático, npm só para dev.
- Maturidade: fases 2–4 (etapa 2) entregues; 7 módulos ainda são casca (dashboard, assinaturas, devedores, metas, cartões, relatórios, configurações).
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

- [Impacto: Crítico] js/services/firestore.js:144 + firestore.rules:438-449 — `writeAudit` envia `collection/docId/before/after`; as Rules só aceitam `action/entity/entityId/actorUid/createdAt` (schema fechado) → toda gravação de auditoria é negada e o `catch` apenas faz `console.warn`. Auditoria inexistente em produção [C] → alinhar payload ao schema (ou ajustar Rules com teste), e tornar a falha visível.
- [Impacto: Alto] js/services/accounts.js:73-87 e js/modules/bancos.js:356 — `deleteAccount` não verifica vínculos; a UI afirma que "as Security Rules impedirão", mas as Rules (`firestore.rules:152`) permitem `delete` ao dono [C]. Excluir conta deixa receitas/despesas/transferências órfãs e distorce `accountBalances` (`js/core/model.js:339-357`, ignora ids desconhecidos) → aplicar o mesmo padrão fail-closed de `deleteCategory` (`js/services/categories.js:140-165`) e corrigir o texto.
- [Impacto: Alto] package.json:9 — `node --test tests/rules` (diretório) falha em Node 22 ("Cannot find module") [C, reproduzido para o formato de diretório]; README declara Node 18+ → usar glob `tests/rules/*.mjs` e fixar `engines`.
- [Impacto: Médio] js/services/transfers.js:88-110 — `confirmTransfer`/`cancelTransfer` fazem `update` sem ler o estado atual: permite confirmar transferência cancelada e não revalida contas existentes (o `exists()` das Rules cobre a existência, não a transição) [C] → validar transição de status.
- [Impacto: Médio] vercel.json:3-30 — sem `Content-Security-Policy`; scripts de `unpkg.com` (lucide, `pages/*.html:18`) e `gstatic.com` (SDK) sem SRI [C]; `innerHTML` só com literais próprios (`js/core/ui.js:10`) [sem XSS comprovado] → CSP restritiva + SRI/versão fixa; avaliar vendorizar lucide.
- [Impacto: Médio] vercel.json:16-27 — não há rewrite para `/categorias` apesar de existir em `js/utils/nav.js` [R]: com `cleanUrls` os links relativos `categorias.html` funcionam, mas a rota limpa fica inconsistente com as demais [NV em deploy].
- [Impacto: Médio] js/modules/{bancos,receitas,despesas,transferencias}.js — `list*` sem `limit`/paginação e saldo calculado no cliente varrendo todas as coleções (README:5 cota Spark 50k leituras/dia) [R].
- [Impacto: Médio] js/services/firestore.js:32-40 — `toFirestoreData` converte qualquer string `YYYY-MM-DD` (inclusive `description`/`notes` que casem o padrão) e usa `T12:00:00` local; `fromFirestoreDoc` usa `toISOString` (UTC) — risco de deslocar um dia em fusos extremos [R].
- [Impacto: Médio] js/services/{accounts,incomes,expenses,transfers,categories}.js — update sem checar existência/concorrência; auditoria grava `after` completo (dados financeiros duplicados) [M].
- [Impacto: Baixo] js/services/accounts.js:95-102 — `getStatusOptions` duplica enum do modelo (`js/core/model.js`) [M].
- [Impacto: Baixo] js/modules/bancos.js:51 — comentário "Por simplicidade Fase 3" indica carga ansiosa de movimentos; `js/core/ui.js:43` mensagem "Disponível na Fase 3" já defasada [M].
- [Impacto: Baixo] README.md:30-31,98-103 — desatualizado: lista 24 testes só de Rules, não cita categorias nem testes de modelo/serviço; diz "Fase atual: 2" [C].
- [Impacto: Baixo] firebase.json — sem bloco `hosting`/`rules` de teste; sem `.firebaserc` (projeto selecionado manualmente) [NV].

## Roadmap

### Fase 1 — Segurança, integridade e falhas críticas

**VF-1-01 — Auditoria nunca persiste** (Crítico)
- Problema: payload de `writeAudit` viola schema fechado de `auditLog`; falha engolida.
- Solução: padronizar `entry` como `{action, entity, entityId}` (e decidir se `before/after` entram na Rule com limite de tamanho); manter `try/catch` mas expor falha ao usuário/log; ajustar chamadas em 5 services.
- Arquivos: `js/services/firestore.js`, `js/services/{accounts,categories,incomes,expenses,transfers}.js`, `firestore.rules`, `tests/rules/firestore.rules.test.mjs`, `tests/services/*`.
- Dependências: nenhuma (decisão de produto sobre `before/after` antes de mexer nas Rules).
- Aceite: teste de Rules cria entrada com o payload real do service e passa; testes de serviço verificam o shape; `npm run test:rules` verde; deploy das Rules documentado.

**VF-1-02 — Exclusão de conta com vínculos** (Alto)
- Problema: ver Débitos; contas excluídas deixam referências órfãs.
- Solução: contar vínculos em incomes/expenses/transfers (origem e destino) fail-closed como `deleteCategory`; corrigir texto de `bancos.js:356`; sugerir arquivar (`status: archived`).
- Arquivos: `js/services/accounts.js`, `js/modules/bancos.js`, `tests/services/accounts.test.mjs`.
- Dependências: nenhuma.
- Aceite: testes cobrem conta em uso (bloqueia), sem uso (exclui) e falha de verificação (bloqueia).

**VF-1-03 — Cabeçalhos de segurança (CSP/SRI)** (Médio)
- Solução: CSP em `vercel.json` compatível com importmap injetado por JS e com gstatic/unpkg; SRI ou versão fixa/vendorizada para lucide.
- Arquivos: `vercel.json`, `pages/*.html`, `js/importmap.js`.
- Dependências: validar em deploy preview. Aceite: páginas carregam sem violação CSP no console; `X-Frame-Options`/CSP presentes.

### Fase 2 — Funcionalidades incompletas e correções

**VF-2-01 — Transições de status de transferência** (Médio): validar leitura do estado antes de confirmar/cancelar. Arquivos: `js/services/transfers.js`, `tests/services/transfers.test.mjs`. Aceite: confirmar cancelada é rejeitado, testado.
**VF-2-02 — Persistir perfil/settings/tema** (Médio): implementar `profile/main` e `settings/main` (Rules já existem). Arquivos: `js/modules/configuracoes.js`, `js/components/theme.js`, `js/services/firestore.js`. Dependências: VF-1-01. Aceite: tema e perfil sobrevivem a reload e a novo dispositivo.
**VF-2-03 — Módulos pendentes** (feature): assinaturas, devedores, metas, cartões, dashboard, relatórios, orçamentos conforme roadmap do README (fases 3–5). Cada módulo vira tarefa própria (`VF-2-03a…`) quando priorizado. Dependências: VF-1-01, VF-3-01.
**VF-2-04 — Rota limpa `/categorias`** (Baixo): adicionar rewrite em `vercel.json`. Aceite: `/categorias` abre a página no preview.

### Fase 3 — Arquitetura, qualidade e refatoração

**VF-3-01 — Reduzir duplicação nos services** (Médio): extrair helper de create/update/delete com auditoria reutilizando `firestore.js`, sem mudar API pública. Arquivos: `js/services/*.js`. Dependências: VF-1-01. Aceite: testes existentes passam sem alteração; diff líquido de linhas negativo.
**VF-3-02 — Dividir módulos extensos** (Baixo): separar render/estado/handlers em `receitas.js`, `despesas.js`, `transferencias.js`, `bancos.js` apenas se for tocar nesses arquivos por outra tarefa (evitar refatoração oportunista). Aceite: comportamento idêntico, testes verdes.
**VF-3-03 — Tratamento de datas** (Médio): restringir conversão ISO→Timestamp a campos de data conhecidos (por schema) e tratar fuso. Arquivos: `js/services/firestore.js`, `js/core/model.js`. Aceite: testes para strings livres e para virada de dia.
**VF-3-04 — Atualizar README e mensagens defasadas** (Baixo). Arquivos: `README.md`, `js/core/ui.js:43`, `js/components/topbar.js:21`. Aceite: README descreve fase atual, testes reais e Node suportado.

### Fase 4 — Testes, performance e otimização

**VF-4-01 — Scripts de teste confiáveis** (Alto, pode ser antecipada): scripts `test:model`, `test:services` e `test:rules` com glob, `engines.node`, sem alterar dependências. Arquivos: `package.json`. Aceite: `npm test` roda os três em Node 18 e 22 (sem alterar lockfile).
**VF-4-02 — CI** (Médio): workflow rodando testes de modelo/serviço e Rules no emulador. Dependências: VF-4-01 e aprovação de nova ferramenta/arquivo. Aceite: pipeline verde no PR.
**VF-4-03 — Paginação e limites de leitura** (Médio): `limit`/filtro por mês nas listagens; saldo incremental/cache revalidado. Arquivos: módulos e services listados. Aceite: leituras por carga de página medidas e dentro de orçamento definido.
**VF-4-04 — Testes de UI (Playwright)** (Baixo): fluxos login → criar conta → receita → saldo. Dependências: aprovação de dependência.
**VF-4-05 — Lint/formatação** (Baixo): avaliar ESLint/Prettier (requer aprovação).

## Itens não verificados

- `npm run test:rules` e testes de `tests/services` (sem `node_modules`/emulador; instalação não autorizada nesta missão).
- Comportamento real em Vercel (headers, rotas) e Firestore de produção (Rules publicadas podem divergir de `firestore.rules`).
- Acessibilidade e responsividade (CSS/HTML não auditados em detalhe).
- Módulos `receitas.js`, `despesas.js`, `transferencias.js`, `categorias.js` e `model.js` lidos apenas por busca/trechos.

## Histórico

- 2026-11-18 — Criado `CLAUDE.md` (commit 062e13b) e primeira versão deste plano. 16 tarefas: 3 (Fase 1), 4 (Fase 2), 4 (Fase 3), 5 (Fase 4) — ver IDs acima.
