# Resumo — Estoque, Lotes/FIFO, NF-e e Tipos de Produto

Registro das mudanças feitas no módulo de estoque/comercial e na importação de NF-e.
Tudo aditivo e retrocompatível: produtos sem lote seguem o comportamento anterior.

## 1. Correção de conflitos falsos na edição de NF-e
Compra por caixa acusava "EAN diferente do cadastrado" e "Unidade diferente" ao reabrir a
edição, porque a reclassificação comparava o dado cru da nota com o cadastro.
- `nfeResolve.ts`: `computeFlags` ficou ciente da conversão — só acusa EAN quando o produto
  não tem **nenhum** dos códigos da nota (`cEAN`/`cEANTrib`); não acusa unidade quando o
  `uTrib` já é a unidade de venda.
- Catálogo passou a indexar os **códigos secundários** (`product_barcodes`), então o EAN da
  caixa identifica o produto. O badge "EAN de caixa" continua informativo (não é conflito).

## 2. Configuração de Estoque (Configurações → Estoque)
Tela central das variáveis de estoque.
- **Operação**: vender com estoque zerado, SKU automático, estoque mínimo padrão.
- **Lotes e validade**: exigir lote na entrada, dias de alerta de vencimento, ação em vencido
  (só alertar / alertar e sugerir baixa / alertar e bloquear venda).
- **Custo**: média ponderada móvel (padrão) ou FIFO.
- Chaves `estoque.*` semeadas em `core/database/seeds.ts`.

## 3. Lotes, validade e FIFO (motor de estoque)
- **Migration `0075_stock_lots`**: `products.controla_lote`, `product_lots`,
  `lot_consumptions`, `stock_movements.lot_id`.
- `repositories/LotRepository.ts`: entrada cria/reabastece lote (custo por média ponderada);
  saída consome em **FIFO/FEFO** (validade mais próxima, depois lote mais antigo).
- `stock.ts`: integra lotes ao `moveStockRaw`; valida o bloqueio de vencido **antes** de
  consumir; `estoque.lote_obrigatorio` exige lote em entradas manuais/compra.
- `controla_lote` no cadastro de produto (API + modal) e campos de lote/validade no diálogo
  "Movimentar estoque".
- API: `GET /api/commercial/stock/lots` e `POST /api/commercial/stock/move` com
  `lote`/`validade`/`custo`.

## 4. Lote/validade na NF-e e nas compras
- `nfeParse.ts`: lê `<rastro>` (`nLote`/`dVal`/`qLote`).
- `nfeImport.ts`: cria **um item de compra por lote**, dividindo a quantidade pelo `qLote`;
  produto novo com rastro nasce com `controla_lote=1`.
- `purchaseInbound.ts` + `purchase_items` (migration `0076`): lote/validade por item,
  preservados do rascunho até o recebimento; campos no diálogo de compra.

## 5. Tela de Lotes e validade + baixa
- Página `/app/commercial/lotes` (menu **Lotes e validade**): lotes vencendo no prazo, status
  e botão **Dar baixa**.
- `writeOffLot` em `stock.ts` + `POST /api/commercial/stock/lots/:id/write-off`: zera o lote,
  subtrai o saldo e registra movimento/consumo.

## 6. FIFO no custo/CMV
- `stock.ts`: `fifoCostEnabled()` e `fifoUnitCostCents()` (espelha o consumo FIFO **sem
  consumir**; o que falta cai no custo de reposição).
- `store/sales.ts`: com `estoque.metodo_custo = fifo`, o custo da venda usa o lote que sai —
  item, componentes de kit/combo e insumos de ficha técnica.

## 7. Devolução/cancelamento ao lote de origem
- `stock.ts`: `restoreLotsForSale()` devolve a quantidade estornada aos **lotes originais**
  (código/validade/custo dos consumos registrados), reduzindo os consumos para não duplicar
  em devoluções parciais. `moveStockRaw` ganhou `opts.skipLot` para o estorno não criar lote.
- `store/sales.ts`: cancelamento e devolução (incluindo componentes/insumos) usam esse caminho.

## 8. Tipos de produto configuráveis (Fase 2)
- **Migration `0077_product_type_config`**: tabela `product_type_config` com 7 tipos e
  **UUIDs fixos** (o sync casa a mesma linha entre máquinas).
- `productTypes.ts`: repositório, cache curto e helpers `typeControlsStock`/`typeIsActive`.
- API `GET`/`PUT /api/commercial/product-types`.
- Aba **Tipos de produto** em Configurações (toggles "Controla estoque" e "Ativo").
- `productsRoutes.ts` respeita a config (estoque e tipo desativado); variante mantém a regra
  pai/filha. O modal de produto lê a config (trava de estoque, motivo e tipos ativos).

## 9. Sincronização / conciliação entre máquinas
- Manifesto de sync (`module.manifest.ts`): `product_lots` (antes de `stock_movements`, que
  referencia `lot_id`), `lot_consumptions` e `product_type_config`.
- `fase7d` estendido: produto com lote e entrada `LS-1` em A → após o sync, B recebe o produto
  (`controla_lote=1`, saldo 7) e o lote (qty 7, validade 2030-01-01, custo 250).

## Migrations criadas
| Migration | Conteúdo |
|---|---|
| `0075_stock_lots` | `controla_lote`, `product_lots`, `lot_consumptions`, `stock_movements.lot_id` |
| `0076_purchase_item_lot` | `purchase_items.lot_code`, `lot_expires_at` |
| `0077_product_type_config` | tabela `product_type_config` + 7 tipos semeados |

## Testes
Novos: `stock-lots`, `nfe-rastro`, `product-types`; `fase7d` estendido com lotes.
Regressões verificadas: `nfe-import`, `fase8b`, `fase_kits`, `pdv-improvements`,
`pdv-tipos-produto`, `product-image-suggest`, `csp`. `tsc --noEmit` e eslint limpos.

## Observações
- Produtos com `controla_lote = 0` (padrão) mantêm exatamente o comportamento anterior.
- Sem método de custo FIFO (`estoque.metodo_custo = medio`), o custo da venda continua sendo
  a média ponderada móvel.
- Cancelamento após devolução parcial pode deixar pequena diferença entre soma dos lotes e
  saldo (a lógica de estoque já tinha essa característica para devoluções).
