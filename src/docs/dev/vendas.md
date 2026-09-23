# Módulo de Vendas / PDV — Regras de Negócio

Documento técnico do módulo `store` (PDV, vendas, orçamentos e devoluções). Complementa
`estoque.md` — a venda é o principal consumidor do estoque.

## Visão geral

A venda é criada por `createSale` (`src/modules/store/sales.ts`). Ela resolve os itens
(explodindo kit e ficha técnica), resolve o preço, valida os pagamentos e grava tudo em UMA
transação: venda, itens, pagamentos, baixa de estoque, recebíveis, crédito de loja,
fidelidade, convênio e caixa.

Depende dos módulos `commercial` (produtos, estoque, preço, crédito, fidelidade) e `finance`
(formas de pagamento, caixa, recebíveis, convênios).

## Entidades

| Tabela | Papel |
| --- | --- |
| `sales` | Cabeçalho da venda: totais, desconto/acréscimo, cliente, forma, caixa, status |
| `sale_items` | Itens: produto, quantidade, preço, custo (CMV), total, `line_group_uuid` |
| `sale_payments` | Pagamentos: forma, valor, taxa, recebido/troco, pontos usados, recebível |
| `quotes` / `quote_items` | Orçamentos (preço congelado) |
| `sale_returns` / `sale_return_items` | Devoluções (total ou parcial) |

## Fluxo de venda (createSale)

Pré-requisitos: existe caixa aberto (`cash.currentRegister()`), senão a venda é recusada com
"Abra o caixa antes de realizar uma venda."

### 1. Resolução dos itens

Para cada item: o produto precisa existir, estar ativo e ter quantidade positiva. A
**variante-mãe** (tipo `variante` sem `parent_product_id`) é recusada — quem se vende é a
variação (filha).

- **Kit/Combo**: os componentes entram como itens irmãos, com preço 0 e custo do componente,
  amarrados pelo mesmo `line_group_uuid`. O estoque é baixado por item (inclusive componentes).
- **Produzido**: a ficha técnica gera consumo automático dos insumos (`recipeConsumption`) e o
  custo do produto é a soma dos insumos. Insumo precisa controlar estoque.
- **Complementos/opcionais**: principal e adicionais são linhas irmãs pelo `line_group_uuid`
  (não é estrutura aninhada).

### 2. Resolução de preço

`resolvePrice(productId, qty, customerId)` (`commercial/pricing.ts`), nesta ordem:

1. Lista de preço **do cliente** (se o cliente tem lista vinculada).
2. Lista de preço **padrão**.
3. **Catálogo** (`products.price_cents`).

Cada lista pode ter faixas por quantidade (`min_qty`). O orçamento usa o preço congelado via
`allowPriceOverride`.

### 3. Desconto e acréscimo

`total = subtotal - discountCents + surchargeCents` (não pode ficar negativo). Aplicar
desconto/acréscimo exige a permissão `store.sales.discount` — exceto quando a venda vem de um
orçamento já autorizado (`allowDiscount`).

### 4. Pagamentos

Aceita `payments[]` (múltiplas formas) ou o formato legado `paymentMethod`. A **soma dos
pagamentos precisa fechar o total** exatamente. Cada forma tem regras próprias:

| Tipo | Regra |
| --- | --- |
| `dinheiro` | `receivedCents >= amountCents`; troco = recebido - valor |
| `prazo` | Exige cliente; 1 a 12 parcelas; gera recebíveis (intervalos de 30 dias) |
| `credito_loja` | Exige cliente; resgata o crédito de troca |
| `fidelidade` | Exige cliente; clube ativo; `pointsUsed * centsPerPoint == amountCents` |
| `convenio` | Exige cliente com empresa conveniada; gera cobrança do convênio |
| demais (pix, débito, crédito) | Taxa por `fee_bps` da forma de pagamento |

As formas de pagamento vêm do módulo `finance` (ativas). `fee_bps` vira `fee_cents`.

### 5. Cliente

Pode vir no corpo (`customerId`) ou dentro de um pagamento que exige cliente (prazo, convênio,
crédito de loja, fidelidade). Se só os pagamentos informam cliente e todos apontam para o
**mesmo**, ele é adotado como `sales.customer_id` — senão fica nulo. O nome do comprador é
congelado na venda (`resolveCustomerName`): cadastro tem prioridade; sem cadastro, vale o nome
digitado.

### 6. Fidelidade (ganho de pontos)

Com o clube ativo e cliente identificado, os pontos são calculados sobre a base de pagamentos
que **exclui** crédito de loja e fidelidade (`loyaltyEarnBaseCents`). A regra de pontos vem de
`loyalty.pointsForSaleCents`.

### 7. Caixa

Pagamentos em dinheiro lançam movimento de **entrada** no caixa aberto.

### 8. Idempotência

Com `clientRequestId`, uma venda repetida devolve a existente em vez de duplicar (protege o
PDV de reenvio por rede/duplo clique).

### 9. Pós-gravação

- Auditoria (`venda`).
- Notifica a cozinha (KDS) — pulado no fechamento de comanda (`skipKitchenNotify`), que já
  enviou os itens um a um.
- Agenda sincronização com a nuvem (`scheduleSyncSoon`) — o painel do Kivo Web mostra o
  movimento de hoje sem esperar o ciclo.

## Cancelamento de venda

`cancelSale` recusa quando: venda já cancelada, conta a receber já recebida, cobrança de
convênio já faturada, ou há **nota fiscal viva** para a venda (cancele a nota antes).

Ao cancelar, numa transação:

- Estorna o estoque de cada item (com `skipLot`) e devolve aos **lotes de origem**
  (`restoreLotsForSale`).
- Devolve dinheiro ao caixa, se houve pagamento em dinheiro.
- Cancela recebíveis e a cobrança do convênio.
- Estorna crédito de loja e pontos resgatados; remove os pontos ganhos na venda.
- Marca a venda como `cancelada`.
- Cancela os tickets de cozinha (best-effort).

## Devolução parcial

`returnSale` só vale para venda `concluida`. A quantidade devolvida não pode passar do que
sobrou (vendido menos já devolvido). `refundMethod`:

- `nenhum` — só recompõe estoque.
- `dinheiro` — saída do caixa.
- `credito_loja` — gera vale (exige cliente).

Recompõe o estoque espelhando o que a venda consumiu (incluindo componentes de kit e insumos
de ficha técnica) e devolve aos lotes de origem. A venda original **não** é alterada: o
histórico guarda a venda e as devoluções.

## Orçamentos

- Montados no PDV (não há tela própria): busca com variantes, complementos, tabelas de preço e
  observação por item.
- O **preço cotado é congelado** em `quote_items` e honrado na conversão (`allowPriceOverride`).
- Kit/combo e ficha técnica **não** são explodidos no orçamento — a explosão acontece na
  conversão em venda (senão os componentes duplicariam).
- Conversão: `createQuote` gera a venda reutilizando os itens e o desconto do orçamento.

## Comandas (integração)

O fechamento de comanda chama `createSale` com `skipKitchenNotify`, porque os itens já foram
enviados à cozinha no lançamento (ticket `comanda` por item).

## Configurações relevantes

| Chave | Efeito |
| --- | --- |
| `pdv.som` | Sinal sonoro ao adicionar item/finalizar |
| `pdv.imprimir_automatico` | Imprime o cupom sem perguntar |
| `pdv.desconto_exige_motivo` | Exige motivo no desconto/acréscimo |
| `pdv.desconto_maximo_percentual` | Acima disso, exige PIN |
| `pdv.parcelas_max` | Máximo de parcelas na venda a prazo |
| `vendas.exibir_cupom_fiscal` | Mensagem de impressão de cupom |
| `fidelidade.*` | Ativação e regras do clube |

## Endpoints principais

| Método e rota | Função |
| --- | --- |
| `POST /api/store/sales` | Cria a venda |
| `GET /api/store/sales` | Lista/histórico |
| `POST /api/store/sales/:id/cancel` | Cancela a venda |
| `POST /api/store/sales/:id/return` | Devolução total/parcial |
| `GET/POST /api/store/quotes` | Orçamentos |
| `POST /api/store/quotes/:id/convert` | Converte orçamento em venda |

## Erros comuns e diagnóstico

- "Abra o caixa antes de realizar uma venda." — não há caixa aberto no financeiro.
- "Pagamentos (X) não fecham o total (Y)." — a soma das formas não bate com o total.
- "Venda a prazo exige cliente." — informe o cliente na venda ou no pagamento.
- "Quantidade de pontos não corresponde ao valor do pagamento." — `pointsUsed * centsPerPoint`
  difere do valor.
- "Produto X é um produto com variações — escolha a variação." — tentou vender a variante-mãe.
- "Esta venda tem nota fiscal emitida." — cancele a nota antes de cancelar a venda.

## Arquivos-chave

- `src/modules/store/sales.ts` — criação, cancelamento e devolução.
- `src/modules/store/quotes.ts` — orçamentos e conversão.
- `src/modules/store/repositories/SaleRepository.ts` — persistência.
- `src/modules/commercial/pricing.ts` — resolução de preço.
- `src/modules/finance/*` — formas de pagamento, caixa, recebíveis, convênios.
