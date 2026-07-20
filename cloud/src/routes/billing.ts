import { Router } from 'express';
import { getPool } from '../db';
import { requireCompanyAuth, type AuthedRequest } from '../auth';

const router = Router();

/**
 * Histórico de cobranças da própria empresa (Kivo instalado consome isso para
 * mostrar "a pagar"/"pagas" e o alerta de vencimento — mesma autenticação por
 * licença já usada em /api/sync e /api/backup).
 */
router.get('/charges', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const [rows] = await getPool().query(
    'SELECT id, description, instructions, amount_cents, due_date, status, paid_at, created_at FROM charges WHERE company_uuid = ? ORDER BY due_date DESC',
    [req.companyUuid],
  );
  res.json(rows);
});

export default router;
