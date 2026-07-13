import { Router } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import { validateBody } from '../../shared/validateBody';
import { stockMoveSchema } from '../../shared/schemas';
import { moveStock, listMovements, type MovementType } from './stock';

const router = Router();

router.get('/movements', requirePermission('commercial.stock.view'), (req, res) => {
  const productId = req.query.productId ? Number(req.query.productId) : undefined;
  res.json(listMovements(productId, Math.min(Number(req.query.limit ?? 100), 500)));
});

router.use('/move', requirePermission('commercial.stock.move'), validateBody(stockMoveSchema), (req, res) => {
  const { productId, type, qty, reason } = req.body;
  const result = moveStock(req, productId, type as MovementType, qty, reason);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

export default router;
