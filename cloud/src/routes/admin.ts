import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import express, { Router } from 'express';
import { getPool } from '../db';
import { hashLicenseKey } from '../auth';
import { PLAN_TIERS, PLAN_LABELS, trialValidUntil } from '../plans';
import { validateCatalogImage, normalizeKeywords } from '../catalogValidation';
import { CATALOG_STORAGE_DIR, CATALOG_EXT_BY_FORMAT, CATALOG_MIME_BY_FORMAT } from './catalog';
import {
  verifyAdminCredentials,
  createAdminSession,
  destroyAdminSession,
  requireAdminAuth,
  readAdminCookie,
  hashPassword,
  ADMIN_SESSION_COOKIE,
  type AdminRequest,
} from '../adminAuth';

const router = Router();
const rawCatalogImage = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '6mb' });

function generateLicenseKey(): string {
  return randomBytes(24).toString('hex');
}

function parseModules(input: unknown): string[] {
  return String(input ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Se o admin não informar validade e o plano for trial, calcula os 15 dias automaticamente. */
function resolveValidUntil(plan: string | null, validUntil: unknown): string | null {
  if (validUntil) return String(validUntil);
  return plan === 'trial' ? trialValidUntil() : null;
}

interface CompanyRow {
  company_uuid: string;
  name: string | null;
  plan: string | null;
  modules: string[] | null;
  valid_until: string | null;
  max_devices: number;
}

async function loadCompanyDetail(companyUuid: string) {
  const pool = getPool();
  const [companies] = await pool.query('SELECT * FROM companies WHERE company_uuid = ?', [companyUuid]);
  const company = (companies as CompanyRow[])[0];
  if (!company) return null;

  const [statsRows] = await pool.query(
    'SELECT COUNT(*) AS total, MAX(server_received_at) AS last_activity FROM sync_records WHERE company_uuid = ?',
    [companyUuid],
  );
  const syncStats = (statsRows as { total: number; last_activity: string | null }[])[0];

  const [backups] = await pool.query(
    'SELECT uuid, machine_id, checksum, size_bytes, created_at FROM cloud_backups WHERE company_uuid = ? ORDER BY created_at DESC',
    [companyUuid],
  );

  const [charges] = await pool.query('SELECT * FROM charges WHERE company_uuid = ? ORDER BY due_date DESC', [companyUuid]);

  const [devices] = await pool.query(
    'SELECT id, machine_id, first_seen_at, last_seen_at FROM company_devices WHERE company_uuid = ? AND removed_at IS NULL ORDER BY last_seen_at DESC',
    [companyUuid],
  );

  return { company, syncStats, backups, charges, devices };
}

// --- Autenticação ---

router.get('/login', (_req, res) => {
  res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body ?? {};
  const ok = username && password && (await verifyAdminCredentials(String(username), String(password)));
  if (!ok) {
    res.status(401).render('login', { error: 'Usuário ou senha inválidos.' });
    return;
  }
  const token = createAdminSession(String(username));
  res.cookie(ADMIN_SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax' });
  res.redirect('/admin');
});

router.post('/logout', (req, res) => {
  destroyAdminSession(readAdminCookie(req));
  res.clearCookie(ADMIN_SESSION_COOKIE);
  res.redirect('/admin/login');
});

// --- Empresas ---

router.get('/', requireAdminAuth, async (_req, res) => {
  const pool = getPool();
  const [companies] = await pool.query(
    `SELECT c.company_uuid, c.name, c.plan, c.modules, c.valid_until,
            (SELECT COUNT(*) FROM sync_records sr WHERE sr.company_uuid = c.company_uuid) AS sync_count,
            (SELECT MAX(server_received_at) FROM sync_records sr WHERE sr.company_uuid = c.company_uuid) AS last_activity,
            (SELECT COALESCE(SUM(amount_cents),0) FROM charges ch WHERE ch.company_uuid = c.company_uuid AND ch.status = 'pendente') AS pending_cents
     FROM companies c ORDER BY c.created_at DESC`,
  );

  const [kpiRows] = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM companies) AS total_companies,
       (SELECT COUNT(*) FROM companies WHERE plan IS NOT NULL AND plan != '') AS active_companies,
       (SELECT COUNT(*) FROM sync_records WHERE server_received_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS syncs_7d,
       (SELECT COALESCE(SUM(amount_cents), 0) FROM charges WHERE status = 'pendente') AS pending_amount_cents`,
  );
  const kpis = (kpiRows as any)[0];

  const [planRows] = await pool.query(
    `SELECT COALESCE(plan, 'sem plano') AS plan_label, COUNT(*) AS cnt FROM companies GROUP BY plan_label ORDER BY cnt DESC`,
  );
  const planDistribution = planRows as { plan_label: string; cnt: number }[];

  const [recentSyncRows] = await pool.query(
    `SELECT sr.entity_type, sr.company_uuid, c.name, sr.server_received_at
     FROM sync_records sr LEFT JOIN companies c ON c.company_uuid = sr.company_uuid
     ORDER BY sr.server_received_at DESC LIMIT 8`,
  );
  const recentActivity = recentSyncRows as { entity_type: string; company_uuid: string; name: string | null; server_received_at: string }[];

  const alerts: { type: string; icon: string; title: string; detail: string; link?: string }[] = [];

  const [expiringRows] = await pool.query(
    `SELECT name, company_uuid, valid_until FROM companies
     WHERE valid_until IS NOT NULL
       AND valid_until <= DATE_ADD(NOW(), INTERVAL 7 DAY)
       AND valid_until >= NOW()
     ORDER BY valid_until ASC LIMIT 5`,
  );
  for (const e of expiringRows as { name: string; company_uuid: string; valid_until: string }[]) {
    alerts.push({ type: 'warning', icon: 'clock', title: `${e.name || e.company_uuid.slice(0, 8)}`, detail: `validade vence em ${String(e.valid_until).slice(0, 10)}`, link: `/admin/companies/${e.company_uuid}` });
  }

  const [overdueRows] = await pool.query(
    `SELECT c.name, c.company_uuid, ch.description, ch.amount_cents, ch.due_date
     FROM charges ch JOIN companies c ON c.company_uuid = ch.company_uuid
     WHERE ch.status = 'pendente' AND ch.due_date < CURDATE()
     ORDER BY ch.due_date ASC LIMIT 5`,
  );
  for (const o of overdueRows as { name: string; company_uuid: string; description: string; amount_cents: number; due_date: string }[]) {
    alerts.push({ type: 'danger', icon: 'alert', title: `Cobrança vencida: ${o.description}`, detail: `${o.name || o.company_uuid.slice(0, 8)} — R$ ${(o.amount_cents / 100).toFixed(2)}`, link: `/admin/companies/${o.company_uuid}` });
  }

  if (kpis.total_companies === 0) {
    alerts.push({ type: 'info', icon: 'plus', title: 'Bem-vindo ao Katsu Cloud!', detail: 'Comece cadastrando sua primeira empresa.' });
  }

  res.render('dashboard', {
    companies, planTiers: PLAN_TIERS, planLabels: PLAN_LABELS,
    kpis, planDistribution, recentActivity, alerts,
  });
});

router.post('/companies', requireAdminAuth, async (req: AdminRequest, res) => {
  const { name, plan, modules, validUntil, maxDevices } = req.body ?? {};
  const companyUuid = randomUUID();
  const licenseKey = generateLicenseKey();
  const modulesList = parseModules(modules);
  await getPool().query(
    'INSERT INTO companies (company_uuid, license_key_hash, name, plan, modules, valid_until, max_devices) VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, ?)',
    [
      companyUuid,
      hashLicenseKey(licenseKey),
      name || null,
      plan || null,
      modulesList.length ? JSON.stringify(modulesList) : null,
      resolveValidUntil(plan || null, validUntil),
      maxDevices ? Math.max(1, Number(maxDevices)) : 1,
    ],
  );
  const detail = await loadCompanyDetail(companyUuid);
  res.render('company-detail', { ...detail, revealedLicenseKey: licenseKey, planTiers: PLAN_TIERS, planLabels: PLAN_LABELS });
});

router.get('/companies/:uuid', requireAdminAuth, async (req, res) => {
  const detail = await loadCompanyDetail(String(req.params.uuid));
  if (!detail) {
    res.status(404).send('Empresa não encontrada.');
    return;
  }
  res.render('company-detail', { ...detail, revealedLicenseKey: null, planTiers: PLAN_TIERS, planLabels: PLAN_LABELS });
});

router.post('/companies/:uuid', requireAdminAuth, async (req, res) => {
  const uuid = String(req.params.uuid);
  const { name, plan, modules, validUntil, maxDevices } = req.body ?? {};
  const modulesList = parseModules(modules);
  await getPool().query(
    'UPDATE companies SET name = ?, plan = ?, modules = CAST(? AS JSON), valid_until = ?, max_devices = ? WHERE company_uuid = ?',
    [
      name || null,
      plan || null,
      modulesList.length ? JSON.stringify(modulesList) : null,
      resolveValidUntil(plan || null, validUntil),
      maxDevices ? Math.max(1, Number(maxDevices)) : 1,
      uuid,
    ],
  );
  res.redirect(`/admin/companies/${uuid}`);
});

/** Libera a vaga do dispositivo (troca de máquina, decisão de produto: só via suporte) —
 * soft delete: a máquina removida leva um bloqueio imediato e específico na próxima
 * tentativa dela (`device_revoked`), não some silenciosamente do histórico. */
router.post('/companies/:uuid/devices/:id/delete', requireAdminAuth, async (req, res) => {
  const uuid = String(req.params.uuid);
  await getPool().query(
    "UPDATE company_devices SET removed_at = NOW(3) WHERE id = ? AND company_uuid = ? AND removed_at IS NULL",
    [req.params.id, uuid],
  );
  // Chamado tanto da ficha da empresa quanto da tela global /admin/devices — volta pra
  // onde o admin estava, em vez de sempre jogar pra ficha da empresa.
  const redirectTo = typeof req.body?.redirectTo === 'string' && req.body.redirectTo.startsWith('/admin/')
    ? req.body.redirectTo
    : `/admin/companies/${uuid}`;
  res.redirect(redirectTo);
});

/** Tela global: dispositivos de TODAS as empresas (ativos e removidos), pra suporte não
 * precisar abrir empresa por empresa procurando uma máquina específica. */
router.get('/devices', requireAdminAuth, async (_req, res) => {
  const [devices] = await getPool().query(
    `SELECT cd.id, cd.company_uuid, cd.machine_id, cd.first_seen_at, cd.last_seen_at, cd.removed_at,
            c.name AS company_name, c.plan AS company_plan
     FROM company_devices cd
     JOIN companies c ON c.company_uuid = cd.company_uuid
     ORDER BY cd.last_seen_at DESC`,
  );
  res.render('devices', { devices, planLabels: PLAN_LABELS });
});

/**
 * Exclusão definitiva: some com histórico de sincronização, backups (linha + arquivo no
 * disco) e cobranças. Imagens do banco (catalog_images) só perdem o vínculo com a empresa
 * (company_uuid = NULL) — são um acervo compartilhado, não pertencem só a quem enviou.
 */
router.post('/companies/:uuid/delete', requireAdminAuth, async (req, res) => {
  const uuid = String(req.params.uuid);
  const pool = getPool();
  const [companyRows] = await pool.query('SELECT company_uuid FROM companies WHERE company_uuid = ?', [uuid]);
  if (!(companyRows as { company_uuid: string }[])[0]) {
    res.status(404).send('Empresa não encontrada.');
    return;
  }
  const [backupRows] = await pool.query('SELECT storage_path FROM cloud_backups WHERE company_uuid = ?', [uuid]);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM sync_records WHERE company_uuid = ?', [uuid]);
    await conn.query('DELETE FROM cloud_backups WHERE company_uuid = ?', [uuid]);
    await conn.query('DELETE FROM charges WHERE company_uuid = ?', [uuid]);
    await conn.query('DELETE FROM company_devices WHERE company_uuid = ?', [uuid]);
    await conn.query('UPDATE catalog_images SET company_uuid = NULL WHERE company_uuid = ?', [uuid]);
    await conn.query('DELETE FROM companies WHERE company_uuid = ?', [uuid]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  for (const b of backupRows as { storage_path: string }[]) {
    try {
      fs.unlinkSync(b.storage_path);
    } catch {
      // arquivo já não existe — a exclusão do registro já foi commitada, segue o jogo
    }
  }
  res.redirect('/admin');
});

router.post('/companies/:uuid/rotate-key', requireAdminAuth, async (req, res) => {
  const uuid = String(req.params.uuid);
  const licenseKey = generateLicenseKey();
  await getPool().query('UPDATE companies SET license_key_hash = ? WHERE company_uuid = ?', [hashLicenseKey(licenseKey), uuid]);
  const detail = await loadCompanyDetail(uuid);
  if (!detail) {
    res.status(404).send('Empresa não encontrada.');
    return;
  }
  res.render('company-detail', { ...detail, revealedLicenseKey: licenseKey, planTiers: PLAN_TIERS, planLabels: PLAN_LABELS });
});

// --- Cobrança manual (sem gateway — só registro e baixa manual) ---

router.post('/companies/:uuid/charges', requireAdminAuth, async (req, res) => {
  const uuid = String(req.params.uuid);
  const { description, amount, dueDate, instructions } = req.body ?? {};
  if (description && amount && dueDate) {
    await getPool().query(
      'INSERT INTO charges (company_uuid, description, instructions, amount_cents, due_date) VALUES (?, ?, ?, ?, ?)',
      [uuid, description, instructions || null, Math.round(Number(amount) * 100), dueDate],
    );
  }
  res.redirect(`/admin/companies/${uuid}`);
});

router.post('/companies/:uuid/charges/:id/pay', requireAdminAuth, async (req, res) => {
  const uuid = String(req.params.uuid);
  await getPool().query("UPDATE charges SET status = 'paga', paid_at = NOW(3) WHERE id = ? AND company_uuid = ?", [
    req.params.id,
    uuid,
  ]);
  res.redirect(`/admin/companies/${uuid}`);
});

router.post('/companies/:uuid/charges/:id/cancel', requireAdminAuth, async (req, res) => {
  const uuid = String(req.params.uuid);
  await getPool().query("UPDATE charges SET status = 'cancelada' WHERE id = ? AND company_uuid = ?", [req.params.id, uuid]);
  res.redirect(`/admin/companies/${uuid}`);
});

// --- Configurações globais (contato de suporte exibido no app quando a licença vence) ---

router.get('/settings', requireAdminAuth, async (_req, res) => {
  const [rows] = await getPool().query('SELECT setting_key, setting_value FROM app_settings');
  const settings = Object.fromEntries(
    (rows as { setting_key: string; setting_value: string | null }[]).map((r) => [r.setting_key, r.setting_value]),
  );
  res.render('admin-settings', { settings });
});

router.post('/settings', requireAdminAuth, async (req, res) => {
  const { supportPhone, supportEmail } = req.body ?? {};
  const upsert = (key: string, value: unknown) =>
    getPool().query(
      'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
      [key, value || null],
    );
  await Promise.all([upsert('support_phone', supportPhone), upsert('support_email', supportEmail)]);
  res.redirect('/admin/settings');
});

// --- Administradores do painel ---

router.get('/admins', requireAdminAuth, async (_req, res) => {
  const [admins] = await getPool().query('SELECT id, username, created_at FROM admin_users ORDER BY username');
  res.render('admins', { admins, error: null });
});

router.post('/admins', requireAdminAuth, async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    const [admins] = await getPool().query('SELECT id, username, created_at FROM admin_users ORDER BY username');
    res.status(400).render('admins', { admins, error: 'Preencha usuário e senha.' });
    return;
  }
  try {
    await getPool().query('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)', [
      String(username).trim(),
      hashPassword(String(password)),
    ]);
    res.redirect('/admin/admins');
  } catch {
    const [admins] = await getPool().query('SELECT id, username, created_at FROM admin_users ORDER BY username');
    res.status(400).render('admins', { admins, error: 'Já existe um administrador com esse usuário.' });
  }
});

router.post('/admins/:id/delete', requireAdminAuth, async (req: AdminRequest, res) => {
  const id = Number(req.params.id);
  const [rows] = await getPool().query('SELECT username FROM admin_users WHERE id = ?', [id]);
  const target = (rows as { username: string }[])[0];
  const loadWithError = async (error: string) => {
    const [admins] = await getPool().query('SELECT id, username, created_at FROM admin_users ORDER BY username');
    res.status(400).render('admins', { admins, error });
  };
  if (!target) {
    await loadWithError('Administrador não encontrado.');
    return;
  }
  if (target.username === req.adminUsername) {
    await loadWithError('Você não pode excluir seu próprio usuário.');
    return;
  }
  const [countRows] = await getPool().query('SELECT COUNT(*) AS total FROM admin_users');
  if ((countRows as { total: number }[])[0].total <= 1) {
    await loadWithError('Não é possível excluir o último administrador.');
    return;
  }
  await getPool().query('DELETE FROM admin_users WHERE id = ?', [id]);
  res.redirect('/admin/admins');
});

// --- Perfil do administrador logado ---

router.get('/profile', requireAdminAuth, async (req: AdminRequest, res) => {
  const [rows] = await getPool().query('SELECT username, created_at FROM admin_users WHERE username = ?', [req.adminUsername]);
  const admin = (rows as { username: string; created_at: string }[])[0];
  res.render('profile', { admin, error: null, success: null });
});

router.post('/profile/password', requireAdminAuth, async (req: AdminRequest, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body ?? {};
  const [rows] = await getPool().query('SELECT username, created_at FROM admin_users WHERE username = ?', [req.adminUsername]);
  const admin = (rows as { username: string; created_at: string }[])[0];
  const fail = (error: string) => res.status(400).render('profile', { admin, error, success: null });

  if (!currentPassword || !newPassword || !confirmPassword) {
    fail('Preencha todos os campos.');
    return;
  }
  if (newPassword !== confirmPassword) {
    fail('A confirmação não bate com a nova senha.');
    return;
  }
  if (String(newPassword).length < 8) {
    fail('A nova senha precisa ter pelo menos 8 caracteres.');
    return;
  }
  const ok = await verifyAdminCredentials(req.adminUsername!, String(currentPassword));
  if (!ok) {
    fail('Senha atual incorreta.');
    return;
  }
  await getPool().query('UPDATE admin_users SET password_hash = ? WHERE username = ?', [
    hashPassword(String(newPassword)),
    req.adminUsername,
  ]);
  res.render('profile', { admin, error: null, success: 'Senha alterada com sucesso.' });
});

// --- Banco de imagens (curadoria) ---

interface CatalogImageRow {
  id: number;
  company_uuid: string | null;
  product_name: string;
  keywords: string;
  image_path: string;
  format: 'jpeg' | 'png' | 'webp';
  width: number;
  height: number;
  size_bytes: number;
  status: 'pendente' | 'aprovada' | 'rejeitada';
  source: 'submissao' | 'manual';
  created_at: string;
}

router.get('/catalog', requireAdminAuth, async (req, res) => {
  const pool = getPool();
  const activeStatus = req.query.status === 'aprovada' ? 'aprovada' : 'pendente';
  const orderBy = activeStatus === 'aprovada' ? 'reviewed_at DESC' : 'created_at ASC';
  const [images] = await pool.query(
    `SELECT id, company_uuid, product_name, keywords, image_path, format, width, height, size_bytes, status, source, created_at
     FROM catalog_images WHERE status = ? ORDER BY ${orderBy}`,
    [activeStatus],
  );
  const [statsRows] = await pool.query(
    `SELECT
       SUM(status = 'pendente') AS pending,
       SUM(status = 'aprovada') AS approved,
       SUM(status = 'rejeitada') AS rejected,
       -- rejeitada não soma: o arquivo já foi apagado do disco na rejeição, só sobra a linha (tombstone anti-duplicata)
       SUM(CASE WHEN status IN ('pendente', 'aprovada') THEN size_bytes ELSE 0 END) AS storage_bytes
     FROM catalog_images`,
  );
  const stats = (statsRows as { pending: number | null; approved: number | null; rejected: number | null; storage_bytes: number | null }[])[0];
  res.render('catalog-queue', {
    images: images as CatalogImageRow[],
    activeStatus,
    stats: {
      pending: stats?.pending ?? 0, approved: stats?.approved ?? 0, rejected: stats?.rejected ?? 0,
      storageBytes: stats?.storage_bytes ?? 0,
    },
    error: null,
  });
});

/** Miniatura no painel de curadoria — serve qualquer status (a pública em /api/catalog/image só serve aprovada). */
router.get('/catalog/:id/image', requireAdminAuth, async (req, res) => {
  const [rows] = await getPool().query('SELECT image_path, format FROM catalog_images WHERE id = ?', [req.params.id]);
  const row = (rows as { image_path: string; format: 'jpeg' | 'png' | 'webp' }[])[0];
  const filePath = row?.image_path ? path.join(CATALOG_STORAGE_DIR, row.image_path) : null;
  if (!filePath || !fs.existsSync(filePath)) {
    res.status(404).send('Imagem não encontrada.');
    return;
  }
  res.setHeader('Content-Type', CATALOG_MIME_BY_FORMAT[row.format]);
  res.send(fs.readFileSync(filePath));
});

router.post('/catalog/:id/approve', requireAdminAuth, async (req: AdminRequest, res) => {
  await getPool().query(
    "UPDATE catalog_images SET status = 'aprovada', reviewed_by = ?, reviewed_at = NOW(3) WHERE id = ? AND status = 'pendente'",
    [req.adminUsername, req.params.id],
  );
  res.redirect('/admin/catalog' + (req.body?.redirectStatus === 'aprovada' ? '?status=aprovada' : ''));
});

/**
 * Rejeitada: some do disco na hora (não fica ocupando espaço nem aparece mais na fila —
 * a listagem de /admin/catalog só traz status='pendente'). A LINHA em si fica como
 * "tombstone" (status='rejeitada', sem arquivo) — é o que permite bloquear no /submit uma
 * nova tentativa de enviar exatamente a mesma imagem (mesmo sha256) já reprovada antes.
 * Um DELETE completo aqui destruiria essa memória e reabriria a porta pro duplicado.
 */
router.post('/catalog/:id/reject', requireAdminAuth, async (req: AdminRequest, res) => {
  const [rows] = await getPool().query('SELECT image_path FROM catalog_images WHERE id = ?', [req.params.id]);
  const row = (rows as { image_path: string }[])[0];
  if (row) {
    try {
      fs.unlinkSync(path.join(CATALOG_STORAGE_DIR, row.image_path));
    } catch {
      // arquivo já não existe — segue o rejeite mesmo assim
    }
    await getPool().query(
      "UPDATE catalog_images SET status = 'rejeitada', image_path = '', reviewed_by = ?, reviewed_at = NOW(3) WHERE id = ?",
      [req.adminUsername, req.params.id],
    );
  }
  res.redirect('/admin/catalog' + (req.body?.redirectStatus === 'aprovada' ? '?status=aprovada' : ''));
});

/**
 * Upload manual do admin: some direto pro catálogo aprovado (bootstrap do banco de
 * imagens). Responde JSON, não HTML — o corpo é binário (mesma técnica de /api/catalog/submit),
 * então o formulário no catalog-queue.ejs é 100% orientado a `fetch`, sem <form> nativo.
 */
router.post('/catalog/manual', rawCatalogImage, requireAdminAuth, async (req: AdminRequest, res) => {
  const productName = req.header('X-Katsu-Product-Name');
  const body = req.body as Buffer;

  if (!productName || !Buffer.isBuffer(body) || !body.length) {
    res.status(400).json({ error: 'Preencha o nome do produto e escolha uma imagem.' });
    return;
  }
  const check = validateCatalogImage(body);
  if (!check.ok) {
    res.status(400).json({ error: check.error });
    return;
  }
  const hash = createHash('sha256').update(body).digest('hex');
  const [existingRows] = await getPool().query('SELECT id FROM catalog_images WHERE sha256 = ?', [hash]);
  if ((existingRows as { id: number }[])[0]) {
    res.status(409).json({ error: 'Essa imagem já existe no catálogo (mesmo conteúdo).' });
    return;
  }

  fs.mkdirSync(CATALOG_STORAGE_DIR, { recursive: true });
  const filename = `${hash}.${CATALOG_EXT_BY_FORMAT[check.format]}`;
  fs.writeFileSync(path.join(CATALOG_STORAGE_DIR, filename), body);
  const [info] = await getPool().query(
    `INSERT INTO catalog_images
       (company_uuid, product_name, keywords, image_path, sha256, width, height, format, size_bytes, status, source, reviewed_by, reviewed_at)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'aprovada', 'manual', ?, NOW(3))`,
    [productName, normalizeKeywords(productName), filename, hash, check.width, check.height, check.format, body.length, req.adminUsername],
  );
  res.status(201).json({ ok: true, catalogImageId: (info as { insertId: number }).insertId });
});

export default router;
