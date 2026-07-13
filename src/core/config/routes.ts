import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { Router } from 'express';
import { getSqlite } from '../database/connection';
import { requirePermission } from '../permissions/middleware';
import { audit } from '../audit/service';

const router = Router();

router.get('/', requirePermission('settings.view'), (_req, res) => {
  const rows = getSqlite()
    .prepare('SELECT key, value, updated_at FROM settings WHERE deleted_at IS NULL ORDER BY key')
    .all();
  res.json(rows);
});

/** Endereços IPv4 desta máquina na rede local — para a tela de Configurações
 * mostrar ao admin como o celular do garçom/tablet da cozinha alcançam o Katsu. */
router.get('/network-info', requirePermission('settings.view'), (_req, res) => {
  const port = Number(process.env.KATSU_PORT ?? 3123);
  const urls: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) urls.push(`http://${addr.address}:${port}`);
    }
  }
  res.json({ urls, port });
});

router.put('/:key', requirePermission('settings.edit'), (req, res) => {
  const key = String(req.params.key);
  const { value } = req.body ?? {};
  const db = getSqlite();
  const before = db.prepare('SELECT key, value FROM settings WHERE key = ?').get(key);
  db.prepare(
    `INSERT INTO settings (key, value, uuid) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), deleted_at = NULL`,
  ).run(key, value != null ? String(value) : null, randomUUID());
  const after = db.prepare('SELECT key, value FROM settings WHERE key = ?').get(key);
  audit(req, 'editar', 'setting', key, before ?? null, after);
  res.json(after);
});

export default router;
