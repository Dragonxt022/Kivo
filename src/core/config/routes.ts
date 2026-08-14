import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { Router } from 'express';
import QRCode from 'qrcode';
import { getSqlite } from '../database/connection';
import { requirePermission } from '../permissions/middleware';
import { audit } from '../audit/service';
import { getCloudServerUrl } from './cloud';
import { getMachinePrefs, setMachinePrefs } from './machinePrefs';
import { saveCompanyLogo, deleteCompanyLogoFile, LOGO_SETTING_KEY } from './companyLogo';
import { getLicenseCredentials } from '../license/service';

const router = Router();

router.get('/', requirePermission('settings.view'), (_req, res) => {
  const rows = getSqlite()
    .prepare('SELECT key, value, updated_at FROM settings WHERE deleted_at IS NULL ORDER BY key')
    .all();
  res.json(rows);
});

/** Endereços IPv4 desta máquina na rede local — para a tela de Configurações
 * mostrar ao admin como o celular do garçom/tablet da cozinha alcançam o Kivo.
 * O QR de cada endereço é gerado aqui (server-side, lib `qrcode` pura-JS, sem
 * dependência nativa nem CDN) para não precisar vendorizar mais um bundle
 * client-side — mesmo espírito 100% offline do resto do app. */
router.get('/network-info', requirePermission('settings.view'), async (_req, res) => {
  const port = Number(process.env.KIVO_PORT ?? 3123);
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

/**
 * Preferências desta máquina (modo leve). Ficam fora da tabela `settings` porque ela
 * sincroniza para as outras máquinas da empresa — ver core/config/machinePrefs.ts.
 *
 * Precisam vir ANTES do `PUT /:key` abaixo, que é curinga e engoliria `/machine-prefs`.
 * Leitura exige só `settings.view`; escrita, `settings.edit` — mesma régua das demais.
 */
router.get('/machine-prefs', requirePermission('settings.view'), (_req, res) => {
  res.json(getMachinePrefs());
});

router.put('/machine-prefs', requirePermission('settings.edit'), (req, res) => {
  const { modoLeve } = req.body ?? {};
  if (typeof modoLeve !== 'boolean') {
    res.status(400).json({ error: 'Informe modoLeve (true/false).' });
    return;
  }
  const before = getMachinePrefs();
  // `modoLeveDetectado` fecha a porta da detecção automática: depois de uma escolha manual,
  // o app nunca mais reverte o que o usuário decidiu.
  const after = setMachinePrefs({ modoLeve, modoLeveDetectado: true });
  // As views leem `modoLeve` de app.locals para estampar `data-lite` no <html> já no primeiro
  // byte da resposta (sem piscar). Sem atualizar aqui, só valeria depois de reiniciar.
  req.app.locals.modoLeve = after.modoLeve;
  audit(req, 'editar', 'machine-prefs', 'modoLeve', before, after);
  res.json(after);
});

/**
 * Logo da empresa. Rota própria em vez de mandar a imagem pelo `PUT /:key` genérico
 * porque aqui há validação de formato, gravação de arquivo e limpeza da logo anterior —
 * nada disso cabe num setter de string. Precisa vir ANTES do `PUT /:key`, que é curinga.
 */
router.put('/company-logo', requirePermission('settings.edit'), (req, res) => {
  const { imageBase64 } = req.body ?? {};
  if (!imageBase64) {
    res.status(400).json({ error: 'Envie a imagem em imageBase64.' });
    return;
  }
  const saved = saveCompanyLogo(String(imageBase64));
  if (!saved.ok) {
    res.status(400).json({ error: saved.error });
    return;
  }
  const db = getSqlite();
  const before = db.prepare('SELECT key, value FROM settings WHERE key = ?').get(LOGO_SETTING_KEY) as
    | { key: string; value: string | null }
    | undefined;
  db.prepare(
    `INSERT INTO settings (key, value, uuid) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), deleted_at = NULL`,
  ).run(LOGO_SETTING_KEY, saved.url, randomUUID());
  // Só depois de a nova estar gravada: se a escrita acima falhasse, apagar antes deixaria
  // a loja sem logo nenhuma.
  deleteCompanyLogoFile(before?.value);
  req.app.locals.empresaLogoUrl = saved.url;
  audit(req, 'editar', 'setting', LOGO_SETTING_KEY, before ?? null, { key: LOGO_SETTING_KEY, value: saved.url });
  res.json({ url: saved.url });
});

router.delete('/company-logo', requirePermission('settings.edit'), (req, res) => {
  const db = getSqlite();
  const before = db.prepare('SELECT key, value FROM settings WHERE key = ?').get(LOGO_SETTING_KEY) as
    | { key: string; value: string | null }
    | undefined;
  db.prepare(`UPDATE settings SET value = NULL, updated_at = datetime('now') WHERE key = ?`).run(LOGO_SETTING_KEY);
  deleteCompanyLogoFile(before?.value);
  req.app.locals.empresaLogoUrl = null;
  audit(req, 'excluir', 'setting', LOGO_SETTING_KEY, before ?? null, null);
  res.json({ ok: true });
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
