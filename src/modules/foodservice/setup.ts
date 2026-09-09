import { registerService } from '../../core/services/registry';
import { cancelTicketsForSource, notifyOrder, readyTicketCountByComanda, syncItemNotes, voidComandaItem } from './kitchen';
import { kitchenTicketItemRepository } from './repositories/KitchenRepository';

export interface FoodserviceKitchenService {
  notifyOrder: typeof notifyOrder;
  /** Venda/comanda foi cancelada: tickets em aberto viram 'cancelado' no KDS. */
  cancelTicketsForSource: typeof cancelTicketsForSource;
  /** Item da comanda foi anulado: remove o item do ticket se ainda não foi pra produção. */
  voidComandaItem: typeof voidComandaItem;
  /** IDs de itens de comanda que JÁ têm item de cozinha ativo (controle do "Enviar p/ cozinha"). */
  findSentComandaItemIds: (comandaItemIds: number[]) => number[];
  /** Observação do item da comanda mudou: espelha no ticket enquanto pendente. */
  syncItemNotes: typeof syncItemNotes;
  /** Tickets 'pronto' por comanda — a grade de mesas sinaliza "pedido pronto" na mesa. */
  readyTicketCountByComanda: typeof readyTicketCountByComanda;
}

export default function setup(): void {
  registerService('foodservice.kitchen', {
    notifyOrder, cancelTicketsForSource, voidComandaItem, syncItemNotes, readyTicketCountByComanda,
    findSentComandaItemIds: (ids) => kitchenTicketItemRepository.findSentComandaItemIds(ids),
  } satisfies FoodserviceKitchenService);
}
