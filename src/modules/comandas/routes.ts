import { Router } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import { requireCapability } from '../../core/capabilities/middleware';
import { comandasController } from './controllers/ComandasController';

const router = Router();

router.get('/tables', requireCapability('comandas.mesas'), requirePermission('comandas.tables.manage'), comandasController.listTables);
router.get('/tables/status', requireCapability('comandas.mesas'), requirePermission('comandas.view'), comandasController.listTableStatus);
router.post('/tables', requireCapability('comandas.mesas'), requirePermission('comandas.tables.manage'), comandasController.createTable);
router.put('/tables/:id', requireCapability('comandas.mesas'), requirePermission('comandas.tables.manage'), comandasController.updateTable);
router.delete('/tables/:id', requireCapability('comandas.mesas'), requirePermission('comandas.tables.manage'), comandasController.deleteTable);

router.get('/comandas', requireCapability('comandas.mesas'), requirePermission('comandas.view'), comandasController.listComandas);
router.get('/comandas/:id', requireCapability('comandas.mesas'), requirePermission('comandas.view'), comandasController.getComanda);
router.post('/comandas', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), comandasController.openComandaAction);
router.post('/comandas/:id/items', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), comandasController.addItemAction);
router.delete('/comandas/:id/items/:itemId', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), comandasController.voidItemAction);
router.post('/comandas/:id/transfer', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), comandasController.transferAction);
router.post('/comandas/:id/split', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), comandasController.splitAction);
router.post('/comandas/:id/merge', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), comandasController.mergeAction);
router.post('/comandas/:id/close', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), comandasController.closeComandaAction);
router.post('/comandas/:id/cancel', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), comandasController.cancelComandaAction);

export default router;
