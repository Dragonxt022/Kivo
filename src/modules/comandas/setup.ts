import { registerService } from '../../core/services/registry';
import { confirmQrOrders, receiveQrOrder, rejectQrOrders, setItemTakeaway } from './qrOrder';
import { voidItem, voidItemsForKitchen } from './comandas';

/**
 * Serviço do módulo comandas usado pela fila de comandos do Cloud (core/sync/commands) e
 * pela cozinha (foodservice). O core/outro módulo não importa o módulo diretamente: pede
 * `comandas.qr` ou `comandas.items` no registry.
 */
export interface ComandasItemsService {
  /** Anula um item (o principal leva os complementos do grupo junto). */
  voidItem: typeof voidItem;
  /** Cozinha cancelou o ticket: anula os itens da comanda ligados a ele. */
  voidItemsForKitchen: typeof voidItemsForKitchen;
}

export default function setup(): void {
  registerService('comandas.qr', {
    receiveQrOrder,
    confirmQrOrders,
    rejectQrOrders,
    setItemTakeaway,
  });
  registerService('comandas.items', {
    voidItem,
    voidItemsForKitchen,
  } satisfies ComandasItemsService);
}
