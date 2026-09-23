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

### Status do ticket

`pendente`, `preparo`, `pronto`, `entregue`, `cancelado`.

A UI/API avança por `pendente → preparo → pronto → entregue`. `cancelado` **não** é setado
pela cozinha: vem do cancelamento da venda/comanda.

O status do ticket é **derivado dos itens** (`recalcTicketStatus`): avançar um item, anular um
item de comanda ou remover um item pendente recalcula o ticket — evitando que ele fique preso
num status que não corresponde mais aos itens.

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
- `foodservice.kitchen.manage` — avançar status.
- `foodservice.routing.manage` — definir o que vai para a cozinha.

## Arquivos-chave

- `src/modules/foodservice/kitchen.ts` — tickets, status e integrações.
- `src/modules/foodservice/repositories/KitchenRepository.ts`.
