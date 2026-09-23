# Módulo de Estoque — Regras de Negócio

Documento técnico para suporte e treinamento de agentes de IA. Descreve o modelo, as regras
e os fluxos do estoque, incluindo lotes, validade, FIFO, custo/CMV, compras e importação de
NF-e.

## Visão geral

O estoque do Kivo é **derivado de um livro-razão** (ledger). O saldo de um produto
(`products.stock_qty`) nunca é editado direto: ele é a consequência das linhas de
`stock_movements`. Produtos podem ou não controlar estoque (`products.track_stock`).

Produtos marcados com `products.controla_lote = 1` trabalham por **lotes** com validade: a
entrada cria um lote e a saída consome os lotes em **FIFO/FEFO** (validade mais próxima
primeiro, depois o lote mais antigo).

## Princípios

- Saldo é derivado, nunca digitado. Ajuste de saldo vira uma movimentação do tipo `ajuste`.
- Toda variação de saldo gera uma linha em `stock_movements` (append-only).
- Produto sem controle de estoque (`track_stock = 0`) ignora movimentações automáticas
  (venda, compra, produção) e recusa ajuste manual.
- Lote nunca cria um "saldo paralelo": a soma dos lotes de um produto controlado acompanha o
  `stock_qty`.
- Nunca decidir que dois produtos são iguais só pelo nome; a NF-e identifica por EAN, código
  do fornecedor, código interno e só então sugere por nome.

## Modelo de dados

| Tabela | Papel |
| --- | --- |
| `products` | Catálogo. `stock_qty`, `cost_cents`, `track_stock`, `controla_lote`, `min_stock`, `purchase_unit`, `purchase_unit_qty` |
| `stock_movements` | Livro-razão do estoque (append-only): tipo, quantidade, saldo após, motivo, referência, `lot_id` |
| `product_lots` | Lotes: produto, código, validade, saldo, custo unitário, fornecedor, origem |
| `lot_consumptions` | Qual lote cada saída consumiu, quanto e a que custo (rastreabilidade e CMV FIFO) |
| `purchases` / `purchase_items` | Compras; itens guardam `lot_code` e `lot_expires_at` do rascunho |
| `purchase_invoices` / `purchase_invoice_items` | NF-e importada (histórico fiscal) |
| `product_barcodes` | Códigos secundários (caixa/lastro/inner), com `pack_qty` |
| `product_suppliers` | Vínculo produto x fornecedor: `supplier_code`, custo, conversão (`pack_qty`/`pack_unit`) |
| `product_type_config` | Comportamento de cada tipo de produto (controla estoque, ativo) |

## Saldo de estoque e o ledger

### Tipos de movimentação

- `entrada`: soma ao saldo. Usada em compra, devolução, estorno, produção, estoque inicial.
- `saida`: subtrai do saldo. Usada em venda, consumo de insumo, baixa de lote.
- `ajuste`: **define** o saldo (o valor informado vira o novo saldo), não soma.

Cada linha guarda o `balance_after` para auditoria e reconstrução.

### Regras de saldo negativo

- Movimentação manual (ajuste, entrada/saída pelo menu) **não** permite saldo negativo.
- Movimentação automática de venda pode ir a negativo conforme a configuração
  `estoque.venda_estoque_zerado`: `1` = permitir (padrão), `0` = bloquear.

### Recompute (reconstrução)

`recomputeStockForProducts(productIds)` relê o ledger de um produto e recalcula o saldo e o
`balance_after` de cada movimento. Roda no merge de sincronização (`stock_movements` é uma
tabela de ledger do produto), garantindo que o saldo convirja entre máquinas mesmo com
edições concorrentes.

## Lotes, validade e FIFO/FEFO

Ligado por produto em `controla_lote`. Só esses produtos entram no fluxo de lote.

### Ordem de consumo

A saída consome os lotes nesta ordem:

1. Lotes **com validade**, do vencimento mais próximo para o mais distante (FEFO).
2. Lotes **sem validade**, pelo mais antigo primeiro (FIFO por data de entrada).

Empate resolvido por `received_at` e `id`.

### Entrada de lote

- A entrada cria o lote ou **reabastece** o lote de mesmo produto + código + validade. O custo
  do lote vira **média ponderada** quando ele é reabastecido.
- Sem código de lote informado, a entrada cai num lote "sem lote" (código nulo) — salvo se a
  política exigir lote.
- Com `estoque.lote_obrigatorio = 1`, entradas **manuais** e de **compra** exigem código de
  lote. Estornos (devolução, reversão de NF-e, cancelamento) nunca são barrados.

### Bloqueio de vencido

`estoque.validade_acao` define o comportamento quando um lote está vencido:

- `alertar` — só avisa (a venda passa).
- `sugerir_baixa` — avisa e sugere baixa (padrão).
- `bloquear` — a saída que consumiria um lote vencido é **recusada** antes de qualquer escrita.

O prazo do alerta é `estoque.validade_alerta_dias` (padrão 30).

### Ajuste com lotes

Num ajuste de produto controlado, a diferença é tratada como entrada (vira lote) ou saída
(consome FIFO), para a soma dos lotes continuar igual ao saldo.

## Custo e CMV

`estoque.metodo_custo` define o método. O padrão preserva o comportamento histórico.

### Média ponderada móvel (`medio`, padrão)

Na compra: `novoCusto = (saldo * custoAtual + qtdEntrada * custoEntrada) / (saldo + qtd)`.
A média não se aplica (volta ao custo da compra) quando o saldo é zero/negativo, o custo atual
é zero (primeira compra) ou o produto não controla estoque. Implementado em
`weightedAverageCostCents` (`purchaseInbound.ts`).

### FIFO (`fifo`)

O custo da venda é o custo do **lote que efetivamente sai**. `fifoUnitCostCents` espelha o
consumo FIFO **sem consumir** (média dos lotes que cobrem a quantidade); o que não houver em
lote cai no custo de reposição do produto. Vale para o item, para componentes de kit/combo e
para insumos de ficha técnica (`store/sales.ts`).

O `lot_consumptions` registra o custo unitário de cada lote consumido — base do CMV por FIFO
e da rastreabilidade.

## Compras (entrada de mercadoria)

- A compra nasce como `rascunho` e é recebida depois (`/receive`), ou já nasce `recebida`.
- Ao receber: para cada item, recalcula o custo e lança a entrada no estoque.
- Itens guardam `lot_code`/`lot_expires_at`, então o lote digitado na conferência é aplicado
  no recebimento (não se perde entre criar e receber).
- Conversão de unidade: se o produto tem `purchase_unit` diferente da unidade de venda, a
  compra aceita quantidade na unidade de compra e converte por `purchase_unit_qty`.

## Importação de NF-e

Fluxo: `preview` (classificação, sem gravar) e `commit` (grava tudo numa transação).

### Identificação do item (cascata)

1. **EAN/GTIN** — match exato no código principal ou nos secundários (`product_barcodes`).
2. **Código do fornecedor** (`product_suppliers`, por `cProd`) já vinculado.
3. **Código interno + fornecedor** (`cProd` == SKU de produto já vinculado a este fornecedor).
4. **Nome** — apenas como sugestão (exige confirmação).

### Conversão de unidade (un/cx)

A nota pode faturar em caixa (uCom=CX) enquanto o produto é vendido em unidade. O fator
(unidades de venda por unidade da nota) vem, nesta ordem:

1. Unidade da nota igual à de venda — fator 1.
2. `uTrib` (unidade tributável) igual à de venda — fator `qTrib / qCom`.
3. Conversão já conhecida do fornecedor (`product_suppliers.pack_qty`).
4. Sem pista — a tela pede o fator ao usuário e o vínculo guarda para a próxima.

### EAN de caixa

O EAN de embalagem **nunca** vira `products.barcode`. Ele vai para `product_barcodes`
(kind=`caixa`) com o fator de conversão. O código principal do produto recebe o EAN de
unidade (comercial ou tributável).

### Rastro (lote/validade)

Quando o item traz `<rastro>` (`nLote`, `dVal`, `qLote`):

- A linha vira **um item de compra por lote**, dividindo a quantidade pelo `qLote` (o que
  faltar é rateado igualmente).
- Produto **novo** que vem com rastro já nasce com `controla_lote = 1`.
- Produto **vinculado** respeita a configuração atual do cadastro.

## Tipos de produto

O comportamento de cada tipo é configurável em **Configurações > Tipos de produto**
(tabela `product_type_config`):

- `controls_stock` — o tipo tem saldo próprio? Se `0`, o produto nasce com `track_stock = 0` e
  a chave "Não controla estoque" fica travada no cadastro.
- `active` — o tipo é oferecido ao criar produtos? Se `0`, o seletor o esconde e o servidor
  recusa criar produto daquele tipo.

Regra especial da **variante**: só o produto-pai não tem saldo; cada variação (filha) tem o
dela. Os UUIDs das linhas de tipo são fixos para o sync casar a mesma linha entre máquinas.

## Devolução e cancelamento

- Cancelar venda e devolver itens gera entradas de estoque com `skipLot`, e o lote de origem é
  devolvido por `restoreLotsForSale`, que usa os `lot_consumptions` da venda para reabastecer
  os lotes com o código, a validade e o custo originais.
- Cada consumo usado é reduzido (e removido ao zerar), então devoluções parciais repetidas não
  duplicam a devolução.
- Para produtos sem lote, `restoreLotsForSale` não faz nada e a entrada é comum.

## Baixa de lote

`writeOffLot` (botão "Dar baixa" em Lotes e validade) zera um lote, subtrai o saldo do produto
e registra movimento (`lot_writeoff`) e consumo. É explícita — não passa pela checagem de
saldo negativo da venda.

## Configurações (chaves `estoque.*`)

| Chave | Padrão | Efeito |
| --- | --- | --- |
| `estoque.venda_estoque_zerado` | `1` | Permite vender com saldo negativo |
| `estoque.auto_sku` | `0` | Gera SKU ao cadastrar produto sem código |
| `estoque.min_stock_padrao` | `5` | Estoque mínimo sugerido no cadastro |
| `estoque.lote_obrigatorio` | `0` | Exige lote em entradas manuais/compra |
| `estoque.validade_alerta_dias` | `30` | Antecedência do alerta de vencimento |
| `estoque.validade_acao` | `sugerir_baixa` | Ação em lote vencido (alertar, sugerir_baixa, bloquear) |
| `estoque.metodo_custo` | `medio` | Método de custo (medio ou fifo) |

## Sincronização

Tabelas sincronizadas pelo módulo commercial: `products` (sem `stock_qty` e `image_url`),
`product_barcodes`, `product_lots`, `stock_movements` (ledger do produto, com `lot_id`),
`lot_consumptions`, `purchases`/`purchase_items`, `product_type_config`.

- `stock_qty` **não** viaja: é recalculado pelo hook de recompute a partir do ledger.
- `product_lots` vem antes de `stock_movements` (que referencia `lot_id`).
- Ao receber uma movimentação, o recompute do produto roda e o saldo converge.

## Endpoints principais

| Método e rota | Função |
| --- | --- |
| `POST /api/commercial/stock/move` | Entrada, saída ou ajuste (aceita `lote`, `validade`, `custo`) |
| `GET /api/commercial/stock/movements` | Histórico de movimentações |
| `GET /api/commercial/stock/lots` | Lotes de um produto ou vencendo em N dias |
| `POST /api/commercial/stock/lots/:id/write-off` | Baixa de lote |
| `GET/PUT /api/commercial/product-types` | Configuração dos tipos de produto |
| `POST /api/commercial/purchases` | Cria compra (rascunho ou recebida) |
| `POST /api/commercial/purchases/:id/receive` | Recebe rascunho (posta estoque/custo) |
| `POST /api/nfe/preview` e `POST /api/nfe/commit` | Importação de NF-e |

## Fluxos de exemplo

### Compra de refrigerante em caixa, venda em unidade

1. NF-e traz `uCom=CX`, `qCom=2`, `uTrib=UN`, `qTrib=24`, EAN da caixa e EAN da unidade.
2. O preview sugere fator 12 e separa EAN de caixa x unidade.
3. No commit, o vínculo guarda a conversão e o EAN da caixa vai para `product_barcodes`.
4. A entrada lança 24 unidades; o custo é o da nota dividido por 12.

### Perecível com lote e validade

1. Produto com `controla_lote = 1`.
2. Entrada com lote `L-1` e validade; vira uma linha em `product_lots`.
3. Venda consome o lote de vencimento mais próximo; `lot_consumptions` registra o consumo.
4. Lote vencido aparece em Lotes e validade; conforme a política, alerta, sugere baixa ou
   bloqueia a venda.

## Erros comuns e diagnóstico

- "Estoque insuficiente" — saída manual acima do saldo. Use ajuste ou entrada antes.
- "Produto X exige lote" — `estoque.lote_obrigatorio` ligado e entrada manual/compra sem
  código de lote.
- "O lote X está vencido" — política `bloquear` e o lote mais antigo está vencido; dê baixa ou
  ajuste a política.
- "Tipo de produto desativado" — `active = 0` em Tipos de produto.
- Saldo divergente entre máquinas — rode a sincronização; o recompute reconstrói o saldo a
  partir do ledger.

## Arquivos-chave

- `src/modules/commercial/stock.ts` — motor de saldo, lotes, FIFO e baixa.
- `src/modules/commercial/repositories/LotRepository.ts` — lotes e consumo.
- `src/modules/commercial/purchaseInbound.ts` — custo médio e entrada de compra.
- `src/modules/commercial/productTypes.ts` — configuração dos tipos.
- `src/modules/store/sales.ts` — custo da venda (média ou FIFO) e devolução.
- `src/modules/nfe/nfeParse.ts`, `nfeResolve.ts`, `nfeImport.ts` — importação de NF-e.
