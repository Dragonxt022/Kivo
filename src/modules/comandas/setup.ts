import { registerService } from '../../core/services/registry';
import { confirmQrOrders, receiveQrOrder, rejectQrOrders, setItemTakeaway } from './qrOrder';

/**
 * Serviço do módulo comandas usado pela fila de comandos do Cloud (core/sync/commands).
 * O core não importa o módulo diretamente: ele pede `comandas.qr` no registry.
 */
export default function setup(): void {
  registerService('comandas.qr', {
    receiveQrOrder,
    confirmQrOrders,
    rejectQrOrders,
    setItemTakeaway,
  });
}
