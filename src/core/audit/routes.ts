import { Router } from 'express';
import { getSqlite } from '../database/connection';
import { requirePermission } from '../permissions/middleware';

const router = Router();

router.get('/', requirePermission('audit.view'), (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100) || 100, 2000);
  const clauses: string[] = [];
  const params: unknown[] = [];
  // Filtro por período (a tela envia `from`/`to` em AAAA-MM-DD; created_at é 'AAAA-MM-DD HH:MM:SS').
  if (req.query.from) { clauses.push('created_at >= ?'); params.push(String(req.query.from)); }
  if (req.query.to) { clauses.push('created_at <= ?'); params.push(`${String(req.query.to)} 23:59:59`); }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const rows = getSqlite()
    .prepare(
      `SELECT id, user_id, username, action, entity, entity_id, before_json, after_json, ip, machine, created_at
       FROM audit_logs${where} ORDER BY id DESC LIMIT ?`,
    )
    .all(...params, limit);
  res.json(rows);
});

export default router;
