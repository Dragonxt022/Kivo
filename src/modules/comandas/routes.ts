import { Router } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import { requireCapability } from '../../core/capabilities/middleware';
import { validateBody } from '../../shared/validateBody';
import {
  createTableSchema,
  updateTableSchema,
  openComandaSchema,
  addComandaItemSchema,
  transferComandaSchema,
  splitComandaSchema,
  mergeComandaSchema,
  readyForPaymentSchema,
  closeComandaSchema,
} from '../../shared/schemas';
import { comandasController } from './controllers/ComandasController';

const router = Router();

router.get('/tables', requireCapability('comandas.mesas'), requirePermission('comandas.tables.manage'), comandasController.listTables);
router.get('/tables/status', requireCapability('comandas.mesas'), requirePermission('comandas.view'), comandasController.listTableStatus);
router.post('/tables', requireCapability('comandas.mesas'), requirePermission('comandas.tables.manage'), validateBody(createTableSchema), comandasController.createTable);
router.put('/tables/:id', requireCapability('comandas.mesas'), requirePermission('comandas.tables.manage'), validateBody(updateTableSchema), comandasController.updateTable);
router.delete('/tables/:id', requireCapability('comandas.mesas'), requirePermission('comandas.tables.manage'), comandasController.deleteTable);

router.get('/comandas', requireCapability('comandas.mesas'), requirePermission('comandas.view'), comandasController.listComandas);
router.get('/comandas/:id', requireCapability('comandas.mesas'), requirePermission('comandas.view'), comandasController.getComanda);
router.post('/comandas', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), validateBody(openComandaSchema), comandasController.openComandaAction);
router.post('/comandas/:id/items', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), validateBody(addComandaItemSchema), comandasController.addItemAction);
router.delete('/comandas/:id/items/:itemId', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), comandasController.voidItemAction);
router.post('/comandas/:id/transfer', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), validateBody(transferComandaSchema), comandasController.transferAction);
router.post('/comandas/:id/split', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), validateBody(splitComandaSchema), comandasController.splitAction);
router.post('/comandas/:id/merge', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), validateBody(mergeComandaSchema), comandasController.mergeAction);
// `comandas.manage` e não uma permissão de venda: chamar o caixa é trabalho de garçom.
router.post('/comandas/:id/ready-for-payment', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), validateBody(readyForPaymentSchema), comandasController.readyForPaymentAction);
router.post('/comandas/:id/close', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), validateBody(closeComandaSchema), comandasController.closeComandaAction);
router.post('/comandas/:id/cancel', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), comandasController.cancelComandaAction);

export default router;
