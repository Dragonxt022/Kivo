import { randomUUID, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { getPool } from '../db';
import { hashLicenseKey } from '../auth';
import { PLAN_TIERS, PLAN_LABELS, trialValidUntil } from '../plans';
import {
  verifyAdminCredentials,
  createAdminSession,
  destroyAdminSession,
  requireAdminAuth,
  readAdminCookie,
  ADMIN_SESSION_COOKIE,
  type AdminRequest,
} from '../adminAuth';

const router = Router();

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

  return { company, syncStats, backups, charges };
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
  const [companies] = await getPool().query(
    `SELECT c.company_uuid, c.name, c.plan, c.modules, c.valid_until,
            (SELECT COUNT(*) FROM sync_records sr WHERE sr.company_uuid = c.company_uuid) AS sync_count,
            (SELECT MAX(server_received_at) FROM sync_records sr WHERE sr.company_uuid = c.company_uuid) AS last_activity,
            (SELECT COALESCE(SUM(amount_cents),0) FROM charges ch WHERE ch.company_uuid = c.company_uuid AND ch.status = 'pendente') AS pending_cents
     FROM companies c ORDER BY c.created_at DESC`,
  );
  res.render('dashboard', { companies, planTiers: PLAN_TIERS, planLabels: PLAN_LABELS });
});

router.post('/companies', requireAdminAuth, async (req: AdminRequest, res) => {
  const { name, plan, modules, validUntil } = req.body ?? {};
  const companyUuid = randomUUID();
  const licenseKey = generateLicenseKey();
  const modulesList = parseModules(modules);
  await getPool().query(
    'INSERT INTO companies (company_uuid, license_key_hash, name, plan, modules, valid_until) VALUES (?, ?, ?, ?, CAST(? AS JSON), ?)',
    [
      companyUuid,
      hashLicenseKey(licenseKey),
      name || null,
      plan || null,
      modulesList.length ? JSON.stringify(modulesList) : null,
      resolveValidUntil(plan || null, validUntil),
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
  const { name, plan, modules, validUntil } = req.body ?? {};
  const modulesList = parseModules(modules);
  await getPool().query(
    'UPDATE companies SET name = ?, plan = ?, modules = CAST(? AS JSON), valid_until = ? WHERE company_uuid = ?',
    [name || null, plan || null, modulesList.length ? JSON.stringify(modulesList) : null, resolveValidUntil(plan || null, validUntil), uuid],
  );
  res.redirect(`/admin/companies/${uuid}`);
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

export default router;
