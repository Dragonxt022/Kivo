# Módulo Comercial (cadastros) — Regras de Negócio

Clientes, fornecedores, categorias, listas de preço e empresas conveniadas. O **estoque**
(produtos, movimentações, lotes, compras) está em `estoque.md`.

## Visão geral

A maioria dos cadastros usa uma **fábrica de CRUD** (`crud.ts`): cada entidade declara seus
campos, obrigatórios, busca, filtros e regras extras. Isso mantém listagem, paginação,
exportação e auditoria consistentes entre as entidades.

## Clientes

- Campos: nome, documento (CPF/CNPJ), e-mail, telefone, endereço, CEP, aniversário, etiquetas
  (`tags`), lista de preço, empresa conveniada e observações.
- **Crédito de loja** (`store_credit_cents`) e **pontos** (`loyalty_points`) são somente
  leitura no cadastro — mudam por movimentação (concessão/resgate/estorno).
- **Segmentação** na listagem: devedores (recebível em aberto), aniversariantes do mês, sem
  compra há N dias e por etiqueta.
- **Ficha do cliente**: resumo agregado (compras, recebíveis abertos/vencidos, histórico
  mensal), extrato de crédito e de pontos, e exportação CSV.

## Fornecedores

- Dados cadastrais e fiscais/contato que a NF-e traz no emitente (IE, endereço, contato).
- `default_markup_bps`: markup padrão de venda sobre o custo para as compras deste fornecedor
  (usado na importação de NF-e; 0 = usa o global).

## Categorias

- Hierárquicas (`parent_id`) e com imagem.
- Excluir uma categoria **migra os produtos** para outra categoria (ou para "sem categoria")
  antes de removê-la — não deixa produto órfão.

## Listas de preço

- Uma lista pode ser **padrão** (`is_default`); só uma por vez.
- Itens têm faixas por quantidade (`min_qty`) com preço unitário.
- Um cliente pode ter uma **lista vinculada**.
- **Ordem de resolução de preço** (`resolvePrice`): lista do cliente → lista padrão →
  catálogo (`products.price_cents`). É a mesma ordem usada no PDV, no orçamento e na comanda.

## Empresas conveniadas

Cadastro das empresas de convênio (usadas pelo financeiro para cobrança/fatura). Ver
`financeiro.md`.

## Produtos avançados (recursos opcionais)

Com as capabilities ligadas, o cadastro de produto suporta:

- **Variantes** — atributos e valores; o pai agrupa, cada filha é vendável.
- **Complementos/opcionais** — grupos com seleção mínima/máxima, usados no PDV.
- **Kits/combos** — componentes fixos vendidos como um item.
- **Produção** — ficha técnica com consumo automático de insumos na venda.

## Sincronização

Sincronizam: `categories`, `products` (sem `stock_qty`/`image_url`), `product_attributes`,
`product_variant_values`, `product_barcodes`, `customers` (sem crédito/pontos, que são
ledgers), `suppliers`, `agreement_companies`, `price_lists`/`price_list_items`, complementos,
`kit_items` e `product_recipe_items`.

## Permissões

`commercial.customers.*`, `commercial.suppliers.*`, `commercial.products.*`,
`commercial.pricelists.view/manage`, `commercial.agreements.*`, além das permissões de
gerenciar variantes/complementos/kits/ficha técnica.

## Arquivos-chave

- `src/modules/commercial/crud.ts` — fábrica de CRUD.
- `src/modules/commercial/routes.ts` — rotas de cadastros.
- `src/modules/commercial/pricing.ts` — resolução de preço.
- `src/modules/commercial/repositories/PriceListRepository.ts`.
