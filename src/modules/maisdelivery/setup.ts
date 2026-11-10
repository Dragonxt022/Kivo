import { registerService } from '../../core/services/registry';
import { onTicketStatusChange, sendOrderToKitchen } from './kitchenBridge';

/**
 * Serviço consumido pelo foodservice (via registry, sempre que um ticket de
 * delivery muda de etapa no KDS) e pelo core (nada aqui é chamado por rotas do
 * foodservice — o módulo de cozinha jamais importa o de integração).
 */
export interface MaisDeliveryKitchenService {
  /** Cozinha marcou etapa no pedido do marketplace: espelha a situação lá fora. */
  onTicketStatusChange: typeof onTicketStatusChange;
  /** Envia o pedido do marketplace para a fila da cozinha + atualiza a situação. */
  sendOrderToKitchen: typeof sendOrderToKitchen;
}

export default function setup(): void {
  registerService('maisdelivery.kitchen', {
    onTicketStatusChange,
    sendOrderToKitchen,
  } satisfies MaisDeliveryKitchenService);
}
