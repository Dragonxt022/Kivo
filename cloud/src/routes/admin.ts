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
  hasAnyAdmin,
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

router.get('/login', async (req, res) => {
  if (!(await hasAnyAdmin())) {
    res.redirect('/admin/setup');
    return;
  }
  res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body ?? {};
  const ok = username && password && (await verifyAdminCredentials(String(username), String(password)));
  if (!ok) {
    if (!(await hasAnyAdmin())) {
      res.redirect('/admin/setup');
      return;
    }
    res.status(401).render('login', { error: 'Usuário ou senha inválidos.' });
    return;
  }
  const token = createAdminSession(String(username));
  res.cookie(ADMIN_SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax' });
  res.redirect('/admin');
});

router.get('/setup', async (req, res) => {
  if (await hasAnyAdmin()) {
    res.redirect('/admin/login');
    return;
  }
  res.render('setup', { error: null });
});

router.post('/setup', async (req, res) => {
  if (await hasAnyAdmin()) {
    res.redirect('/admin/login');
    return;
  }
  const { username, password, password_confirm } = req.body ?? {};
  if (!username || !password || !password_confirm) {
    res.status(400).render('setup', { error: 'Preencha todos os campos.' });
    return;
  }
  if (String(password) !== String(password_confirm)) {
    res.status(400).render('setup', { error: 'As senhas não conferem.' });
    return;
  }
  if (String(password).length < 4) {
    res.status(400).render('setup', { error: 'A senha deve ter no mínimo 4 caracteres.' });
    return;
  }
  await getPool().query(
    'INSERT INTO admin_users (username, password_hash) VALUES (?, ?)',
    [String(username), hashPassword(String(password))],
  );
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

/** Lista completa de empresas com métricas agregadas — usada pela página /admin/companies. */
async function loadCompaniesList() {
  const [companies] = await getPool().query(
    `SELECT c.company_uuid, c.name, c.plan, c.modules, c.valid_until,
            (SELECT COUNT(*) FROM sync_records sr WHERE sr.company_uuid = c.company_uuid) AS sync_count,
            (SELECT MAX(server_received_at) FROM sync_records sr WHERE sr.company_uuid = c.company_uuid) AS last_activity,
            (SELECT COALESCE(SUM(amount_cents),0) FROM charges ch WHERE ch.company_uuid = c.company_uuid AND ch.status = 'pendente') AS pending_cents
     FROM companies c ORDER BY c.created_at DESC`,
  );
  return companies;
}

router.get('/companies', requireAdminAuth, async (_req, res) => {
  res.render('companies', {
    companies: await loadCompaniesList(),
    planTiers: PLAN_TIERS,
    planLabels: PLAN_LABELS,
  });
});

router.get('/', requireAdminAuth, async (_req, res) => {
  const pool = getPool();

  const [kpiRows] = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM companies) AS total_companies,
       (SELECT COUNT(*) FROM companies WHERE plan IS NOT NULL AND plan != '') AS active_companies,
       (SELECT COUNT(*) FROM sync_records WHERE server_received_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS syncs_7d,
       (SELECT COALESCE(SUM(amount_cents), 0) FROM charges WHERE status = 'pendente') AS pending_amount_cents,
       -- Janelas anteriores, para calcular a variação exibida nos KPIs.
       (SELECT COUNT(*) FROM sync_records
         WHERE server_received_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)
           AND server_received_at <  DATE_SUB(NOW(), INTERVAL 7 DAY)) AS syncs_prev_7d,
       (SELECT COUNT(*) FROM companies WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS new_companies_30d,
       (SELECT COUNT(*) FROM companies
         WHERE created_at >= DATE_SUB(NOW(), INTERVAL 60 DAY)
           AND created_at <  DATE_SUB(NOW(), INTERVAL 30 DAY)) AS new_companies_prev_30d,
       (SELECT COALESCE(SUM(amount_cents), 0) FROM charges
         WHERE status = 'paga' AND paid_at >= DATE_FORMAT(NOW(), '%Y-%m-01')) AS revenue_month_cents,
       (SELECT COALESCE(SUM(amount_cents), 0) FROM charges
         WHERE status = 'paga'
           AND paid_at >= DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 1 MONTH), '%Y-%m-01')
           AND paid_at <  DATE_FORMAT(NOW(), '%Y-%m-01')) AS revenue_prev_month_cents,
       (SELECT COUNT(*) FROM company_devices WHERE removed_at IS NULL) AS active_devices,
       (SELECT COUNT(*) FROM charges WHERE status = 'pendente' AND due_date < CURDATE()) AS overdue_count`,
  );
  const kpis = (kpiRows as any)[0];

  // Série diária dos últimos 14 dias. O MySQL só devolve dias com registro, então
  // preenchemos os buracos com zero para o gráfico não mentir sobre a continuidade.
  const [syncTrendRows] = await pool.query(
    `SELECT DATE(server_received_at) AS d, COUNT(*) AS cnt
     FROM sync_records
     WHERE server_received_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
     GROUP BY d ORDER BY d ASC`,
  );
  const trendByDay = new Map<string, number>();
  for (const r of syncTrendRows as { d: Date | string; cnt: number }[]) {
    const key = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10);
    trendByDay.set(key, Number(r.cnt));
  }
  const syncTrend: { date: string; count: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - i);
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    syncTrend.push({ date: key, count: trendByDay.get(key) ?? 0 });
  }

  const [revenueRows] = await pool.query(
    `SELECT DATE_FORMAT(paid_at, '%Y-%m') AS ym, COALESCE(SUM(amount_cents), 0) AS cents
     FROM charges
     WHERE status = 'paga' AND paid_at >= DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 5 MONTH), '%Y-%m-01')
     GROUP BY ym ORDER BY ym ASC`,
  );
  const revenueByMonth = new Map<string, number>();
  for (const r of revenueRows as { ym: string; cents: number }[]) revenueByMonth.set(String(r.ym), Number(r.cents));
  const revenueTrend: { month: string; cents: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    revenueTrend.push({ month: key, cents: revenueByMonth.get(key) ?? 0 });
  }

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
    alerts.push({ type: 'info', icon: 'plus', title: 'Bem-vindo ao Kivo Cloud!', detail: 'Comece cadastrando sua primeira empresa.' });
  }

  res.render('dashboard', {
    planTiers: PLAN_TIERS, planLabels: PLAN_LABELS,
    kpis, planDistribution, recentActivity, alerts, syncTrend, revenueTrend,
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

/** Normaliza um campo de texto do formulário: string aparada ou NULL se vazio. */
function textOrNull(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
}

/**
 * A tela de detalhe é dividida em abas, e cada aba salva só o que ela mostra.
 * Por isso são dois endpoints com UPDATEs disjuntos: um form parcial mandando
 * todos os campos de uma vez apagaria o que a outra aba edita.
 */
router.post('/companies/:uuid/profile', requireAdminAuth, async (req, res) => {
  const uuid = String(req.params.uuid);
  const b = req.body ?? {};
  await getPool().query(
    `UPDATE companies SET
       name = ?, legal_name = ?, document = ?, state_registration = ?, email = ?, phone = ?,
       zip = ?, street = ?, number = ?, complement = ?, district = ?, city = ?, state = ?
     WHERE company_uuid = ?`,
    [
      textOrNull(b.name),
      textOrNull(b.legalName),
      textOrNull(b.document),
      textOrNull(b.stateRegistration),
      textOrNull(b.email),
      textOrNull(b.phone),
      textOrNull(b.zip),
      textOrNull(b.street),
      textOrNull(b.number),
      textOrNull(b.complement),
      textOrNull(b.district),
      textOrNull(b.city),
      textOrNull(b.state)?.toUpperCase().slice(0, 2) ?? null,
      uuid,
    ],
  );
  res.redirect(`/admin/companies/${uuid}#detalhes`);
});

router.post('/companies/:uuid/license', requireAdminAuth, async (req, res) => {
  const uuid = String(req.params.uuid);
  const { plan, modules, validUntil, maxDevices } = req.body ?? {};
  const modulesList = parseModules(modules);
  await getPool().query(
    'UPDATE companies SET plan = ?, modules = CAST(? AS JSON), valid_until = ?, max_devices = ? WHERE company_uuid = ?',
    [
      plan || null,
      modulesList.length ? JSON.stringify(modulesList) : null,
      resolveValidUntil(plan || null, validUntil),
      maxDevices ? Math.max(1, Number(maxDevices)) : 1,
      uuid,
    ],
  );
  res.redirect(`/admin/companies/${uuid}#licenca`);
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
  res.redirect('/admin/companies');
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
    deleted: req.query.deleted ? Number(req.query.deleted) : null,
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

router.post('/catalog/batch-approve', requireAdminAuth, async (req: AdminRequest, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.length) {
    res.redirect('/admin/catalog');
    return;
  }
  const placeholders = ids.map(() => '?').join(',');
  await getPool().query(
    `UPDATE catalog_images SET status = 'aprovada', reviewed_by = ?, reviewed_at = NOW(3) WHERE id IN (${placeholders}) AND status = 'pendente'`,
    [req.adminUsername, ...ids],
  );
  res.redirect('/admin/catalog' + (req.body?.redirectStatus === 'aprovada' ? '?status=aprovada' : ''));
});

router.post('/catalog/batch-reject', requireAdminAuth, async (req: AdminRequest, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.length) {
    res.redirect('/admin/catalog');
    return;
  }
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await getPool().query(
    `SELECT id, image_path FROM catalog_images WHERE id IN (${placeholders})`,
    ids,
  );
  const images = rows as { id: number; image_path: string }[];
  for (const img of images) {
    if (img.image_path) {
      try {
        fs.unlinkSync(path.join(CATALOG_STORAGE_DIR, img.image_path));
      } catch { /* já foi */ }
    }
  }
  await getPool().query(
    `UPDATE catalog_images SET status = 'rejeitada', image_path = '', reviewed_by = ?, reviewed_at = NOW(3) WHERE id IN (${placeholders})`,
    [req.adminUsername, ...ids],
  );
  res.redirect('/admin/catalog' + (req.body?.redirectStatus === 'aprovada' ? '?status=aprovada' : ''));
});

/**
 * Exclusão em massa: apaga todas as imagens de um status específico (pendente ou aprovada).
 * 1. Valida o parâmetro status
 * 2. Busca todas as imagens do status
 * 3. Deleta os arquivos de disco
 * 4. Remove os registros do banco (DELETE real — permite re-upload do mesmo conteúdo)
 * 5. Registra em log a ação do admin
 */
router.post('/catalog/delete-all', requireAdminAuth, async (req: AdminRequest, res) => {
  const status = String(req.body?.status ?? '');
  if (status !== 'pendente' && status !== 'aprovada') {
    res.redirect('/admin/catalog');
    return;
  }

  const pool = getPool();
  const [rows] = await pool.query(
    'SELECT id, image_path FROM catalog_images WHERE status = ?',
    [status],
  );
  const images = rows as { id: number; image_path: string }[];

  if (!images.length) {
    res.redirect('/admin/catalog?status=' + status);
    return;
  }

  const count = images.length;
  let deletedFiles = 0;

  for (const img of images) {
    if (img.image_path) {
      try {
        fs.unlinkSync(path.join(CATALOG_STORAGE_DIR, img.image_path));
        deletedFiles++;
      } catch {
        // arquivo já não existe — segue o jogo
      }
    }
  }

  await pool.query('DELETE FROM catalog_images WHERE status = ?', [status]);

  console.log(
    `[CATALOG DELETE-ALL] admin=${req.adminUsername} status=${status} count=${count} files_deleted=${deletedFiles} at=${new Date().toISOString()}`,
  );

  res.redirect('/admin/catalog?status=' + status + '&deleted=' + count);
});

/**
 * Upload manual do admin: some direto pro catálogo aprovado (bootstrap do banco de
 * imagens). Responde JSON, não HTML — o corpo é binário (mesma técnica de /api/catalog/submit),
 * então o formulário no catalog-queue.ejs é 100% orientado a `fetch`, sem <form> nativo.
 */
router.post('/catalog/manual', rawCatalogImage, requireAdminAuth, async (req: AdminRequest, res) => {
  const productName = req.header('X-Kivo-Product-Name');
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

// --- Leads do formulário de contato da landing ---

const LEAD_STATUSES = ['novo', 'contatado', 'convertido', 'descartado'] as const;

/** JSON endpoint para polling da lista de leads. */
router.get('/leads/api/list', requireAdminAuth, async (_req, res) => {
  const [leads] = await getPool().query('SELECT * FROM contact_leads ORDER BY created_at DESC');
  res.json({ leads });
});

router.get('/leads', requireAdminAuth, async (_req, res) => {
  const [leads] = await getPool().query('SELECT * FROM contact_leads ORDER BY created_at DESC');
  res.render('leads', { leads });
});

router.post('/leads/:id/status', requireAdminAuth, async (req, res) => {
  const status = String(req.body?.status ?? '');
  if (!(LEAD_STATUSES as readonly string[]).includes(status)) {
    return res.status(400).send('Status inválido.');
  }
  // contacted_at marca o primeiro contato e não regride ao alternar o status depois.
  await getPool().query(
    `UPDATE contact_leads
       SET status = ?, contacted_at = IF(? = 'contatado' AND contacted_at IS NULL, NOW(3), contacted_at)
     WHERE id = ?`,
    [status, status, Number(req.params.id)],
  );
  res.redirect('/admin/leads');
});

router.post('/leads/:id/delete', requireAdminAuth, async (req, res) => {
  await getPool().query('DELETE FROM contact_leads WHERE id = ?', [Number(req.params.id)]);
  res.redirect('/admin/leads');
});

// --- Notificações em tempo real (consumido pelo Alpine.js do painel) ---

router.get('/api/notifications', requireAdminAuth, async (_req, res) => {
  const pool = getPool();
  const [ticketRows] = await pool.query(
    'SELECT COUNT(*) AS cnt FROM support_tickets WHERE admin_unread > 0',
  );
  const [leadRows] = await pool.query(
    "SELECT COUNT(*) AS cnt FROM contact_leads WHERE status = 'novo'",
  );
  const [recentTickets] = await pool.query(
    `SELECT t.id, t.subject, t.admin_unread, t.last_message_at, c.name AS company_name
       FROM support_tickets t
       LEFT JOIN companies c ON c.company_uuid = t.company_uuid
      WHERE t.admin_unread > 0
      ORDER BY t.last_message_at DESC
      LIMIT 5`,
  );
  const [recentLeads] = await pool.query(
    `SELECT id, name, whatsapp, created_at
       FROM contact_leads
      WHERE status = 'novo'
      ORDER BY created_at DESC
      LIMIT 5`,
  );
  res.json({
    unreadTickets: Number((ticketRows as { cnt: number }[])[0]?.cnt ?? 0),
    newLeads: Number((leadRows as { cnt: number }[])[0]?.cnt ?? 0),
    recentTickets: recentTickets as { id: number; subject: string; admin_unread: number; last_message_at: string; company_name: string | null }[],
    recentLeads: recentLeads as { id: number; name: string; whatsapp: string; created_at: string }[],
  });
});

// --- Suporte: tickets do chat do app ---

const TICKET_STATUSES = ['aberto', 'fechado', 'arquivado'] as const;

/** JSON endpoint para polling da lista de tickets (consumido pelo Alpine.js sem recarregar a página). */
router.get('/support/api/tickets', requireAdminAuth, async (_req, res) => {
  const [tickets] = await getPool().query(
    `SELECT t.*, c.name AS company_name
       FROM support_tickets t
       LEFT JOIN companies c ON c.company_uuid = t.company_uuid
      ORDER BY t.last_message_at DESC`,
  );
  res.json({ tickets });
});

/** JSON endpoint para polling das mensagens de um ticket (recarregamento automático). */
router.get('/support/api/tickets/:id/messages', requireAdminAuth, async (req, res) => {
  const [tickets] = await getPool().query(
    `SELECT t.*, c.name AS company_name
       FROM support_tickets t
       LEFT JOIN companies c ON c.company_uuid = t.company_uuid
      WHERE t.id = ?`,
    [Number(req.params.id)],
  );
  const ticket = (tickets as { id: number; subject: string; status: string; company_name: string | null; admin_unread: number }[])[0];
  if (!ticket) return res.status(404).json({ error: 'Ticket não encontrado.' });
  const [messages] = await getPool().query(
    'SELECT id, sender, sender_name, body, attachment, created_at FROM support_messages WHERE ticket_id = ? ORDER BY id',
    [ticket.id],
  );
  if (ticket.admin_unread > 0) {
    await getPool().query('UPDATE support_tickets SET admin_unread = 0 WHERE id = ?', [ticket.id]);
  }
  res.json({ ticket: { id: ticket.id, subject: ticket.subject, status: ticket.status }, messages });
});

router.get('/support', requireAdminAuth, async (_req, res) => {
  const [tickets] = await getPool().query(
    `SELECT t.*, c.name AS company_name
       FROM support_tickets t
       LEFT JOIN companies c ON c.company_uuid = t.company_uuid
      ORDER BY t.last_message_at DESC`,
  );
  res.render('support', { tickets });
});

router.get('/support/:id', requireAdminAuth, async (req, res) => {
  const pool = getPool();
  const [tickets] = await pool.query(
    `SELECT t.*, c.name AS company_name
       FROM support_tickets t
       LEFT JOIN companies c ON c.company_uuid = t.company_uuid
      WHERE t.id = ?`,
    [Number(req.params.id)],
  );
  const ticket = (tickets as { id: number; admin_unread: number }[])[0];
  if (!ticket) return res.status(404).send('Ticket não encontrado.');
  const [messages] = await pool.query(
    'SELECT id, sender, sender_name, body, attachment, created_at FROM support_messages WHERE ticket_id = ? ORDER BY id',
    [ticket.id],
  );
  if (ticket.admin_unread > 0) {
    await pool.query('UPDATE support_tickets SET admin_unread = 0 WHERE id = ?', [ticket.id]);
  }
  res.render('support-detail', { ticket, messages });
});

router.post('/support/:id/reply', requireAdminAuth, async (req: AdminRequest, res) => {
  const id = Number(req.params.id);
  const body = String(req.body?.body ?? '').trim();
  if (!body || body.length > 4000) return res.status(400).send('Mensagem vazia ou longa demais.');
  const [tickets] = await getPool().query('SELECT id, status FROM support_tickets WHERE id = ?', [id]);
  const ticket = (tickets as { id: number; status: string }[])[0];
  if (!ticket) return res.status(404).send('Ticket não encontrado.');
  await getPool().query(
    'INSERT INTO support_messages (ticket_id, sender, sender_name, body) VALUES (?, ?, ?, ?)',
    [id, 'suporte', req.adminUsername ?? 'suporte', body],
  );
  // Responder um ticket fechado reabre a conversa (arquivado permanece arquivado
  // até o admin mudar o status de propósito).
  await getPool().query(
    `UPDATE support_tickets
        SET client_unread = client_unread + 1, last_message_at = NOW(3),
            status = IF(status = 'fechado', 'aberto', status)
      WHERE id = ?`,
    [id],
  );
  res.redirect(`/admin/support/${id}`);
});

router.post('/support/:id/status', requireAdminAuth, async (req, res) => {
  const status = String(req.body?.status ?? '');
  if (!(TICKET_STATUSES as readonly string[]).includes(status)) return res.status(400).send('Status inválido.');
  await getPool().query('UPDATE support_tickets SET status = ? WHERE id = ?', [status, Number(req.params.id)]);
  res.redirect(`/admin/support/${Number(req.params.id)}`);
});

export default router;
