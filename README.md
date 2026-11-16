# Personal Finance

Sistema de controle financeiro pessoal em **HTML5 + CSS3 + JavaScript (ES Modules) puro**, com
**Firebase Authentication** e **Cloud Firestore** como backend. Sem framework, sem build
obrigatório e sem servidor próprio — roda em qualquer hospedagem estática (Vercel Hobby).

> **Fase atual: 2 — Fundação.** Existem autenticação, estrutura de dados, Security Rules
> testadas e a casca visual navegável. **Não existe lógica financeira ainda**: saldos, somas
> e relatórios são implementados nas Fases 3 e 4.

---

## 1. O que já funciona

| Item | Estado |
|---|---|
| Login, cadastro, logout, recuperação de senha | ✅ implementado (Firebase Auth e-mail/senha) |
| Guarda de sessão nas páginas internas | ✅ redireciona para o login |
| Layout responsivo, menu recolhível, tema claro/escuro | ✅ |
| Componentes: cards, tabela, modal, estado vazio, toasts | ✅ |
| Páginas de todos os módulos com estados vazios | ✅ (Dashboard, Bancos, Receitas, Despesas, Transferências, Assinaturas, Devedores, Metas, Cartões, Relatórios, Configurações) |
| Constantes de coleções e CRUD genérico | ✅ `js/services/firestore.js` |
| Security Rules + testes no emulador | ✅ 24 testes, todos passando |
| Motor de saldo, módulos financeiros, dashboard real | ⛔ Fases 3/4 |

**Nada é inventado na tela:** com o banco vazio, indicadores mostram `—` e as listas exibem
estado vazio. Não há dados DEMO.

---

## 2. Pré-requisitos

- Node.js 18+ (só para o emulador e testes; a aplicação não precisa de build).
- Java 11+ (exigido pelo emulador do Firestore).
- Conta Google para criar o projeto no Firebase (plano **Spark**, gratuito).

---

## 3. Configurar o Firebase (passo a passo do usuário)

1. Acesse <https://console.firebase.google.com> e crie um projeto (exemplo: `meu-finance`).
   **Não habilite o plano Blaze** — tudo aqui funciona no Spark.
2. Em **Authentication → Sign-in method**, habilite **E-mail/senha**.
3. Em **Authentication → Users**, crie seu usuário (ou use a aba "Criar conta" da aplicação).
4. Em **Configurações do projeto → Seus apps → Web**, registre um app e copie o objeto
   `firebaseConfig`.
5. Cole os valores em [`js/firebase/config.js`](js/firebase/config.js), substituindo os
   placeholders `COLE_AQUI_*`.
6. Crie o Firestore em **Firestore Database → Criar banco** (modo produção, região
   `southamerica-east1` é a mais próxima do Brasil).
7. Publique as regras e os índices:

```bash
npm install
npx firebase login
npx firebase use --add          # selecione seu projeto
npx firebase deploy --only firestore:rules,firestore:indexes
```

> A `apiKey` do Firebase **não é uma credencial administrativa**: ela é pública por design.
> A segurança vem das Security Rules e do Authentication. Nunca coloque service account,
> Admin SDK ou chave privada no frontend — este projeto não usa nenhum.

### Rodar localmente

```bash
npm install
npm run emulators     # Auth 9099 + Firestore 8080 + UI 4000
npm run serve         # estático em http://localhost:5500 (ou use a extensão Live Server)
```

Abrindo em `localhost`, o app conecta **automaticamente** aos emuladores
(`js/firebase/client.js`). Para forçar o Firebase real em localhost, use `?emulator=0`.

### Testar as Security Rules

```bash
npm run test:rules
```

O comando sobe o emulador, roda `tests/rules/` com `node --test` e derruba tudo. Última
execução registrada: **24 testes, 24 passando, 0 falhas**.

---

## 4. Estrutura

```text
personal-finance/
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
│   ├── core/                   # guard.js (sessão), ui.js (DOM, toast)
│   ├── firebase/               # config.js (placeholders), client.js (SDK + emuladores)
│   ├── services/               # auth.js, firestore.js (CRUD genérico + auditoria)
│   ├── components/             # sidebar, topbar, tema, card, tabela, modal, vazio
│   ├── modules/                # um módulo por página (Fase 2: estruturas vazias)
│   └── utils/                  # constants, money (centavos), dates, nav
├── tests/rules/                # testes das Rules no emulador
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

## 7. Decisões técnicas desta fase

1. **ES Modules nativos + SDK do Firebase v10 via CDN** — zero build, deploy estático.
2. **CRUD genérico** (`js/services/firestore.js`) em vez de um service por coleção: evita
   duplicação agora e serve de base para os módulos financeiros.
3. **Rules com schemas fechados por coleção** — mais verbosas, porém impedem gravação de
   campos inventados (ex.: snapshot de saldo).
4. **`exists()` nas referências** — integridade referencial real no banco; custa 1 leitura
   por referência validada. Documentado para controle de cota.
5. **Sem SweetAlert2/Chart.js/Day.js/Papa Parse nesta fase** — não há uso real ainda; cada um
   entra quando a funcionalidade existir (evita peso morto). Lucide já é usado nos ícones.
6. **Sem botão sem implementação** — busca global, exportação e ações de CRUD mostram aviso de
   fase futura em vez de fingir funcionamento.

---

## 8. Limitações e pendências

- **Config real do Firebase** precisa ser colada em `js/firebase/config.js` (placeholders).
- Lógica financeira, dashboard real, importação/exportação e backup: Fases 3–5.
- Publicação (GitHub + Vercel): Fase 6. Nada foi publicado e nenhum serviço pago foi ativado.
- Backup do Firestore **não é automático no plano gratuito**; a exportação completa por
  usuário será implementada na Fase 5. Não presuma backup gerenciado.
- Testes de UI (Playwright) ainda não existem; nesta fase a cobertura é das Rules.
- O tema é aplicado por JS após o carregamento (evita `script` inline); pode haver um flash
  breve de tema claro em conexões muito lentas.

---

## 9. Roadmap

| Fase | Escopo |
|---|---|
| 3 | Bancos, receitas, despesas, transferências, assinaturas, devedores, metas, cartões (CRUD + motor de saldo) |
| 4 | Dashboard com indicadores e gráficos, orçamentos, projeções, alertas |
| 5 | Importação CSV, exportação, backup, testes de UI, auditoria financeira |
| 6 | GitHub, Vercel, produção, App Check, documentação operacional |
