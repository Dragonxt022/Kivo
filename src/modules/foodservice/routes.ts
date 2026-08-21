import { Router } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import { requireCapability } from '../../core/capabilities/middleware';
import { validateBody } from '../../shared/validateBody';
import {
  createKitchenRoutingSchema,
  updateKitchenRoutingSchema,
  kitchenStatusSchema,
} from '../../shared/schemas';
import { foodserviceController } from './controllers/FoodserviceController';

const router = Router();

router.get('/kitchen-routing', requireCapability('foodservice.cozinha'), requirePermission('foodservice.routing.manage'), foodserviceController.listKitchenRouting);
router.post('/kitchen-routing', requireCapability('foodservice.cozinha'), requirePermission('foodservice.routing.manage'), validateBody(createKitchenRoutingSchema), foodserviceController.createKitchenRouting);
router.put('/kitchen-routing/:id', requireCapability('foodservice.cozinha'), requirePermission('foodservice.routing.manage'), validateBody(updateKitchenRoutingSchema), foodserviceController.updateKitchenRouting);
router.delete('/kitchen-routing/:id', requireCapability('foodservice.cozinha'), requirePermission('foodservice.routing.manage'), foodserviceController.deleteKitchenRouting);

router.get('/kitchen/tickets', requireCapability('foodservice.cozinha'), requirePermission('foodservice.kitchen.view'), foodserviceController.listKitchenTickets);
router.put('/kitchen/tickets/:ticketId/items/:itemId/status', requireCapability('foodservice.cozinha'), requirePermission('foodservice.kitchen.manage'), validateBody(kitchenStatusSchema), foodserviceController.advanceItemStatusAction);
router.put('/kitchen/tickets/:id/status', requireCapability('foodservice.cozinha'), requirePermission('foodservice.kitchen.manage'), validateBody(kitchenStatusSchema), foodserviceController.advanceTicketStatusAction);

export default router;
