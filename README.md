# Vault

Repositório de integração e trabalho. O projeto principal desta branch é o **Vault Finance** — sistema de controle financeiro pessoal. A documentação completa segue abaixo.

---

# Vault Finance

Sistema de controle financeiro pessoal em **HTML5 + CSS3 + JavaScript (ES Modules) puro**, com
**Firebase Authentication** e **Cloud Firestore** como backend. Sem framework, sem build
obrigatório e sem servidor próprio — roda em qualquer hospedagem estática (Vercel Hobby).

> **Estado atual: módulos financeiros entregues (etapa 2 do `PLAN.md`).** Bancos, receitas,
> despesas, transferências, categorias, assinaturas, devedores (parcelas e recebimentos), metas,
> cartões (compras parceladas e faturas), orçamentos, dashboard e relatórios têm service, regras
> de negócio testadas e interface. Pendências e limitações conhecidas estão em `PLAN.md` e na seção 8.

---

## 1. O que já funciona

| Item | Estado |
|---|---|
| Login, cadastro, logout, recuperação de senha | ✅ Firebase Auth e-mail/senha |
| Guarda de sessão, layout responsivo, tema claro/escuro persistido na conta | ✅ |
| Contas, categorias, receitas, despesas, transferências | ✅ CRUD + auditoria + exclusão segura (vínculos) |
| Assinaturas (pausar/retomar/cancelar, avanço de cobrança) | ✅ service + UI (o avanço de cobrança ainda não tem botão na UI) |
| Devedores, parcelas e recebimentos | ✅ recebimento atômico (lote): recebimento + parcela + devedor + auditoria |
| Metas e movimentações (aporte/resgate) | ✅ valor guardado derivado; conclusão/reativação atômicas |
| Cartões, compras parceladas e faturas | ✅ limite derivado; fechar/pagar fatura (ver limitações) |
| Orçamentos por categoria/mês | ✅ gasto derivado das despesas do mês |
| Dashboard e relatórios (período, categorias, CSV) | ✅ somente leitura, leituras limitadas |
| Security Rules + testes no emulador | ✅ 65 testes |
| Testes unitários (modelo + services) | ✅ 340 testes |
| Lint sem dependências, CI (GitHub Actions), E2E Playwright | ✅ ver seção 3 (CI e E2E não executados no GitHub) |

**Nada é inventado na tela:** com o banco vazio, indicadores mostram zeros/`—` e as listas exibem
estado vazio. Não há dados DEMO. Saldo, limites, gasto de orçamento, valor guardado e totais de
fatura aberta são **derivados**, nunca gravados.

---

## 2. Pré-requisitos

- Node.js 18+ (só para o emulador e testes; a aplicação não precisa de build). Testes executados
  no Node 22; o Node 18 só roda no CI (matriz) — não foi executado localmente.
- Java 11+ (emulador do Firestore, usado por `npm run test:rules`).
- Java 11+ (exigido pelo emulador do Firestore).
- Conta Google para criar o projeto no Firebase (plano **Spark**, gratuito).

---

## 3. Configurar o Firebase

**Configuração já preenchida** (projeto `vault-finance-d1603`, plano Spark, região `nam5`,
Authentication por e-mail/senha habilitado): os valores estão em
[`js/firebase/config.js`](js/firebase/config.js). Para trocar de projeto, edite esse arquivo.

> A `apiKey` do Firebase **não é uma credencial administrativa**: ela é pública por design.
> A segurança vem das Security Rules e do Authentication. Nunca coloque service account,
> Admin SDK ou chave privada no frontend — este projeto não usa nenhum.

### Modo DEMO vs Firebase real (alternância explícita)

- `?mode=demo` na primeira página — força o modo DEMO contra os emuladores locais
  (dados fictícios, nada alcança a nuvem). A escolha fica ativa em toda a navegação da aba.
- `?mode=firebase` — força a config real mesmo em localhost.
- Sem parâmetro (automático) — em localhost usa DEMO apenas enquanto a config for
  placeholder; com a config real preenchida, usa o Firebase de verdade.
- `?emulator=0` continua desligando os emuladores em localhost.

### Publicar as Security Rules e índices (produção)

```bash
npm install
npx firebase login               # ou: firebase login:ci para gerar um token
npx firebase use --add           # selecione o projeto vault-finance-d1603
npx firebase deploy --only firestore:rules,firestore:indexes
```

Alternativa sem login interativo:

```bash
npx firebase deploy --only firestore:rules,firestore:indexes \
  --token "SEU_TOKEN_DO_FIREBASE_LOGIN_CI" --project vault-finance-d1603
```

> O projeto novo nasce com as regras padrão do Firebase, que **negam toda escrita**
> (`Missing or insufficient permissions`). A aplicação só persiste dados depois de
> publicar `firestore.rules`.

### Rodar localmente

```bash
npm install
npm run emulators     # Auth 9099 + Firestore 8080 + UI 4000
npm run serve         # estático em http://localhost:5500 (ou use a extensão Live Server)
```

Abrindo em `localhost` com `?mode=demo`, o app conecta aos emuladores
(`js/firebase/client.js`). Sem o parâmetro e com a config real preenchida, ele usa o
Firebase real.

### Testes e qualidade

| Comando | O que faz |
|---|---|
| `npm run test:unit` | modelo, agregações e services com `io` injetado (sem rede) — 340 testes |
| `npm run test:rules` | sobe Auth+Firestore no emulador e roda `tests/rules/` — 65 testes |
| `npm run lint` | sintaxe, espaços, `console.log`, imports não usados, JSON (sem dependências) |
| `npm run test:e2e` | Playwright em Chromium contra os emuladores: `flows.mjs` (cadastro, orçamentos, metas, cartões, devedores, dashboard, relatórios, configurações) e `movements.mjs` (bancos, receitas, despesas, transferências: CRUD, filtros, paginação, ordenação, saldo derivado) |

O E2E **não** adiciona dependência ao projeto: usa o `playwright` já instalado no ambiente e, sem
ele, sai com aviso. O harness serve o SDK do Firebase a partir de `node_modules` (a CDN pode estar
bloqueada) e remove o SRI do import map só durante o teste. `E2E_SCREENSHOTS=<pasta>` salva capturas.
O workflow `.github/workflows/ci.yml` roda lint, unit e Rules (Node 18 e 22); E2E fica fora do CI.

---

## 4. Estrutura

```text
./
├── index.html                  # login / cadastro / recuperação de senha
├── pages/                      # uma página por módulo (casca + módulo JS)
├── css/
│   ├── main.css                # importa os demais
│   ├── variables.css           # tokens: cor, espaço, tipografia, tema escuro
│   ├── layout.css              # shell, sidebar, topbar, responsivo
│   └── components.css          # botões, cards, tabela, modal, formulários, vazio
├── js/
│   ├── app.js                  # entrada das páginas internas
│   ├── auth-page.js            # entrada da tela de login
│   ├── core/                   # guard.js (sessão), ui.js (DOM, toast), model.js (schemas/cálculos), aggregates.js (orçamento/dashboard/relatórios)
│   ├── firebase/               # config.js (placeholders), client.js (SDK + emuladores)
│   ├── services/               # firestore.js (CRUD, lote atômico, auditoria) + um service por módulo
│   ├── components/             # sidebar, topbar, tema, card, tabela, modal, vazio, form-kit (módulos de formulário)
│   ├── modules/                # um módulo por página (+ devedores-parcelas.js)
│   └── utils/                  # constants, money (centavos), dates, nav
├── tests/                      # model/, services/ (unit), rules/ (emulador), e2e/ (Playwright)
├── scripts/lint.mjs            # lint sem dependências
├── .github/workflows/ci.yml    # CI (lint, unit, Rules)
├── firestore.rules
├── firestore.indexes.json
├── firebase.json               # emuladores Auth + Firestore
├── vercel.json                 # rotas limpas + cabeçalhos de segurança
└── README.md
```

Separação de responsabilidades: **páginas** só montam o shell; **módulos** renderizam;
**services** falam com o Firebase; **utils** não conhecem DOM nem rede.

---

## 5. Modelo de dados (Firestore)

Tudo sob `users/{userId}/`. O `userId` é o `uid` do Firebase Auth — é isso que garante o
isolamento nas Rules.

| Coleção | Papel | Campos obrigatórios (resumo) |
|---|---|---|
| `profile/main` | perfil | `name`, `email`, `currency`, `locale` |
| `settings/main` | preferências | `theme` (light/dark/system) |
| `accounts` | contas | `institution`, `name`, `type`, `initialBalanceCents`, `color`, `status` |
| `categories` | categorias | `name`, `kind` (income/expense/both), `color` |
| `incomes` | receitas | `description`, `categoryId`, `amountCents`, `expectedDate`, `accountId`, `status`, `recurrence` |
| `expenses` | despesas | `description`, `categoryId`, `amountCents`, `accountId`, `purchaseDate`, `dueDate`, `status`, `recurrence` |
| `transfers` | transferências | `fromAccountId`, `toAccountId`, `amountCents`, `date`, `reason`, `status` |
| `subscriptions` | assinaturas | `name`, `amountCents`, `periodicity`, `nextChargeDate`, `accountId`, `categoryId`, `status` |
| `debtors` | devedores | `name`, `loanDate`, `lentCents`, `receivedCents`, `status` |
| `debts` | parcelas de dívida | `debtorId`, `description`, `principalCents`, `dueDate`, `installmentNumber`, `status` |
| `debtPayments` | recebimentos | `debtId`, `debtorId`, `amountCents`, `date`, `accountId` |
| `goals` | metas | `name`, `targetCents`, `status` (`deadline` e `accountId` opcionais) |
| `goalTransactions` | aportes/resgates | `goalId`, `type` (deposit/withdraw), `amountCents`, `date`, `accountId` |
| `creditCards` | cartões | `name`, `brand`, `limitCents`, `closingDay`, `dueDay`, `status` |
| `cardPurchases` | compras | `cardId`, `description`, `amountCents`, `purchaseDate`, `installmentsTotal`, `installmentNumber` |
| `invoices` | faturas | `cardId`, `referenceMonth` (`YYYY-MM`), `dueDate`, `status` |
| `budgets` | orçamentos | `categoryId`, `month` (`YYYY-MM`), `limitCents` |
| `auditLog` | auditoria | `action`, `entity`, `entityId`, `actorUid` — **create-only** |

**Regras de representação**

- Dinheiro em **centavos inteiros** (`is int` nas Rules). Movimentações exigem `> 0`; saldos
  iniciais e limites aceitam `0`.
- Datas em **timestamp** do Firestore.
- **Saldo nunca é gravado.** É sempre derivado de `initialBalanceCents` + movimentações
  confirmadas (decisão rev. 3). Cache, se houver, só no cliente e sempre revalidado.
- Campos fechados: qualquer campo fora da lista da coleção é **negado** pelas Rules —
  inclusive tentativas de gravar `saldo`/`balance` em `accounts`.
- Referências são **IDs de documentos** da própria árvore do usuário; as Rules validam
  existência real com `exists()` (custo: 1 leitura por referência validada na escrita).

---

## 6. Segurança

- Negação padrão (`match /{document=**} { allow read, write: if false; }`).
- Isolamento por usuário em todos os `match`.
- `auditLog` sem `update` e sem `delete`.
- `createdAt`/`updatedAt` só podem vir do servidor (`request.time`), e `createdAt` é imutável.
- Nenhuma credencial administrativa no cliente; a config web é pública por design.
- Cabeçalhos em `vercel.json`: `nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY`,
  `Permissions-Policy`.
- **Limitação conhecida:** o Firebase Auth usa a chave pública do projeto; abuso de cadastro
  deve ser contido por cotas e, se necessário, App Check (Fase 6).

### Cotas do plano gratuito (Spark) — valores de referência

| Serviço | Cota gratuita diária (referência) |
|---|---|
| Firestore — leituras | 50.000/dia |
| Firestore — escritas | 20.000/dia |
| Firestore — exclusões | 20.000/dia |
| Firestore — armazenamento | 1 GiB |
| Authentication | 50.000 MAU (e-mail/senha) |
| Hosting (não usado aqui) | 10 GB/mês |

Os números podem mudar; **confira a página oficial de preços antes de confiar neles**.
O projeto não habilita nada fora do Spark e não faz chamadas pagas.

---

## 7. Decisões técnicas

1. **ES Modules nativos + SDK do Firebase v10 via CDN** — zero build, deploy estático.
2. **Auditoria e CRUD por helpers** (`createAudited`/`updateAudited`/`removeAudited`) com `io`
   injetável; operações multi-documento usam `commitAtomic` (lote Firestore com auditoria no
   mesmo lote).
3. **Rules com schemas fechados por coleção** — impedem campos inventados (ex.: snapshot de saldo).
   Saldos, limites, gasto de orçamento, valor guardado de metas e totais de fatura aberta são derivados.
4. **`exists()` nas referências (decisão mantida).** Dá integridade referencial real, custa 1 leitura
   por referência, mas **não enxerga documentos criados no mesmo lote**. Efeito: parcela de cartão não
   pode referenciar fatura criada no mesmo lote — a compra grava **dois lotes** (1º faturas novas,
   2º parcelas), cada um atômico; se o 2º falhar sobram faturas abertas vazias, reaproveitadas na
   próxima compra (ID determinístico `cardId_AAAA-MM`). Alternativa avaliada: `existsAfter()` nas
   Rules (um só lote). **Não adotada** porque exige republicar as Rules em produção e revisar todas as
   referências (`ref()`/`optionalRef()`) — decisão de segurança que depende de aprovação. O contrato
   atual está documentado por teste em `tests/rules/`. Se adotada no futuro, o service volta a um lote.
5. **Datas** em campos `date`/`*Date` são Timestamp em **meio-dia UTC** (o dia de calendário não
   desloca em nenhum fuso); filtros por data em `where` convertem a string ISO do mesmo modo.
6. **Sem dependências novas sem aprovação** (nem libs via CDN): gráficos são barras CSS, CSV é gerado
   no cliente, lint é um script próprio, E2E reaproveita o Playwright do ambiente.
7. **Sem botão sem implementação** — busca global e exportação PDF ainda não existem e avisam isso.

---

## 8. Limitações e pendências

- **Config real do Firebase** precisa estar em `js/firebase/config.js`; as Rules/índices do repositório
  precisam ser publicadas manualmente (`firebase deploy --only firestore:rules,firestore:indexes`,
  somente com autorização). Não verificado: Rules em produção, deploy/preview na Vercel.
- **Leituras (cota Spark):** receitas, despesas e transferências carregam **100 por página** (cursor por
  documento, mais recentes primeiro; 101 leituras na 1ª página e +1 de cursor nas seguintes) e mostram
  "Carregar mais antigas" com aviso de que filtros, meses e totais valem só para o carregado. Bancos lista
  até 200 contas e calcula o saldo atual **sob demanda** (botão; lê até 1000 movimentos realizados por tipo
  e avisa se atingir o teto). Dashboard, relatórios e orçamentos têm teto próprio e avisam. Recarregar
  após criar/editar volta à primeira página. Não medido em produção; índices compostos já declarados
  (`firestore.indexes.json`) só valem após publicar.
- **Cartões:** pagar fatura não movimenta conta (o schema `invoices` não tem `accountId`) e é sempre
  integral; não há cancelamento de fatura; parcelas de uma compra não têm `installmentGroupId` (o
  schema `cardPurchases` não o aceita) e são identificadas por cartão + descrição + data + total.
- **Concorrência:** leitura prévia + escrita em lote, sem transação (limite de cartão, valores
  recebidos e unicidade de orçamento por categoria/mês podem ser violados por abas simultâneas).
- Movimentações de metas e recebimentos são imutáveis (sem estorno); orçamentos consideram só
  despesas (compras no cartão não entram).
- Backup do Firestore **não é automático no plano gratuito**; exportação completa por usuário ainda
  não existe. Não presuma backup gerenciado.
- Exportação PDF e importação CSV não existem; exportação CSV existe nos relatórios.
- O tema é aplicado por JS após o carregamento; pode haver um flash breve de tema claro.

---

## 9. Roadmap

O estado operacional e os IDs (`VF-<fase>-<nn>`) vivem em `PLAN.md`. Próximos: importação
CSV/exportação completa/backup, publicação (GitHub + Vercel), App Check e documentação operacional.
