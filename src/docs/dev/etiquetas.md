# Módulo Gerador de Etiquetas — Regras de Negócio

Etiquetas de produto (código de barras + preço) em folha A4, com modelos no padrão Pimaco.
Recurso opcional (capability `labels.generator`), nasce desligado.

## Visão geral

Lê o catálogo (`commercial`) e monta as etiquetas; a view de impressão só posiciona o que sai
do serviço — **nenhuma regra de negócio no EJS**.

## Código de barras

- Se o produto já tem `barcode`, usa ele.
- Se não tem, gera um **EAN interno** (`generateInternalBarcode`) e **grava no cadastro** do
  produto, para a etiqueta ser escaneável no PDV. O cadastro só é preenchido se ainda estiver
  vazio.
- O código distinto é renderizado **uma vez** por folha (cache) — repetir o mesmo produto não
  re-renderiza o código.

## Montagem e paginação

- `buildLabels` expande os itens em etiquetas (uma por cópia).
- `positionFor` calcula a posição (mm) de cada etiqueta na grade (colunas × linhas, margens e
  espaçamentos da folha).
- `paginate` divide em páginas de `cols × rows` e aplica as posições.
- Campos configuráveis: nome, preço, SKU e nome da empresa.

## Modelos de folha

Folhas padrão (Pimaco) em `presets.ts` e folhas personalizadas (`LabelSheetRepository`).
Gerenciar modelos exige `labels.sheets.manage`.

## Histórico

As folhas geradas ficam em um histórico **local** e **não sincronizam**: `sheet_id` e os ids
de produto do payload são locais — em outra máquina apontariam para registros diferentes e a
reimpressão sairia errada. (Para sincronizar um dia, seria preciso guardar UUIDs.)

## Permissões

- `labels.generate` — gerar e imprimir (e ver o histórico).
- `labels.sheets.manage` — criar/editar modelos de folha.

## Arquivos-chave

- `src/modules/labels/labels.ts` — busca, montagem, código e paginação.
- `src/modules/labels/presets.ts` — folhas Pimaco.
- `src/modules/labels/services/barcode.ts` — render do código de barras/QR.
