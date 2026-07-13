import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { Router } from 'express';
import QRCode from 'qrcode';
import { getSqlite } from '../database/connection';
import { requirePermission } from '../permissions/middleware';
import { audit } from '../audit/service';
import { getCloudServerUrl } from './cloud';
import { getLicenseCredentials } from '../license/service';

const router = Router();

router.get('/', requirePermission('settings.view'), (_req, res) => {
  const rows = getSqlite()
    .prepare('SELECT key, value, updated_at FROM settings WHERE deleted_at IS NULL ORDER BY key')
    .all();
  res.json(rows);
});

/** Endereços IPv4 desta máquina na rede local — para a tela de Configurações
 * mostrar ao admin como o celular do garçom/tablet da cozinha alcançam o Katsu.
 * O QR de cada endereço é gerado aqui (server-side, lib `qrcode` pura-JS, sem
 * dependência nativa nem CDN) para não precisar vendorizar mais um bundle
 * client-side — mesmo espírito 100% offline do resto do app. */
router.get('/network-info', requirePermission('settings.view'), async (_req, res) => {
  const port = Number(process.env.KATSU_PORT ?? 3123);
  const rawUrls: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) rawUrls.push(`http://${addr.address}:${port}`);
    }
  }
  const urls = await Promise.all(
    rawUrls.map(async (url) => ({ url, qr: await QRCode.toDataURL(url, { margin: 1, width: 160 }) })),
  );
  res.json({ urls, port });
});

/** Link público do cardápio online (Fase 6) + QR — monta a partir do company_uuid da
 * licença ativada e da URL do cloud/ configurada; sem licença/cloud configurado, não
 * há link possível (o app funciona 100% offline até aqui). */
router.get('/cardapio-info', requirePermission('settings.view'), async (_req, res) => {
  const { companyUuid } = getLicenseCredentials();
  const cloudUrl = getCloudServerUrl();
  if (!companyUuid || !cloudUrl) {
    res.json({ url: null, qr: null });
    return;
  }
  const url = `${cloudUrl.replace(/\/$/, '')}/cardapio/${companyUuid}`;
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 200 });
  res.json({ url, qr });
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
