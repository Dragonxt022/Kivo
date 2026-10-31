import { registerService } from '../../core/services/registry';
import { adoptSaleDraft, cancelTicketsForSource, notifyOrder, readyTicketCountByComanda, syncItemNotes, voidComandaItem } from './kitchen';
import { kitchenRoutingRepository, kitchenTicketItemRepository } from './repositories/KitchenRepository';

export interface FoodserviceKitchenService {
  notifyOrder: typeof notifyOrder;
  /** Venda/comanda foi cancelada: tickets em aberto viram 'cancelado' no KDS. */
  cancelTicketsForSource: typeof cancelTicketsForSource;
  /** Tickets enviados antes de a venda existir passam a apontar para a venda final. */
  adoptSaleDraft: typeof adoptSaleDraft;
  /** Item da comanda foi anulado: remove o item do ticket se ainda não foi pra produção. */
  voidComandaItem: typeof voidComandaItem;
  /** IDs de itens de comanda que JÁ têm item de cozinha ativo (controle do "Enviar p/ cozinha"). */
  findSentComandaItemIds: (comandaItemIds: number[]) => number[];
  /** Quais produtos estão roteados: vitrines marcam "Cozinha" antes de lançar o item. */
  findRoutedProductIds: (productIds: number[]) => number[];
  /** Status de produção por item de comanda (sem tickets cancelados). */
  findStatusByComandaItemIds: (comandaItemIds: number[]) => { comandaItemId: number; status: string }[];
  /** Observação do item da comanda mudou: espelha no ticket enquanto pendente. */
  syncItemNotes: typeof syncItemNotes;
  /** Tickets 'pronto' por comanda — a grade de mesas sinaliza "pedido pronto" na mesa. */
  readyTicketCountByComanda: typeof readyTicketCountByComanda;
}

export default function setup(): void {
  registerService('foodservice.kitchen', {
    notifyOrder, cancelTicketsForSource, adoptSaleDraft, voidComandaItem, syncItemNotes, readyTicketCountByComanda,
    findSentComandaItemIds: (ids) => kitchenTicketItemRepository.findSentComandaItemIds(ids),
    findRoutedProductIds: (ids) => kitchenRoutingRepository.findRoutedProductIds(ids),
    findStatusByComandaItemIds: (ids) => kitchenTicketItemRepository
      .findStatusByComandaItemIds(ids)
      .map((r) => ({ comandaItemId: r.comanda_item_id, status: r.status })),
  } satisfies FoodserviceKitchenService);
}
