import { Router } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import { requireCapability } from '../../core/capabilities/middleware';
import { foodserviceController } from './controllers/FoodserviceController';

const router = Router();

router.get('/kitchen-routing', requireCapability('foodservice.cozinha'), requirePermission('foodservice.routing.manage'), foodserviceController.listKitchenRouting);
router.post('/kitchen-routing', requireCapability('foodservice.cozinha'), requirePermission('foodservice.routing.manage'), foodserviceController.createKitchenRouting);
router.put('/kitchen-routing/:id', requireCapability('foodservice.cozinha'), requirePermission('foodservice.routing.manage'), foodserviceController.updateKitchenRouting);
router.delete('/kitchen-routing/:id', requireCapability('foodservice.cozinha'), requirePermission('foodservice.routing.manage'), foodserviceController.deleteKitchenRouting);

router.get('/kitchen/tickets', requireCapability('foodservice.cozinha'), requirePermission('foodservice.kitchen.view'), foodserviceController.listKitchenTickets);
router.put('/kitchen/tickets/:ticketId/items/:itemId/status', requireCapability('foodservice.cozinha'), requirePermission('foodservice.kitchen.manage'), foodserviceController.advanceItemStatusAction);
router.put('/kitchen/tickets/:id/status', requireCapability('foodservice.cozinha'), requirePermission('foodservice.kitchen.manage'), foodserviceController.advanceTicketStatusAction);

export default router;
