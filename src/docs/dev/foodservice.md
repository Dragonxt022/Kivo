# Módulo Food Service — Regras de Negócio

Painel de cozinha (KDS) e roteamento de produtos para produção. Recurso opcional
(capability `foodservice.cozinha`).

## Visão geral

Nem todo produto vendido vira pedido de cozinha. O **roteamento** define quais produtos
geram produção; ao vender ou lançar numa comanda, esses itens viram um **ticket** com itens
por estação, que a cozinha acompanha no KDS.

## Roteamento

`kitchen_routing` mapeia produto → estação (`station`) e tempo estimado (`estimated_minutes`).
A tela "Enviar para a cozinha" (`/app/foodservice/roteamento`) é onde o lojista escolhe o que
vai para produção — sem ela o painel fica vazio.

## Tickets e itens

- `notifyOrder` cria o ticket com os itens **roteados** (produtos fora do roteamento são
  ignorados em silêncio — é isso que permite mandar "a comanda inteira" sem saber o que é da
  cozinha). Devolve quantos itens geraram produção e o maior tempo estimado.
- Cada item guarda estação, tempo estimado e status.

### Tipo de atendimento
`kitchen_tickets.service_type` guarda `local` (consumir no local) ou `entrega`. O KDS mostra
prato/garfo para local e motinha para entrega. A comanda de mesa envia sempre `local`; o PDV
tem o seletor "Consumir aqui / Entrega" ao lado do carrinho (só aparece quando há item de
cozinha) e manda o valor no `POST /api/store/kitchen/send`. Tickets antigos ficam `local` por
default da migration `0088_kitchen_ticket_service_type`.

### Status do ticket

`pendente`, `preparo`, `pronto`, `entregue`, `cancelado`.

A UI/API avança por `pendente → preparo → pronto → entregue` e **também volta uma etapa**
(botão ⬅ no item e no pedido). Voltar existe porque a cozinha erra toque na correria: sem
isso, a única correção era mexer no banco. Ao voltar o ticket, só os itens **à frente** do
alvo descem; item que já estava atrasado não é tocado. `cancelado` vem do cancelamento da
venda/comanda ou do botão **Cancelar pedido** da cozinha (`cancelTicket`), disponível para
tickets `pendente`/`preparo`/`pronto`. Pedido já entregue (ou com item entregue) não é
cancelado por ali: o que saiu para a mesa não pode sumir da conta. Quando o ticket veio de
uma comanda, os itens vinculados são anulados junto (o principal leva os complementos do
grupo); quando veio de uma venda, só o ticket da cozinha é cancelado e a venda não muda.

O status do ticket é **derivado dos itens** (`recalcTicketStatus`): avançar um item, anular um
item de comanda ou remover um item pendente recalcula o ticket — evitando que ele fique preso
num status que não corresponde mais aos itens. O recalc **não** rebaixa `entregue` por
acidente (avançar um item esquecido depois da entrega não reabre o pedido), mas uma volta
explícita de item ou de ticket manda reavaliar (`allowDowngrade`). Pedidos entregues ficam na
coluna "Entregues" — oculta por padrão, é de lá que se desfaz a entrega.

### Confirmação de visualização (alarme)

`kitchen_tickets.acknowledged_at` guarda quando a cozinha confirmou que viu o pedido.
`NULL` = ainda não confirmado. O KDS usa isso para o **alarme até visualizar**: com a
opção ligada, o som do pedido novo fica em loop até o último pedido sem confirmação ser
visto. Um único loop cobre todos os pedidos abertos — dois pedidos que chegam juntos não
disparam dois áudios.

- `POST /api/foodservice/kitchen/tickets/:id/ack` confirma a visualização (idempotente,
  permissão `foodservice.kitchen.view`). A marca fica no servidor, então vale para todos
  os painéis e sobrevive a um recarregamento da página.
- Avançar item ou ticket também marca como visto (`acknowledge` em `advanceItemStatus` /
  `advanceTicketStatus`): quem já começou a preparar não pode continuar ouvindo o alarme.
- A migration `0090_kitchen_ticket_acknowledged` marca os tickets já existentes como
  vistos, para a atualização não fazer o alarme tocar para pedidos antigos.

## Integrações

- Venda (`createSale`) notifica a cozinha após gravar, exceto no fechamento de comanda
  (`skipKitchenNotify`), que já enviou os itens um a um.
- Cancelar venda/comanda chama `cancelTicketsForSource`, marcando os tickets abertos como
  `cancelado` (best-effort) — senão o KDS ficaria com pedido eterno de algo que não existe.
- Anular um item da comanda remove o item de produção correspondente se ainda `pendente`
  (`voidComandaItem`); alterar a observação sincroniza no item do ticket (`syncItemNotes`).

## Sincronização

`kitchen_routing` e `kitchen_tickets` (com `kitchen_ticket_items`) sincronizam.

## Permissões

- `foodservice.kitchen.view` — ver o painel.
- `foodservice.kitchen.manage` — avançar status e cancelar pedido.
- `foodservice.routing.manage` — definir o que vai para a cozinha.

## Arquivos-chave

- `src/modules/foodservice/kitchen.ts` — tickets, status e integrações.
- `src/modules/foodservice/repositories/KitchenRepository.ts`.
