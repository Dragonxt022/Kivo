# Módulo Comandas & Mesas — Regras de Negócio

Pré-venda em mesas/balcão que vira uma venda normal ao fechar. Recurso opcional
(capability `comandas.mesas`); o rótulo do menu pode ser "Mesas" ou "Balcão".

## Visão geral

Uma **mesa** (`store_tables`) tem status `livre` ou `ocupada`. Uma **comanda** é a conta
aberta de uma mesa (ou avulsa) com itens lançados antes do pagamento. Ao fechar, a comanda
vira uma **venda** normal (`createSale`), herdando o cliente e reaproveitando o preço já
resolvido no lançamento.

## Ciclo de vida

### Abrir

`openComanda`: a mesa precisa estar `livre` (senão "Mesa já está ocupada"). A criação da
comanda e a ocupação da mesa acontecem na **mesma transação**. Comanda nasce `aberta`.

### Lançar itens

`addItem`: a comanda precisa estar `aberta`. O preço unitário é resolvido agora
(`pricing.resolvePrice`, considerando a lista do cliente) e congelado no item. Itens podem
ser agrupados por `line_group_uuid` (principal + complementos como linhas irmãs).

`updateItemQty` e `updateItemNotes` ajustam item enquanto a comanda está aberta.

### Enviar para a cozinha

`sendToKitchen` cria o ticket de produção (só os produtos roteados, ver `foodservice.md`) e
devolve quantos itens foram e o tempo estimado. Itens já enviados ficam vinculados ao ticket
por `comanda_item_id`.

### Anular item

`voidItem` remove o item; se ele tinha ido para a cozinha e o item de produção ainda está
`pendente`, ele é removido de lá e o ticket é reavaliado (cancelado se ficar vazio).

### Pronta para pagamento

`setReadyForPayment` marca a comanda como pronta — a grade de mesas destaca e o caixa pode
fechá-la.

### Transferir, dividir e unir

- `transfer`: move a comanda para outra mesa `livre`.
- `split`: move os itens selecionados para uma **nova** comanda (divide a conta).
- `merge`: move todos os itens da comanda origem para a destino (as duas precisam estar
  `aberta`).

### Fechar

`closeComanda` monta o `SaleInput` a partir dos itens e chama `createSale` com
`skipKitchenNotify` — os itens **já** foram para a cozinha no lançamento; notificar de novo
duplicaria o pedido no KDS. Ao fechar: grava `sale_id`, marca a comanda `fechada` e libera a
mesa. Pagamento, desconto e cliente seguem as regras de `vendas.md`.

### Cancelar

`cancelComanda` só para comanda `aberta`; libera a mesa e cancela os tickets de cozinha.

## Sincronização

`store_tables`, `comandas` e `comanda_items` sincronizam (sem `opened_by`/`added_by`, que
referenciam usuários).

## Permissões

- `comandas.view` — ver mesas e comandas.
- `comandas.manage` — abrir, lançar, transferir, dividir, unir e fechar.
- `comandas.tables.manage` — cadastrar/editar mesas.

## Arquivos-chave

- `src/modules/comandas/comandas.ts` — todo o ciclo de vida.
- `src/modules/comandas/repositories/ComandaRepository.ts` e `StoreTableRepository.ts`.
