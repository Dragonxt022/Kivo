# PDV: a prazo/parcelamento/carnê + Clientes: ficha completa + Crédito de troca + Fidelidade + Convênio

## Contexto

O PDV hoje trata "A prazo (fiado)" como só mais um botão de forma de pagamento — sem
parcelamento e sem geração de carnê. A tela de Clientes é uma lista genérica (mesmo
componente CRUD usado por qualquer cadastro simples), sem histórico, sem gráficos, sem
CEP automático, e sem nenhum mecanismo de relacionamento com o cliente além dos dados
de contato. O usuário quer elevar isso a um "cadastro completo de cliente": ficha com
histórico financeiro/de compras (gráficos de barra), CEP automático, crédito de troca
(vale-troca por devolução), clube de fidelidade (pontos por real gasto) e convênio
(faturamento mensal consolidado para empresas conveniadas) — e o pagamento a prazo
ganha parcelamento de verdade, numa modal própria, com carnê impresso.

Este é um conjunto de 5 features (A–E) que se apoiam numa mesma base: o padrão de
livro-razão (ledger) já usado em `stock_qty`/`stock_movements` e `cash_registers`/
`cash_movements`. Construir esse padrão uma vez para saldo de cliente e reaproveitar
para crédito de troca E fidelidade evita duplicar a lógica de replay/sync.

Decisões já confirmadas com o usuário:
- Crédito de troca = saldo de vale-troca por devolução (não é limite de fiado).
- Convênio = fatura mensal consolidada para uma empresa, fechamento em dia fixo do mês
  configurável, com botão manual de "gerar fatura agora" como fallback.
- Carnê = documento impresso simples (sem boleto bancário real).
- Fidelidade = pontos por R$ gasto, resgatáveis como desconto numa compra futura.
- Risco de "gasto duplo" entre duas máquinas offline com o mesmo saldo: aceito (mesma
  postura já usada no estoque — venda nunca trava), mas com um relatório de
  reconciliação pós-sync que aponta saldos negativos pra resolver manualmente.
- Fecha agora a brecha de venda-dupla por duplo-clique/retry (token de idempotência).
- Fatura de convênio reaproveita a tabela `receivables` existente (não cria tabela
  nova) — aparece na mesma tela de "Contas a receber".

## Ordem de construção recomendada

1. **Migrations de schema** (0017–0024, lista abaixo) — todas antes de qualquer código,
   porque migrations posteriores referenciam FKs criadas nas anteriores.
2. **Motor genérico de livro-razão de cliente** (`src/modules/commercial/customerLedger.ts`)
   — construído uma vez, usado por crédito de troca E fidelidade.
3. **Parte C (crédito de troca)** em cima do motor — valida o motor de ponta a ponta.
4. **Parte D (fidelidade)** em cima do mesmo motor — resgate é quase idêntico ao de C;
   ganha o mecanismo novo de "acúmulo automático por venda".
5. **Parte A (a prazo/parcelamento/carnê)** — depende só do schema de `receivables`
   (passo 1), independente de C/D.
6. **Parte B (ficha do cliente)** — depende de A (histórico) e C/D (saldos exibidos);
   a *restilização da tabela* de clientes não depende de nada e pode ser feita a
   qualquer momento dentro dessa ordem.
7. **Parte E (convênio)** — por último, reaproveita exatamente o mecanismo "forma de
   pagamento especial desvia pra um livro-razão em vez de caixa/recebível" provado em C.

Cada parte mexe em `sales.ts`/`sales.ejs` de forma incremental e pequena — nunca uma
reescrita única.

## Migrations (a partir de 0017 — maior número já usado no projeto)

| # | Módulo | Pasta | Conteúdo |
|---|--------|-------|----------|
| 0017 | commercial | `0017_commercial_agreement_companies` | `CREATE TABLE agreement_companies (id, name NOT NULL, document, billing_day INTEGER NOT NULL CHECK(1-31), contact_name, contact_phone, contact_email, active DEFAULT 1, + colunas de sync + comment)` |
| 0018 | commercial | `0018_commercial_customer_balances` | `ALTER TABLE customers ADD COLUMN cep TEXT; ADD COLUMN store_credit_cents INTEGER NOT NULL DEFAULT 0; ADD COLUMN loyalty_points INTEGER NOT NULL DEFAULT 0; ADD COLUMN agreement_company_id INTEGER REFERENCES agreement_companies(id);` |
| 0019 | commercial | `0019_commercial_customer_credit_ledger` | `customer_credit_movements` (ledger, sem updated_at/deleted_at, igual `stock_movements`): `customer_id, type CHECK(concessao|resgate|estorno), amount_cents, balance_after, reason, ref_entity, ref_id, user_id, created_at, uuid, synced_at, origin_machine, comment` + índice `(customer_id, created_at)` |
| 0020 | commercial | `0020_commercial_loyalty_ledger` | Mesmo formato: `loyalty_point_movements(points, type CHECK(ganho|resgate|estorno), balance_after, ...)` |
| 0021 | finance | `0021_finance_receivables_installments_agreements` | `ALTER TABLE receivables ADD COLUMN sale_id INTEGER REFERENCES sales(id); ADD COLUMN installment_no INTEGER; ADD COLUMN installment_count INTEGER; ADD COLUMN agreement_company_id INTEGER REFERENCES agreement_companies(id); ADD COLUMN period_key TEXT;` + índice `(sale_id)` + índice único parcial `(agreement_company_id, period_key) WHERE agreement_company_id IS NOT NULL` + backfill de `sale_id` a partir de `sales.receivable_id` para linhas antigas |
| 0022 | finance | `0022_finance_agreement_charges` | `agreement_charges(sale_id NOT NULL, agreement_company_id NOT NULL, amount_cents, invoiced_at, receivable_id, created_at, uuid, updated_at, deleted_at, synced_at, origin_machine, comment)` — precisa de `deleted_at` porque uma cobrança pode ser estornada antes de faturada |
| 0023 | finance | `0023_finance_payment_methods_new_types` | Rebuild de tabela (SQLite não altera CHECK): recria `payment_methods` com `type` aceitando `credito_loja`, `fidelidade`, `convenio` além dos 5 já existentes; semeia as 3 linhas novas com **`active = 0`** (opt-in, não muda comportamento de instalação existente) |
| 0024 | store | `0024_store_sales_idempotency` | `ALTER TABLE sales ADD COLUMN client_request_id TEXT; CREATE UNIQUE INDEX idx_sales_client_request_id ON sales(client_request_id) WHERE client_request_id IS NOT NULL;` — fecha a brecha de venda duplicada por duplo-clique/retry |

Down-migrations espelham cada uma (0023's down remove as 3 linhas semeadas antes de
recriar a tabela com o CHECK mais estreito, pra não violar a constraint durante a cópia).

## Sync — declarações no manifesto

`commercial/module.manifest.ts`:
```ts
{ table: 'agreement_companies' },
{ table: 'customers', foreignKeys: { price_list_id: 'price_lists', agreement_company_id: 'agreement_companies' },
  excludeColumns: ['store_credit_cents', 'loyalty_points'] }, // derivados, nunca viajam
{ table: 'customer_credit_movements', excludeColumns: ['balance_after','ref_id','user_id'],
  ledgerFor: { parentTable: 'customers', parentColumn: 'customer_id' } },
{ table: 'loyalty_point_movements', excludeColumns: ['balance_after','ref_id','user_id'],
  ledgerFor: { parentTable: 'customers', parentColumn: 'customer_id' } },
```
`finance/module.manifest.ts`:
```ts
{ table: 'receivables', foreignKeys: { customer_id: 'customers', sale_id: 'sales', agreement_company_id: 'agreement_companies' } },
{ table: 'agreement_charges', foreignKeys: { sale_id: 'sales', agreement_company_id: 'agreement_companies', receivable_id: 'receivables' } },
```
`payment_methods` continua fora de `syncTables` (config por máquina, como hoje — os 3
tipos novos são semeados localmente pela migration em cada instalação).
`sales.client_request_id` não precisa de tratamento especial no sync (é só mais uma
coluna comum na linha já sincronizada).

## Novas permissões

- `commercial.agreements.view/create/edit/delete` — CRUD de empresas conveniadas
- `commercial.customers.creditgrant` — conceder crédito de troca manualmente
- `finance.agreements.view` — ver tela de Convênios (pendências, faturas)
- `finance.agreements.invoice` — gerar fatura manualmente
- `finance.reconciliation.view` — ver o relatório de saldos negativos pós-sync (novo)

## Serviços (service registry)

Novo `src/modules/commercial/customerLedger.ts` (motor interno, não é um serviço
registrado em si — usado por trás de `commercial.storeCredit`/`commercial.loyalty`):
```ts
interface LedgerCfg { table: string; balanceColumn: string; grantType: string; redeemType: string; reverseType: string }
function grantRaw(cfg, req, customerId, amount, reason, refEntity?, refId?): LedgerResult
function redeemRaw(cfg, req, customerId, amount, reason, refEntity?, refId?): LedgerResult // valida saldo, sem transação própria
function recomputeForCustomers(cfg, customerIds: number[]): void // replay por (created_at, uuid), igual recomputeStockForProducts
function balance(cfg, customerId): number
```

`commercial/setup.ts` adiciona:
```ts
registerService('commercial.storeCredit', { grantRaw, redeemRaw, balance } satisfies CommercialStoreCreditService);
registerService('commercial.loyalty', { accrueRaw, redeemRaw, balance, pointsForSaleCents, centsPerPoint } satisfies CommercialLoyaltyService);
registerRecomputeHook('customer_credit_movements', (ids) => recomputeForCustomers(CREDIT_CFG, ids));
registerRecomputeHook('loyalty_point_movements', (ids) => recomputeForCustomers(LOYALTY_CFG, ids));
```

`finance/setup.ts` adiciona ao `FinanceReceivablesService`:
```ts
create(input: { ...existente, saleId?, installmentNo?, installmentCount?, agreementCompanyId?, periodKey? }): number;
listBySale(saleId: number): ReceivableRow[]; // usado pelo carnê e pelo cancelSale
```
e novo `FinanceAgreementsService`:
```ts
chargeAgreementRaw(saleId, agreementCompanyId, amountCents): number;
pendingTotal(companyId): number;
generateInvoice(req, companyId, periodKey?): { ok: true; receivableId: number; amountCents: number } | { ok: false; error: string };
companiesDueForInvoice(today: Date): { id; name; billingDay }[]; // usado pelo scheduler de boot
```

## API — novos endpoints / filtros

- `GET /api/store/sales?customerId=` — novo filtro (além do `?day=` já existente)
- `GET /api/finance/receivables?partyId=` e `?agreementCompanyId=` — novos filtros em
  `makeBillsRouter` (`src/modules/finance/bills.ts`), reaproveitando o mesmo factory
  também usado por payables
- `GET /api/commercial/customers/:id` — novo (adicionar suporte genérico em
  `makeCrudRouter`/`crud.ts` via `readOnlyFields?: string[]`, pra `store_credit_cents`/
  `loyalty_points` aparecerem no GET mas nunca serem graváveis via POST/PUT)
- `POST /api/commercial/customers/:id/credit` — conceder crédito de troca manual
  (permissão `commercial.customers.creditgrant`)
- `router.use('/agreement-companies', makeCrudRouter({...}))` — CRUD de convênios
- `GET /api/finance/agreements/:companyId/pending` — total pendente
- `POST /api/finance/agreements/:companyId/invoice` — gerar fatura agora
- `GET /api/finance/reconciliation/negative-balances` — novo: lista clientes cujo
  `store_credit_cents`/`loyalty_points` recomputado ficou negativo após merge de sync
- `GET /app/store/vendas/:id/carne` — página de impressão do carnê
- `GET /app/commercial/clientes/:id` — ficha do cliente
- `GET /app/finance/convenios` — tela de convênios (menu novo no manifest do finance)
- `GET /app/finance/reconciliacao` — tela simples listando o resultado do endpoint acima

`SaleInput`/`SalePaymentInput` (`store/sales.ts`) ganham:
```ts
clientRequestId?: string; // gerado uma vez por tentativa de checkout no PDV
// em SalePaymentInput, só relevante quando o método resolvido é 'prazo':
customerId?: number; dueDate?: string; installments?: { count: number; firstDueDate: string };
// só relevante quando o método é 'fidelidade':
pointsUsed?: number;
```

## Parte A — PDV: modal de "a prazo" + parcelamento + carnê

No PDV (`store-pdv.ejs`), clicar em "A prazo (fiado)" abre uma modal dedicada
(`x-ref="prazoDlg"`) em vez de revelar campos na mesma modal de pagamento: seleciona
cliente (obrigatório), escolhe "à vista" (1 recebível, comportamento atual) ou
"parcelado" (2 a 12 parcelas) com data do primeiro vencimento; uma prévia mostra cada
parcela (número, data, valor — parcelas a cada 30 dias a partir da primeira, primeira
parcela absorve o resto da divisão). Confirmar gera uma única linha em `pay.list` do
tipo `prazo` carregando o plano de parcelas.

Em `createSale()`: ao resolver o pagamento `prazo`, ao invés de 1 chamada a
`receivables.create()`, faz um loop de N chamadas (uma por parcela), cada uma com
`saleId`, `installmentNo`, `installmentCount`, valor e vencimento próprios. Sem
parcelamento (`count=1`), comportamento idêntico ao atual — compatibilidade total com
chamadas antigas.

Carnê: nova rota de impressão `GET /app/store/vendas/:id/carne` em `store/pages.ts`
(mesmo padrão do cupom/orçamento — view standalone, `fmtDateTime`/`brl` duplicados,
`companyInfo()`, `window.print()` automático), buscando as parcelas via
`getService<FinanceReceivablesService>('finance.receivables').listBySale(id)` — mesmo
padrão cross-module já usado pelo relatório de fechamento de caixa. Um slip impresso
por parcela (cliente, "Parcela X/N", valor, vencimento, cabeçalho da empresa), com
quebra de página entre parcelas. Botão "Imprimir carnê" aparece na tela de pós-venda
quando a venda teve parcelamento.

## Parte B — Clientes: tabela padrão + ficha completa + CEP

**Restilização**: `commercial-customers.ejs` troca o `crudPage()` genérico por um
componente próprio (`customersPage()`), replicando exatamente o padrão de
`commercial-products.ejs`: cabeçalhos ordenáveis (`sort()`, seta de ordenação), menu
"mais ações" em dropdown (`openMenu`, `.dropdown-menu`) com **Ver ficha** / Editar /
Excluir — sem a estrela de favorito (recurso exclusivo de produtos).

**Ficha do cliente** (`/app/commercial/clientes/:id`, nova view
`commercial-customer-ficha.ejs`): contato/documento, saldo de crédito de troca, pontos
de fidelidade, convênio vinculado (se houver), gráfico de barras em CSS/SVG puro (sem
biblioteca nova — segue o padrão do projeto de tudo desenhado à mão) com totais mensais
de compra dos últimos 6–12 meses, tabela de histórico de compras (`GET
/api/store/sales?customerId=`) e tabela de histórico financeiro (`GET
/api/finance/receivables?partyId=`). *Nota de implementação: invocar a skill de
dataviz na hora de desenhar o gráfico, pra manter consistência visual — este plano só
define os dados e onde aparecem.*

**CEP automático**: novo campo `cep` no diálogo de edição; `maskCEP()` novo em
`src/public/js/masks.js`; ao completar 8 dígitos, `fetch` direto (client-side, sem rota
nova no backend) para `https://viacep.com.br/ws/{cep}/json/` com timeout curto; sucesso
preenche `form.address` (sempre sobrescreve, é o comportamento mais simples e previsível);
qualquer falha/timeout/offline é silenciosamente ignorado (`catch {}`, sem erro visível)
— exatamente como pedido.

## Parte C — Crédito de troca (vale-troca)

Saldo derivado (`customers.store_credit_cents`) mantido por livro-razão
(`customer_credit_movements`), reconstruído via `recomputeForCustomers` após merges de
sync — mesmo mecanismo do estoque.

Concessão manual: `POST /api/commercial/customers/:id/credit` (permissão
`commercial.customers.creditgrant`), corpo `{ amountCents, reason }`.

PDV: novo método rápido "Crédito de loja" só aparece quando o cliente selecionado tem
saldo `> 0`; ao usar, o valor lançado é limitado a `min(restante, saldo)`.

`createSale()`: pagamento `credito_loja` chama `commercial.storeCredit.redeemRaw`
dentro da mesma transação da venda — se o saldo for insuficiente, lança erro e a venda
inteira é revertida (mesmo padrão do `if (!move.ok) throw new Error(...)` já usado pro
estoque).

`cancelSale()`: reverte o débito com `grantRaw` (estorno).

## Parte D — Clube de fidelidade

Mesmo motor de livro-razão (tabela própria `loyalty_point_movements`, saldo derivado
`customers.loyalty_points`).

Novas configurações (aba "Fidelidade" em `settings.ejs`, mesmo padrão das abas
existentes): `fidelidade.ativo` (padrão `'0'`, opt-in), `fidelidade.pontos_por_real`,
`fidelidade.pontos_resgate`/`fidelidade.valor_resgate_cents` (ex.: 100 pontos = R$5).

Acúmulo automático dentro de `createSale()`: se fidelidade ativa e a venda tem
cliente, calcula pontos sobre a base da venda **excluindo** o que foi pago com crédito
de loja/fidelidade (não gera pontos sobre pontos), arredondando pra baixo.

Resgate como pagamento: novo método "Pontos de fidelidade" (só aparece com saldo > 0);
o caixa escolhe quantos pontos usar (não um valor em R$), o valor em centavos é
recalculado e **validado no servidor** contra `pointsUsed × centsPerPoint()` — rejeita
qualquer divergência, fechando qualquer tentativa de manipulação client-side.

`cancelSale()`: reverte tanto o resgate (se houve) quanto os pontos ganhos pela venda
original (lançamento de estorno equivalente) — aceitando que, se o cliente já gastou
esses pontos em outra compra, o saldo pode ficar negativo (mesma classe de risco
tratada pelo relatório de reconciliação da Parte C/E).

## Parte E — Convênio

Nova entidade `agreement_companies` (nome, CNPJ validado via `validateDocument`, dia
fixo de fechamento 1–31, contato). Cliente vinculado via `customers.agreement_company_id`
(select no diálogo de cliente, mesmo padrão da lista de preço já existente).

Pagamento tipo `convenio` no PDV não mexe em caixa nem cria recebível na hora — chama
`finance.agreements.chargeAgreementRaw()`, que só insere uma linha pendente em
`agreement_charges`.

Fechamento mensal: `generateInvoice()` soma as cobranças pendentes da empresa desde o
último fechamento e cria **uma linha em `receivables`** (reaproveitando a tabela e a
tela de contas a receber já existentes, conforme decidido), marcando as cobranças
consolidadas com `invoiced_at`/`receivable_id`. Um índice único parcial
`(agreement_company_id, period_key)` impede gerar a mesma fatura duas vezes na mesma
máquina.

Como o Katsu não fica sempre aberto, o fechamento no dia exato não é garantido — um
novo `src/modules/finance/agreementScheduler.ts` (mesmo padrão de
`startBackupScheduler()`) verifica no boot (e periodicamente) se alguma empresa já
passou do dia de fechamento sem fatura gerada para o período atual, e gera
automaticamente; um botão manual "Gerar fatura agora" na nova tela `/app/finance/convenios`
cobre o caso de o app ficar fechado no dia exato.

`cancelSale()`: se a cobrança de convênio da venda já foi faturada, bloqueia o
cancelamento (mensagem orientando ajuste manual na fatura); caso contrário, remove a
cobrança pendente (soft delete).

## Fechando a brecha de venda duplicada (decidido: sim, agora)

`sales.client_request_id` (migration 0024, único quando não nulo). O PDV gera um UUID
uma única vez por tentativa de finalizar a venda (não a cada clique) e envia em
`clientRequestId`; `createSale()` insere esse valor na linha de `sales` — uma segunda
tentativa com o mesmo id colide no índice único e é tratada como "venda já registrada"
(devolve a venda já existente em vez de duplicar estoque/crédito/pontos/caixa).

## Relatório de reconciliação (saldos negativos pós-sync)

Novo endpoint `GET /api/finance/reconciliation/negative-balances` (permissão
`finance.reconciliation.view`) e tela simples `/app/finance/reconciliacao`: lista todo
cliente cujo `store_credit_cents` ou `loyalty_points` recomputado (após merge de sync)
esteja negativo, com o valor e um link pra ficha do cliente — resolução é manual
(conversa com o cliente), o sistema só sinaliza.

## Arquivos críticos
- `src/modules/store/sales.ts` (createSale/cancelSale — ponto de integração de todas as partes)
- `src/modules/finance/bills.ts`, `src/modules/finance/setup.ts`
- `src/modules/commercial/setup.ts` + novo `src/modules/commercial/customerLedger.ts`
- `src/modules/store/views/store-pdv.ejs`
- `src/modules/commercial/views/commercial-customers.ejs` (restilização) + nova `commercial-customer-ficha.ejs`
- `src/modules/commercial/module.manifest.ts` / `src/modules/finance/module.manifest.ts`
- `src/views/settings.ejs` (nova aba Fidelidade)

## Verificação

Novos arquivos de teste seguindo o padrão `src/tests/faseNN.ts` (servidor real, HTTP
real, `check()`/`failures`):

- **fase7a** (Parte A): venda a prazo parcelada gera N recebíveis com valores/vencimentos
  corretos (resto na 1ª parcela, +30 dias entre parcelas); carnê renderiza 200 com N
  vias; cancelamento reverte todas as parcelas (bloqueado se alguma já foi recebida).
- **fase7b** (Parte B): `store_credit_cents`/`loyalty_points` somente leitura via API;
  filtros `?customerId=`/`?partyId=` corretos; `cep` persiste. (Autofill via ViaCEP é
  client-side/externo — verificação manual, fora do harness automatizado.)
- **fase7c** (Parte C, single-machine + 2 máquinas): concessão/gasto de crédito de troca
  correto; venda rejeitada se insuficiente (sem efeito colateral em estoque/caixa);
  cancelamento devolve o saldo. Cenário de duas máquinas (mesmo padrão de
  `fase6a.ts`: dois `dev.ts` + `cloud/` + `provision-company.ts` + `syncBothTwice`):
  ambas offline resgatam saldo simultaneamente além do disponível; após sync, saldo
  final replicado é **idêntico e negativo** nas duas máquinas (convergência, não
  divergência) — e aparece no relatório de reconciliação.
- **fase7d** (Parte D): acúmulo/resgate de pontos correto (respeitando configuração
  ativa/taxas); divergência de valor no resgate é rejeitada; cancelamento reverte ganho
  e resgate. Mesmo cenário de convergência de duas máquinas da fase7c.
- **fase7e** (Parte E): cobrança de convênio não mexe em caixa/recebível na hora;
  geração de fatura consolida corretamente e bloqueia duplicata (índice único);
  cancelamento de cobrança não-faturada funciona, de faturada é bloqueado.
- **fase7f** (idempotência): duas chamadas `POST /api/store/sales` com o mesmo
  `clientRequestId` retornam a mesma venda, sem duplicar estoque/caixa/crédito/pontos.

## Observações assumidas (padrões recomendados, sem necessidade de nova pergunta)
- Pontos são sempre arredondados pra baixo no acúmulo; resgate exige valor exatamente
  igual a `pontos × valor_por_ponto` (sem arredondamento "a favor do cliente").
  Ajustável depois nas configurações de fidelidade se o usuário quiser outra regra.
- Os 3 novos tipos de forma de pagamento (crédito de loja, fidelidade, convênio) nascem
  **desativados** — o lojista habilita em "Formas de pagamento" quando estiver pronto
  para usar, evitando mudança de comportamento em instalações existentes.
- `fidelidade.ativo` nasce desativado pelo mesmo motivo.
