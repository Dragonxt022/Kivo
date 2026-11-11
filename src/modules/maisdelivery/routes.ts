import { Router } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import { validateBody } from '../../shared/validateBody';
import {
  maisDeliveryOrderIdsSchema,
  maisDeliveryOrderStatusSchema,
  maisDeliverySettingsSchema,
} from '../../shared/schemas';
import { maisDeliveryController } from './controllers/MaisDeliveryController';

const router = Router();

// Configuração e teste de conexão.
router.get(
  '/settings',
  requirePermission('maisdelivery.settings.manage'),
  maisDeliveryController.getSettings,
);
router.put(
  '/settings',
  requirePermission('maisdelivery.settings.manage'),
  validateBody(maisDeliverySettingsSchema),
  maisDeliveryController.saveSettings,
);
router.post(
  '/test',
  requirePermission('maisdelivery.settings.manage'),
  maisDeliveryController.testConnection,
);

// Pedidos. A leitura e a troca de situação têm permissões separadas: consultar não
// implica poder mexer no pedido do cliente no marketplace.
router.get(
  '/orders',
  requirePermission('maisdelivery.orders.view'),
  maisDeliveryController.listOrders,
);
router.post(
  '/orders/details',
  requirePermission('maisdelivery.orders.view'),
  validateBody(maisDeliveryOrderIdsSchema),
  maisDeliveryController.getOrdersDetails,
);
router.get(
  '/orders/:id',
  requirePermission('maisdelivery.orders.view'),
  maisDeliveryController.getOrder,
);
router.post(
  '/orders/:id/status',
  requirePermission('maisdelivery.orders.status'),
  validateBody(maisDeliveryOrderStatusSchema),
  maisDeliveryController.updateStatus,
);
// Enviar para a cozinha cria produção no Kuruk E muda a situação no marketplace —
// por isso usa a mesma permissão da troca de situação, não apenas a de leitura.
router.post(
  '/orders/:id/enviar-cozinha',
  requirePermission('maisdelivery.orders.status'),
  maisDeliveryController.sendToKitchen,
);
// Pedido fictício de teste (só com sandbox ligado): ticket real na cozinha para
// exercitar a fila sem criar nada no marketplace.
router.post(
  '/test-order',
  requirePermission('maisdelivery.orders.status'),
  maisDeliveryController.createTestOrder,
);

// Auxiliares para filtros e para montar o seletor de situação.
router.get(
  '/statuses',
  requirePermission('maisdelivery.orders.view'),
  maisDeliveryController.listStatuses,
);
router.get(
  '/payment-methods',
  requirePermission('maisdelivery.orders.view'),
  maisDeliveryController.listPaymentMethods,
);

export default router;
