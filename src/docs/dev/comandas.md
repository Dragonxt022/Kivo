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

Principal e complementos formam **um pedido só** (`line_group_uuid`). Anular o principal
anula o grupo inteiro — senão os adicionais ficariam soltos na comanda e seriam cobrados
sozinhos. Anular um complemento remove só aquela linha. A migration
`0095_comanda_orphan_complements` limpa os complementos órfãos que já existiam e desfaz o
aviso de "pronta para pagamento" de comandas cujo total mudou.

### Pronta para pagamento

`setReadyForPayment` marca a comanda como pronta — a grade de mesas destaca e o caixa pode
fechá-la.

### Transferir, dividir e unir

- `transfer`: move a comanda para outra mesa `livre`. A tela lista todas as mesas, mas as
  ocupadas ficam desabilitadas (e o servidor também recusa). Comanda sem mesa usa a mesma
  operação como **Vincular mesa**.
- `split`: move os itens selecionados para uma **nova** comanda (divide a conta). A seleção
  precisa levar o **grupo completo** (`line_group_uuid`): principal + complementos. Os
  tickets da cozinha acompanham os itens movidos; se um ticket tiver itens das duas
  comandas, ele é separado. A comanda nova nasce sem mesa e aparece em **Comandas sem
  mesa**; a origem vazia é cancelada e a mesa liberada.
- `merge`: move todos os itens da comanda origem para a destino (as duas precisam estar
  `aberta`).

### Comandas sem mesa

Comandas abertas sem `table_id` (normalmente criadas por uma divisão) aparecem na lista
**Comandas sem mesa**, abaixo da grade de mesas. O atalho **Mesa** abre o detalhe com o
seletor de mesa; ao vincular, a mesa é ocupada e a comanda passa a aparecer na grade. A
lista também expõe a contagem de rodadas do QR pendentes.

### Fechar

`closeComanda` monta o `SaleInput` a partir dos itens e chama `createSale` com
`skipKitchenNotify` — os itens **já** foram para a cozinha no lançamento; notificar de novo
duplicaria o pedido no KDS. Ao fechar: grava `sale_id`, marca a comanda `fechada` e libera a
mesa. Pagamento, desconto e cliente seguem as regras de `vendas.md`.

### Cancelar

`cancelComanda` só para comanda `aberta`; libera a mesa e cancela os tickets de cozinha.

## Pedido pelo QR da mesa

O QR impresso é fixo (o token fica em `store_tables.qr_token`); para não depender de trocar
o código colado na mesa, a presença é confirmada pelo atendente:

- por padrão (`pedido_qr.exigir_mesa_aberta = 1`), o pedido só entra se a mesa já tiver uma
  comanda aberta pelo atendente. Quem está em casa com o link salvo não consegue abrir uma
  mesa livre;
- o garçom continua confirmando cada rodada antes de ela ir para a cozinha;
- o Cloud limita a 8 pedidos por 10 minutos por token+IP e a 2 rodadas pendentes por mesa,
  para um link vazado não inundar a tela do atendente;
- desligar a opção em **Configurações → Mesas e balcão** volta ao fluxo antigo (o QR abre a
  mesa sozinho).

O QR só é gerado quando a capability `comandas.pedido_qr` está ativa, o plano é Diamante ou
Trial, a licença está válida e o Cloud está configurado. O Cloud guarda só o SHA-256 do
token em `menu_table_tokens`; o app guarda o token em claro para reexibir o mesmo QR.

- `GET /api/comandas/tables/:id/qr` reexibe o QR existente;
- `POST /api/comandas/tables/:id/qr` cria (ou rotaciona, com `{ rotate: true }`) e invalida
  o QR impresso anterior;
- `DELETE /api/comandas/tables/:id/qr` desativa o token no Cloud e limpa o local.

O pedido aplicado fica em `qr_orders` com status `pendente` e os itens com
`origem = 'cliente_qr'`. A tela de Mesas mostra o banner de confirmação e o selo na mesa;
`POST /api/comandas/comandas/:id/qr-orders/confirm` envia os itens à cozinha e
`.../reject` grava o motivo, que o cliente vê no celular. O detalhamento do cardápio
público, das validações e da recompra está em `cardapio-online.md`.

Limitação assumida: se a mesa estiver ocupada, alguém de fora com o link ainda consegue
enviar até 2 rodadas; elas aparecem para o garçom, que recusa. Para abuso persistente, o
caminho é revogar/rotacionar o QR daquela mesa (exige reimprimir o código).

## Sincronização

`store_tables`, `comandas` e `comanda_items` sincronizam (sem `opened_by`/`added_by`, que
referenciam usuários).

## Permissões

- `comandas.view` — ver mesas e comandas.
- `comandas.manage` — abrir, lançar, transferir, dividir, unir e fechar; confirmar/recusar
  pedidos do QR.
- `comandas.tables.manage` — cadastrar/editar mesas e gerar/rotacionar/desativar o QR.
- capability `comandas.pedido_qr` — liga o pedido pela mesa via QR (plano Diamante/Trial).

## Arquivos-chave

- `src/modules/comandas/comandas.ts` — todo o ciclo de vida.
- `src/modules/comandas/qr.ts` — token, geração, rotação e revogação do QR.
- `src/modules/comandas/qrOrder.ts` — aplicação, confirmação e recusa do pedido.
- `src/modules/comandas/repositories/ComandaRepository.ts` e `StoreTableRepository.ts`.
