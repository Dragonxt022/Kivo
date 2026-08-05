# Orçamento pelo PDV + Import/Export completo do catálogo

## Contexto

Dois trabalhos independentes, que podem ser feitos em qualquer ordem.

**Parte 1 — o orçamento está quebrado por desenho.** A tela `/app/store/orcamentos` monta o
orçamento com um `<select>` simples de produtos e nada mais. Confirmado no código:

- **Variações não aparecem.** O select carrega `GET /api/commercial/products` sem `?q=`
  ([store-quotes.ejs:200](src/modules/store/views/store-quotes.ejs#L200)), que cai em
  `ProductRepository.listTopLevel()` — e essa query exclui tanto o pai variante quanto os
  filhos. O PDV escapa disso porque busca com `?q=`, que usa `search()` e devolve as variantes.
- **Complementos não existem no orçamento.** A migration `0041` adicionou `notes` e
  `line_group_uuid` **só em `sale_items`**; `quote_items` está intocada desde a `0007`. Sem
  `line_group_uuid` não há como amarrar principal + adicionais. E mesmo que houvesse,
  `convertQuote` ([quotes.ts:98](src/modules/store/quotes.ts#L98)) mapeia apenas
  `{productId, qty, unitPriceCents}` e descarta o resto.
- **Não dá pra adicionar produto depois de criado.** `updateQuoteSchema` não aceita `items` e a
  UI esconde o bloco de itens na edição ([store-quotes.ejs:101](src/modules/store/views/store-quotes.ejs#L101)).
  Para trocar uma quantidade, hoje é preciso cancelar e refazer.
- **Preço diverge do PDV.** `createQuote` lê `products.price_cents` cru
  ([quotes.ts:31-38](src/modules/store/quotes.ts#L31-L38)) em vez de `pricing.resolvePrice`, então
  cliente com tabela de preço recebe orçamento com preço cheio — e a distorção congela na conversão.

O PDV já tem tudo o que falta: busca que devolve variantes, diálogo de complementos com
`min_select`/`max_select` e `lineGroupUuid`, pricing service, desconto/acréscimo, observação por
item, múltiplos pagamentos. **A saída é o PDV virar o único lugar onde orçamento se monta.**
O caminho de volta já existe pronto para copiar: a ponte comanda → PDV
(`/app/store/pdv?comandaId=N` → `loadComanda()`, [store-pdv.ejs:927](src/modules/store/views/store-pdv.ejs#L927)).

**Parte 2 — o import/export só cobre produto simples.** O exportador filtra
`product_type = 'fisico' AND parent_product_id IS NULL`
([productsImportRoutes.ts:65](src/modules/commercial/productsImportRoutes.ts#L65)); o próprio
comentário acima diz que variantes/kits/combos ficaram para depois. Quem tem catálogo com grade,
kit ou complemento não consegue exportar nem migrar de instalação.

---

# Parte 1 — Orçamento montado no PDV

## Fluxo alvo

1. Operador monta a venda normalmente no PDV (com variação, complemento, desconto, observação).
2. Clica **Orçamento (F6)** → informa cliente/validade/observação → salva. O carrinho é gravado
   em `quotes`/`quote_items` com os preços do momento congelados.
3. `/app/store/orcamentos` lista, filtra, imprime e cancela — **não monta mais nada**.
4. "Editar" e "Faturar" abrem `/app/store/pdv?quoteId=N`: o carrinho volta, o operador ajusta se
   quiser, e finaliza pelo fluxo de pagamento completo do PDV.

## 1.1 Migration `src/modules/store/migrations/0057_quote_pdv/`

`up.sql` — segue a convenção de `0039_store_sale_cost_cents` (ALTER simples + DROP no down):

```sql
-- Orçamento montado no PDV precisa carregar a mesma informação da venda:
-- complementos (linhas irmãs amarradas por line_group_uuid), observação por item
-- e acréscimo — que o PDV já tem no carrinho e o orçamento não sabia guardar.
ALTER TABLE quote_items ADD COLUMN notes TEXT;
ALTER TABLE quote_items ADD COLUMN line_group_uuid TEXT;
ALTER TABLE quotes ADD COLUMN surcharge_cents INTEGER NOT NULL DEFAULT 0;
```

> ⚠️ `doc/plano.md` (módulo Ordem de Serviço, ainda não implementado) reserva `0057_serviceorder_base`.
> Como esta entra primeiro, atualizar aquele plano para `0058`.

## 1.2 `src/shared/schemas.ts`

- `quoteItemSchema` passa a ter a mesma forma de `saleItemSchema` ([:48-54](src/shared/schemas.ts#L48-L54)) —
  `unitPriceCents`, `notes`, `lineGroupUuid`. Reusar `saleItemSchema` direto.
- `createQuoteSchema` += `surchargeCents`, `clientRequestId`.
- `updateQuoteSchema` += `items` (opcional) e `surchargeCents`. Tornar `customerId`, `validUntil` e
  `notes` **nullable**: `null` limpa, ausente preserva — hoje o `COALESCE` de
  [quotes.ts:146-148](src/modules/store/quotes.ts#L146-L148) torna impossível desvincular cliente
  ou apagar a validade.
- Novo `convertQuoteSchema`: `items` opcional + `payments[]` + `clientRequestId` (mesmo formato de
  `createSaleSchema`). Hoje `/convert` é a única rota de mutação do módulo sem `validateBody`
  ([routes.ts:19](src/modules/store/routes.ts#L19)).

## 1.3 `src/modules/store/quotes.ts`

- **`resolveQuoteItems()`** novo helper: valida produto ativo e resolve preço via
  `getService<CommercialPricingService>('commercial.pricing').resolvePrice(...)`, igual a
  [sales.ts:99-102](src/modules/store/sales.ts#L99-L102), honrando `unitPriceCents` quando
  `opts.allowPriceOverride`. **Não** explode kit nem ficha técnica — o orçamento guarda a linha-pai
  e a explosão continua acontecendo dentro do `createSale` na conversão.
- `createQuote` grava `notes`, `line_group_uuid` e `surcharge_cents`.
- `updateQuote` aceita `items`: dentro da mesma transação, `DELETE FROM quote_items WHERE quote_id = ?`
  + reinsert + recálculo de subtotal/total. Corrigir também o desconto que não volta a zero
  (hoje o cliente envia `|| undefined` e o servidor faz `!= null ? ... : before.discount_cents`).
- `convertQuote(req, id, payment, items?)` — mesmo padrão de `closeComanda`
  ([comandas.ts:188-196](src/modules/comandas/comandas.ts#L188-L196)): usa os itens recebidos do PDV
  ou, na ausência, os do banco. Sempre repassa `unitPriceCents`, **`notes` e `lineGroupUuid`** ao
  `createSale`, além de `clientRequestId`. Mover a checagem de status/validade para dentro da
  transação (hoje lê antes, em [:75-85](src/modules/store/quotes.ts#L75-L85)).
- Remover a linha morta `const ins = quoteRepository.rawRun.bind(...)` ([:57](src/modules/store/quotes.ts#L57)).

**`sales.ts`**: adicionar `allowDiscount?: boolean` a `opts` de `createSale`
([:236](src/modules/store/sales.ts#L236)) e usá-lo na guarda de
[:257-259](src/modules/store/sales.ts#L257-L259). Só `convertQuote` passa essa flag — o desconto já
foi autorizado por quem criou o orçamento (a mesma permissão é checada em `createQuote`), e hoje um
vendedor sem `store.sales.discount` não consegue faturar um orçamento com desconto que ele nem fez.

## 1.4 `StoreController.getQuote` ([:80](src/modules/store/controllers/StoreController.ts#L80))

Incluir `product_id`, `notes` e `line_group_uuid` no SELECT dos itens — sem eles o PDV não
consegue remontar o carrinho.

## 1.5 `src/modules/store/views/store-pdv.ejs`

Espelhar em tudo o que já existe para comanda:

| Onde | Mudança |
|---|---|
| Forma do slot ([:712](src/modules/store/views/store-pdv.ejs#L712), [:839](src/modules/store/views/store-pdv.ejs#L839), [:938](src/modules/store/views/store-pdv.ejs#L938)) | `+ quoteId: null, quoteLabel: null` |
| `repriceCart()` ([:1060](src/modules/store/views/store-pdv.ejs#L1060)) | `if (comandaId \|\| quoteId) return;` — preço do orçamento é congelado |
| `.pdv-actions` ([:173-197](src/modules/store/views/store-pdv.ejs#L173-L197)) | botão **Orçamento**, `<% if (user.permissions.has('store.quotes.create')) %>`, atalho **F6** (livre) |
| `keydown` ([:895-901](src/modules/store/views/store-pdv.ejs#L895-L901)) | `case 'F6'` → `openQuoteDlg()` |
| Novo `x-ref="quoteDlg"` | validade + observação (cliente vem do slot); `saveQuote()` |
| `init()` ([:885](src/modules/store/views/store-pdv.ejs#L885)) | ler `?quoteId=` → `loadQuote(n)` |
| Novo `loadQuote(id)` | cópia de `loadComanda` ([:927-946](src/modules/store/views/store-pdv.ejs#L927-L946)) — `GET /api/store/quotes/:id`, exige `status === 'aberto'`, slot dedicado |
| Banner ([:41-49](src/modules/store/views/store-pdv.ejs#L41-L49)) | irmão para orçamento: "Orçamento #N" + Salvar alterações + Cancelar. **A busca de produtos ([:51](src/modules/store/views/store-pdv.ejs#L51)) continua visível** — é `x-show="!comandaId"` e não deve ganhar `quoteId` |
| `finish()` ([:1358-1371](src/modules/store/views/store-pdv.ejs#L1358-L1371)) | se `quoteId`, `POST /api/store/quotes/:id/convert` |

`saveQuote()` e o `finish()` de orçamento mandam `unitPriceCents: i.price_cents` em cada item.
**Isso é obrigatório**: o `commonBody` atual manda item sem `unitPriceCents`
([:1365](src/modules/store/views/store-pdv.ejs#L1365)), e é exatamente por isso que o preço
congelado da comanda é perdido hoje ao fechar pelo PDV. Não repetir o defeito aqui.

## 1.6 `src/modules/store/views/store-quotes.ejs` → só listagem

- "Novo orçamento" → `location = '/app/store/pdv'`.
- "Editar" e "Converter em venda" → `location = '/app/store/pdv?quoteId=' + q.id`.
- Apagar os diálogos `x-ref="dlg"` e `x-ref="conv"` e os métodos `openNew`/`openEdit`/`addItem`/
  `total`/`save`/`openConvert`/`convert` ([:203-265](src/modules/store/views/store-quotes.ejs#L203-L265)).
  Some junto o diálogo de conversão de forma de pagamento única, que hoje não alcança parcelamento,
  crédito de loja, fidelidade nem convênio.
- Preservar: listagem, filtros, ordenação, imprimir e cancelar.

`store-quote-print.ejs`: indentar as linhas de complemento pela mesma regra do carrinho
([store-pdv.ejs:98](src/modules/store/views/store-pdv.ejs#L98)).

---

# Parte 2 — Import/Export completo do catálogo

Formato: **2 CSVs** (`;` + BOM UTF-8, igual ao atual — é o que o Excel brasileiro abre).
Escopo: só catálogo — produtos dos 11 `product_type`, categorias, variantes/atributos, kits/combos,
fichas técnicas e grupos de complemento.

## 2.1 `produtos.csv` — colunas novas, **acrescentadas ao fim**

A ordem existente não muda (mesma disciplina do comentário em
[productsImport.ts:32-35](src/modules/commercial/productsImport.ts#L32-L35), que anexou os campos
fiscais para não quebrar planilhas em uso).

| Coluna | Conteúdo | Alimenta |
|---|---|---|
| `tipo` | `fisico`, `variante`, `kit`, `combo`, `produzido`, `servico`, `complemento`… | `products.product_type` |
| `produto_pai` | SKU/uuid do pai | `products.parent_product_id` |
| `atributos` | `Tamanho=M\|Cor=Azul` | `product_attributes` + `_values` + `product_variant_values` |
| `componentes` | `CAF-001*1\|PAO-001*2` | `kit_items` |
| `ficha_tecnica` | `FAR-01*0.5\|OVO-01*3` | `product_recipe_items` |
| `grupos_complemento` | `Bordas\|Molhos` | `product_complement_groups` |
| `controla_estoque`, `visivel_cardapio` | `sim`/`nao` | `track_stock`, `visivel_cardapio` |

## 2.2 `complementos.csv` — uma linha por opção

`grupo;min_selecao;max_selecao;opcao_sku;preco_opcao;ordem` → `complement_groups` +
`complement_group_items`. Grupo tem `min_select`/`max_select` e uma lista de opções com
`price_override_cents`, o que não cabe numa coluna de produto.

## 2.3 `src/modules/commercial/productsImport.ts` (lógica pura)

Estender `IMPORT_COLUMNS` e `ParsedRow.data`; novos parsers `parseTipo`, `parseAttributes`,
`parseRefList` (`SKU*qtd`), `parseGroupList`. `buildPreview` ganha resolução de referências **contra
o próprio arquivo e contra o banco** (um kit pode citar um SKU criado na linha de baixo), com erros
para: referência inexistente, `variante` sem `produto_pai`, kit dentro de kit
(já proibido no CRUD), ciclo em ficha técnica, `min_selecao > max_selecao`.
Novo módulo irmão `complementsImport.ts` para o segundo arquivo. `templateCsv()` ganha um exemplo
de cada tipo; novo `complementsTemplateCsv()`.

## 2.4 `src/modules/commercial/productsImportRoutes.ts`

- `GET /products/export.csv`: **remover o filtro** de
  [:65](src/modules/commercial/productsImportRoutes.ts#L65). Montar as colunas de relação por
  subquery (`product_variant_values`+`product_attributes`, `kit_items`, `product_recipe_items`,
  `product_complement_groups`). Ordenar pais antes de filhos e componentes antes de kits — só por
  legibilidade; a importação não depende da ordem.
- Novas: `GET /products/complements-export.csv`, `GET /products/complements-template.csv`,
  `POST /products/complements/import/preview` e `/commit`.
- **Commit em duas passagens dentro da mesma transação** (o commit já é tudo-ou-nada,
  [:180](src/modules/commercial/productsImportRoutes.ts#L180)): passagem 1 faz o upsert de todos os
  produtos e monta o mapa `sku|uuid → id`; passagem 2 grava as relações. Assim a ordem das linhas
  no arquivo não importa. Relações são substituídas (DELETE + INSERT) **apenas** para os produtos
  presentes no arquivo.
- Manter o casamento por `uuid → codigo_barras → sku` e o `COALESCE` dos campos fiscais.
- Recusar linhas `variante`/`complemento` quando as capabilities `commercial.variantes` /
  `commercial.complementos` estiverem desligadas — senão entra dado que a UI não mostra.
- `track_stock` de variante: hoje o CRUD grava `0`
  ([productsRoutes.ts:166](src/modules/commercial/productsRoutes.ts#L166)) e o gerador de variantes
  grava `1` ([:668](src/modules/commercial/productsRoutes.ts#L668)). Definir um só valor e usar o
  mesmo no importador.

## 2.5 `src/modules/commercial/views/commercial-products.ejs`

O diálogo de importação ([:583](src/modules/commercial/views/commercial-products.ejs#L583),
[:1258](src/modules/commercial/views/commercial-products.ejs#L1258)) ganha a segunda etapa
(complementos) e os novos links de modelo/exportação junto ao botão atual
([:37](src/modules/commercial/views/commercial-products.ejs#L37)). O preview passa a mostrar o
`tipo` e as relações resolvidas por linha.

---

# Verificação

**Testes automatizados** (`npm test` — os arquivos `src/tests/fase*.ts`):

- `src/tests/fase5b.ts` cobre criar/converter/vencido/cancelar orçamento — atualizar para a nova
  assinatura e **acrescentar**: orçamento com produto de grupo de complemento → converter →
  assertar que `sale_items` preserva `line_group_uuid` e o preço cotado (não o de catálogo).
- `src/tests/fase5b.ts` + novo caso: orçamento criado com desconto por usuário com
  `store.sales.discount`, faturado por usuário sem — deve passar.
- `src/tests/products-import.ts` (parsers puros): atributos, `SKU*qtd`, referência inexistente,
  kit dentro de kit, ciclo em ficha técnica.
- `src/tests/products-import-api.ts`: **round-trip** — banco com variante + kit + ficha técnica +
  complemento → exportar os 2 CSVs → importar num banco limpo (`resetTestDb.ts`) → comparar
  produtos e relações.
- Rodar também `fase_variants.ts`, `fase_kits.ts`, `fase_complementos.ts`, `fase_producao.ts` e
  `fase_comandas.ts` (a mudança em `createSale` toca o caminho da comanda).

**Manual, no app** (`npm run dev`):

1. PDV → adicionar um produto com variação e um com complemento → F6 → salvar orçamento.
2. `/app/store/orcamentos` → conferir total e imprimir (complementos indentados).
3. "Editar" → volta ao PDV com o carrinho montado; **adicionar mais um produto**, mudar quantidade,
   salvar de novo.
4. Reabrir e finalizar com pagamento dividido (dinheiro + prazo parcelado) → conferir que a venda
   saiu com o **preço do orçamento**, não o de catálogo, e que o orçamento ficou `convertido`.
5. Cadastro de produtos → Exportar → abrir no Excel → conferir grade, kit, ficha e complemento →
   alterar um preço → reimportar → conferir que atualizou sem duplicar.
