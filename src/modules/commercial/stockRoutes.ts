import { Router } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import { validateBody } from '../../shared/validateBody';
import { stockMoveSchema } from '../../shared/schemas';
import { moveStock, listMovements, listLots, listExpiringLots, writeOffLot, type MovementType } from './stock';

const router = Router();

router.get('/movements', requirePermission('commercial.stock.view'), (req, res) => {
  const productId = req.query.productId ? Number(req.query.productId) : undefined;
  res.json(listMovements(productId, Math.min(Number(req.query.limit ?? 100), 500)));
});

/**
 * Lotes de um produto (`?productId=`) ou os lotes vencendo dentro do prazo configurado
 * (sem productId). Base da tela de validade e da conferência de lote.
 */
router.get('/lots', requirePermission('commercial.stock.view'), (req, res) => {
  if (req.query.productId) {
    res.json(listLots(Number(req.query.productId)));
    return;
  }
  const days = req.query.days != null ? Number(req.query.days) : undefined;
  res.json(listExpiringLots(days));
});

/** Baixa de um lote (perda/vencimento): zera o lote e subtrai o saldo do produto. */
router.post('/lots/:id/write-off', requirePermission('commercial.stock.move'), (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
  const result = writeOffLot(req, Number(req.params.id), reason);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

router.use('/move', requirePermission('commercial.stock.move'), validateBody(stockMoveSchema), (req, res) => {
  const { productId, type, qty, reason, lote, validade, custo } = req.body;
  const lot = (lote || validade || custo != null)
    ? { code: lote ?? null, expiresAt: validade ?? null, costCents: custo ?? null }
    : null;
  const result = moveStock(req, productId, type as MovementType, qty, reason, undefined, undefined, lot);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

export default router;
