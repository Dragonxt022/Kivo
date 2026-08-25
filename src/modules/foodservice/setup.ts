import { registerService } from '../../core/services/registry';
import { cancelTicketsForSource, notifyOrder, voidComandaItem } from './kitchen';

export interface FoodserviceKitchenService {
  notifyOrder: typeof notifyOrder;
  /** Venda/comanda foi cancelada: tickets em aberto viram 'cancelado' no KDS. */
  cancelTicketsForSource: typeof cancelTicketsForSource;
  /** Item da comanda foi anulado: remove o item do ticket se ainda não foi pra produção. */
  voidComandaItem: typeof voidComandaItem;
}

export default function setup(): void {
  registerService('foodservice.kitchen', { notifyOrder, cancelTicketsForSource, voidComandaItem } satisfies FoodserviceKitchenService);
}
