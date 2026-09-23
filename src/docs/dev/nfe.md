# Módulo Importação de NF-e — Regras de Negócio

Importação de compras a partir do XML da NF-e (modelo 55, versão 4.00). Recurso opcional
(capability `nfe.import`), nasce desligado.

## Visão geral

Importar nota mexe em produto, fornecedor e estoque — o caminho é opt-in consciente. A
importação gera uma **compra recebida** no módulo `commercial` (o custo médio e o CMV do DRE
usam o fluxo normal) e mantém, aqui, o documento (`purchase_invoices`) e os vínculos
produto × fornecedor (`product_suppliers`).

O detalhamento de lotes, conversão de unidade e EAN de caixa está em `estoque.md`; aqui fica o
fluxo do módulo.

## Fluxo: preview e commit

- **Preview** (`/api/nfe/preview`): lê e classifica cada item contra o catálogo, **sem gravar
  nada**. É o que o lojista confere.
- **Commit** (`/api/nfe/commit`): revalida o XML (nunca confia no preview) e grava tudo em
  **uma transação**. Nada de produto/fornecedor/estoque/custo antes da confirmação.
- A mesma chave de acesso nunca entra duas vezes (índice único parcial).

## Validação do documento

Versão 4.00, modelo 55, chave de acesso com dígito verificador válido, CNPJ do emitente, itens
com descrição, quantidade, unidade e custo.

## Identificação do item (cascata)

1. **EAN/GTIN** — código principal do produto ou código secundário (`product_barcodes`).
2. **Código do fornecedor** (`cProd` em `product_suppliers`) já vinculado.
3. **Código interno + fornecedor** (`cProd` == SKU de produto já vinculado a este fornecedor).
4. **Nome** — apenas sugestão (exige confirmação).

Conflitos (EAN diferente, unidade diferente, NCM, custo, código ambíguo) são sinalizados em
`flags` e **nunca** resolvidos em silêncio.

## Conversão de unidade e EAN de caixa

- A nota pode faturar em caixa enquanto o produto é vendido em unidade. O fator vem do `uTrib`,
  da conversão já conhecida do fornecedor ou do produto; sem pista, a tela pede.
- O EAN de embalagem **nunca** vira `products.barcode` — vai para `product_barcodes`
  (`kind=caixa`) com o fator.

## Rastro (lote/validade)

Item com `<rastro>` vira **um item de compra por lote** (divide pelo `qLote`). Produto novo com
rastro nasce com `controla_lote=1`; produto vinculado respeita a configuração atual.

## Fornecedor

Criado a partir do CNPJ do XML quando ainda não existe, já com IE, endereço e contato. O
vínculo produto × fornecedor guarda o `cProd`, o último custo e a conversão para reuso.

## Reversão e edição

- **Reverter** (`nfeRevert`): desfaz estoque/custo/produtos criados e apaga (soft) a NF-e e o
  fornecedor criado por ela; libera a chave para reimportar.
- **Editar** (`nfeEdit`): reabre a conferência na MESMA NF-e. Reconcílio de estoque em dois
  modos: `restore` (exige saldo) ou `keep` (preserva vendas/ajustes). Quando há divergência e o
  modo não foi informado, o commit recusa e a tela pergunta.

## Sincronização

O módulo **não** declara tabelas de sync: `purchase_invoices` (documento fiscal local) e
`product_suppliers` (códigos por fornecedor) ficam nesta máquina. O que precisa circular — a
**compra**, o **estoque** e o **custo** — sincroniza pelo módulo `commercial`.

## Permissões

- `nfe.import.view` — ver a importação e o histórico.
- `nfe.import.run` — confirmar (grava produtos, compra e estoque).
- Capability `nfe.import` controla menu e telas.

## Arquivos-chave

- `src/modules/nfe/nfeParse.ts` — XML → domínio (inclui rastro).
- `src/modules/nfe/nfeResolve.ts` — classificação e conflitos.
- `src/modules/nfe/nfeImport.ts` — preview e commit.
- `src/modules/nfe/nfeEdit.ts` / `nfeRevert.ts` — edição e reversão.
