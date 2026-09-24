import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import express, { Router } from 'express';
import { getPool } from '../db';
import { hashLicenseKey } from '../auth';
import { emitToCompany } from '../events';
import { PLAN_TIERS, PLAN_LABELS, trialValidUntil } from '../plans';
import {
  accrueCommissionForCharge,
  affiliateSummary,
  createPayoutFromAvailable,
  payPayout,
  cancelPayout,
  reverseChargePayment,
  reversePayout,
} from '../affiliates';
import { sendTestEmail, sendPasswordResetEmail, smtpConfigFromBody } from '../mailer';
import { searchPexels } from '../imageApi';
import { createRateLimiter } from '../rateLimit';
import { hashAffiliatePassword } from '../affiliateAuth';
import { validateCatalogImage, normalizeKeywords } from '../catalogValidation';
import { expectedResponse } from '../recoveryCodes';
import { CATALOG_STORAGE_DIR, CATALOG_EXT_BY_FORMAT, CATALOG_MIME_BY_FORMAT } from './catalog';
import { THEMES_STORAGE_DIR } from './themes';
import { listDevDocs, renderDevDoc } from '../devdocs';
import { currentPeriod } from '../aiUsage';
import { listTools, setCompanyLimit, updateTool } from '../aiQuota';
import { loadAiConfig, loadAiSettingsForView } from '../aiConfig';
import { chat as aiProviderChat, defaultModelFor, isProviderId, keyFor, listOllamaModels, PROVIDER_LABELS } from '../aiProviders';
import {
  hasAnyAdmin,
  verifyAdminCredentials,
  createAdminSession,
  destroyAdminSession,
  requireAdminAuth,
  isAdminAuthenticated,
  readAdminCookie,
  hashPassword,
  findAdminByIdentity,
  setAdminEmail,
  setAdminPassword,
  destroyAdminSessionsFor,
  createPasswordReset,
  validatePasswordReset,
  consumePasswordReset,
  ADMIN_SESSION_COOKIE,
  type AdminRequest,
} from '../adminAuth';

const router = Router();
const rawCatalogImage = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'image/avif'], limit: '6mb' });

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
  licensed_version: string | null;
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

  // Diagnóstico: erros anônimos agrupados + inventário de hardware desta empresa.
  const [errorRows] = await pool.query(
    `SELECT fingerprint, MAX(scope) AS scope, MAX(level) AS level, MAX(message) AS message,
            MAX(stack) AS stack, SUM(occurrences) AS total, COUNT(DISTINCT machine_id) AS devices,
            MAX(last_seen_at) AS last_seen_at
       FROM client_error_reports WHERE company_uuid = ?
       GROUP BY fingerprint ORDER BY last_seen_at DESC LIMIT 100`,
    [companyUuid],
  );
  const [inventoryRows] = await pool.query(
    `SELECT machine_id, data, os, cpu, ram_gb, app_version, last_seen_at
       FROM client_machine_inventory WHERE company_uuid = ? ORDER BY last_seen_at DESC`,
    [companyUuid],
  );
  const inventory = (inventoryRows as Record<string, unknown>[]).map((m) => ({
    ...(m as unknown as { machine_id: string; os: string | null; cpu: string | null; ram_gb: number | null; app_version: string | null; last_seen_at: string }),
    data: typeof m.data === 'string' ? safeJson(m.data) : m.data,
  }));

  // Afiliados disponíveis para vincular na aba Licença (programa de indicação):
  // o desconto é para a empresa, a comissão é o que o afiliado ganha.
  const [affiliates] = await pool.query(
    'SELECT id, name, city, discount_pct, commission_pct, active FROM affiliates ORDER BY active DESC, name',
  );

  return { company, syncStats, backups, charges, devices, errors: errorRows, inventory, affiliates };
}

// --- Autenticação ---

router.get('/login', async (req, res) => {
  if (!(await hasAnyAdmin())) {
    res.redirect('/admin/setup');
    return;
  }
  // Já autenticado: pula o formulário e vai direto ao painel.
  if (await isAdminAuthenticated(req)) {
    res.redirect('/admin');
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
  const token = await createAdminSession(String(username));
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
  const token = await createAdminSession(String(username));
  res.cookie(ADMIN_SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax' });
  res.redirect('/admin');
});

router.post('/logout', async (req, res) => {
  await destroyAdminSession(readAdminCookie(req));
  res.clearCookie(ADMIN_SESSION_COOKIE);
  res.redirect('/admin/login');
});

// --- Recuperação de senha (link por e-mail) ---

/** Freia o formulário de recuperação por IP: 5 pedidos a cada 15 min. */
const forgotLimiter = createRateLimiter({ windowMs: 15 * 60e3, max: 5, keyPrefix: 'forgot:' });

/** URL base para montar o link do e-mail, respeitando o proxy (x-forwarded-proto). */
function requestBaseUrl(req: import('express').Request): string {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || req.protocol;
  return `${proto}://${req.get('host')}`;
}

router.get('/forgot', async (_req, res) => {
  if (!(await hasAnyAdmin())) {
    res.redirect('/admin/setup');
    return;
  }
  res.render('forgot-password', { error: null, success: null });
});

router.post('/forgot', async (req, res) => {
  if (!(await hasAnyAdmin())) {
    res.redirect('/admin/setup');
    return;
  }
  if (forgotLimiter(req.ip ?? 'unknown')) {
    res
      .status(429)
      .render('forgot-password', { error: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.', success: null });
    return;
  }
  const identity = String(req.body?.identity ?? '').trim();
  if (!identity) {
    res.status(400).render('forgot-password', { error: 'Informe o usuário ou o e-mail.', success: null });
    return;
  }
  // Resposta sempre genérica: não confirma se a conta existe (evita enumeração de usuários).
  const generic = 'Se existir uma conta com esse usuário/e-mail e ela tiver um e-mail cadastrado, enviamos um link de redefinição.';
  const admin = await findAdminByIdentity(identity);
  if (admin?.email) {
    try {
      const token = await createPasswordReset(admin.username);
      const url = `${requestBaseUrl(req)}/admin/reset-password?token=${token}`;
      await sendPasswordResetEmail(admin.email, url);
    } catch (err) {
      // Falha de SMTP não pode virar oráculo de existência de conta: loga e segue genérico.
      console.error('[admin] falha ao enviar e-mail de recuperação:', err);
    }
  }
  res.render('forgot-password', { error: null, success: generic });
});

router.get('/reset-password', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const valid = await validatePasswordReset(token);
  res.render('reset-password', {
    token,
    valid,
    error: valid ? null : 'Link inválido ou expirado. Peça um novo.',
    success: null,
  });
});

router.post('/reset-password', async (req, res) => {
  const token = String(req.body?.token ?? '');
  const newPassword = String(req.body?.newPassword ?? '');
  const confirmPassword = String(req.body?.confirmPassword ?? '');
  const valid = await validatePasswordReset(token);
  const render = (error: string | null, success: string | null = null) =>
    res.render('reset-password', { token, valid: valid || Boolean(success), error, success });

  if (!valid) {
    render('Link inválido ou expirado. Peça um novo.');
    return;
  }
  if (!newPassword || !confirmPassword) {
    render('Preencha os dois campos.');
    return;
  }
  if (newPassword !== confirmPassword) {
    render('As senhas não conferem.');
    return;
  }
  if (newPassword.length < 8) {
    render('A nova senha precisa ter pelo menos 8 caracteres.');
    return;
  }
  const username = await consumePasswordReset(token);
  if (!username) {
    render('Link inválido ou expirado. Peça um novo.');
    return;
  }
  await setAdminPassword(username, newPassword);
  // Trocar a senha derruba as sessões abertas desse usuário.
  await destroyAdminSessionsFor(username);
  render(null, 'Senha redefinida! Você já pode entrar com a nova senha.');
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

router.get('/companies', requireAdminAuth, async (req, res) => {
  res.render('companies', {
    companies: await loadCompaniesList(),
    planTiers: PLAN_TIERS,
    planLabels: PLAN_LABELS,
    ok: typeof req.query.ok === 'string' ? req.query.ok : null,
  });
});

/** Exporta a lista de empresas em CSV (o Excel brasileiro abre com `;` e BOM). */
router.get('/companies/export.csv', requireAdminAuth, async (_req, res) => {
  const rows = (await loadCompaniesList()) as Record<string, unknown>[];
  const columns = ['company_uuid', 'name', 'plan', 'valid_until', 'sync_count', 'last_activity', 'pending_cents'];
  const cell = (v: unknown): string => {
    const s = v == null ? '' : String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(';'), ...rows.map((r) => columns.map((c) => cell(r[c])).join(';'))];
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="empresas-${stamp}.csv"`);
  res.send('\uFEFF' + lines.join('\r\n'));
});

// ─── KIVO IA: uso, créditos e gráficos ─────────────────────────────────────────
const AI_PIE_COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#ec4899'];

router.get('/ai', requireAdminAuth, async (_req: AdminRequest, res) => {
  const pool = getPool();
  const period = currentPeriod();

  const [kpiRows] = await pool.query(
    `SELECT COALESCE(SUM(total_tokens),0) AS tokens, COUNT(*) AS requests,
            COUNT(DISTINCT company_uuid) AS companies
       FROM ai_usage WHERE period = ?`,
    [period],
  );
  const kpi = (kpiRows as { tokens: number; requests: number; companies: number }[])[0];

  // Barras: tokens por dia nos últimos 14 dias (série contínua, preenchendo dias sem uso).
  const [dayRows] = await pool.query(
    `SELECT DATE(created_at) AS d, COALESCE(SUM(total_tokens),0) AS tokens
       FROM ai_usage WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
      GROUP BY DATE(created_at)`,
  );
  const byDay = new Map<string, number>();
  for (const r of dayRows as { d: string | Date; tokens: number }[]) {
    const key = String(r.d).slice(0, 10);
    byDay.set(key, Number(r.tokens));
  }
  const bars: { label: string; tokens: number; pct: number }[] = [];
  let maxDay = 1;
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const tokens = byDay.get(key) ?? 0;
    if (tokens > maxDay) maxDay = tokens;
    bars.push({ label: key.slice(8, 10) + '/' + key.slice(5, 7), tokens, pct: 0 });
  }
  for (const b of bars) b.pct = Math.round((b.tokens / maxDay) * 100);

  // Pizza: tokens por empresa no período (top 8) + "Outros".
  const [companyRows] = await pool.query(
    `SELECT u.company_uuid, COALESCE(c.name, u.company_uuid) AS name, COALESCE(SUM(u.total_tokens),0) AS tokens
       FROM ai_usage u LEFT JOIN companies c ON c.company_uuid = u.company_uuid
      WHERE u.period = ? GROUP BY u.company_uuid, c.name ORDER BY tokens DESC`,
    [period],
  );
  const companiesUsage = (companyRows as { company_uuid: string; name: string; tokens: number }[]).map((r) => ({
    uuid: r.company_uuid, name: r.name, tokens: Number(r.tokens),
  }));
  const pieTotal = companiesUsage.reduce((a, r) => a + r.tokens, 0);
  const pieTop = companiesUsage.slice(0, 8);
  const outros = companiesUsage.slice(8).reduce((a, r) => a + r.tokens, 0);
  const pieSource = outros > 0 ? [...pieTop, { uuid: '', name: 'Outros', tokens: outros }] : pieTop;
  let offset = 25;
  const pie = pieSource.map((r, i) => {
    const pct = pieTotal > 0 ? (r.tokens / pieTotal) * 100 : 0;
    const seg = { name: r.name, tokens: r.tokens, pct: Math.round(pct * 10) / 10, offset, color: AI_PIE_COLORS[i % AI_PIE_COLORS.length] };
    offset -= pct;
    return seg;
  });

  // Tabela: consumo e teto por empresa.
  const [companyListRows] = await pool.query(
    `SELECT company_uuid, name, plan, ai_token_limit, ai_tokens_used,
            CASE WHEN ai_period = ? THEN ai_tokens_used ELSE 0 END AS used_period
       FROM companies ORDER BY used_period DESC, name LIMIT 200`,
    [period],
  );

  // Ferramentas pagas (cota diária) + override por empresa.
  const tools = await listTools();
  const toolFeature = tools[0]?.id ?? 'product_description';
  const [quotaRows] = await pool.query(
    'SELECT company_uuid, daily_limit FROM company_ai_quotas WHERE feature = ?',
    [toolFeature],
  );
  const quotaByCompany = Object.fromEntries(
    (quotaRows as { company_uuid: string; daily_limit: number | null }[]).map((q) => [q.company_uuid, q.daily_limit]),
  );

  res.render('ai-usage', {
    adminUsername: _req.adminUsername,
    period,
    kpi: { tokens: Number(kpi.tokens), requests: Number(kpi.requests), companies: Number(kpi.companies) },
    bars,
    pie,
    pieTotal,
    tools,
    toolFeature,
    companies: (companyListRows as Record<string, unknown>[]).map((c) => ({
      uuid: c.company_uuid, name: c.name, plan: c.plan,
      limit: Number(c.ai_token_limit), used: Number(c.used_period),
      quota: quotaByCompany[String(c.company_uuid)] ?? null,
    })),
    ok: typeof _req.query.ok === 'string' ? _req.query.ok : null,
  });
});

/** Salva o custo/cota diária/ativo de uma ferramenta de IA paga. */
router.post('/ai/tools/:id', requireAdminAuth, async (req, res) => {
  const id = String(req.params.id);
  const b = (req.body ?? {}) as Record<string, unknown>;
  await updateTool(id, {
    cost: b.cost !== undefined ? Number(b.cost) : undefined,
    dailyCredits: b.dailyCredits !== undefined ? Number(b.dailyCredits) : undefined,
    enabled: b.enabled === '1' || b.enabled === true,
  });
  res.redirect('/admin/ai?ok=' + encodeURIComponent('Ferramenta salva.'));
});

/** Define o limite diário específico de uma empresa (vazio = usa o padrão da ferramenta). */
router.post('/ai/:uuid/quota/:feature', requireAdminAuth, async (req, res) => {
  const uuid = String(req.params.uuid);
  const feature = String(req.params.feature);
  const raw = String((req.body as { dailyLimit?: unknown })?.dailyLimit ?? '').trim();
  const dailyLimit = raw === '' ? null : Math.max(0, Math.floor(Number(raw.replace(',', '.')) || 0));
  await setCompanyLimit(uuid, feature, dailyLimit);
  res.redirect('/admin/ai?ok=' + encodeURIComponent('Cota da empresa atualizada.'));
});

router.post('/ai/:uuid/limit', requireAdminAuth, async (req: AdminRequest, res) => {
  const uuid = String(req.params.uuid);
  const raw = Number((req.body as { limitTokens?: unknown })?.limitTokens ?? 0);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  await getPool().query('UPDATE companies SET ai_token_limit = ? WHERE company_uuid = ?', [limit, uuid]);
  res.redirect('/admin/ai');
});

// Documentação técnica (regras de negócio por módulo) — mesmo conteúdo Markdown do app
// local (src/docs/dev). Só admin autenticado (requireAdminAuth).
router.get('/documentacao', requireAdminAuth, (req: AdminRequest, res) => {
  const docs = listDevDocs();
  const requested = typeof req.query.doc === 'string' ? req.query.doc : '';
  const current = renderDevDoc(requested || 'index')
    ?? (docs[0] ? renderDevDoc(docs[0].slug) : null)
    ?? { slug: '', title: 'Documentação', summary: null, html: '<p>Nenhum documento disponível.</p>' };
  res.render('devdocs', { adminUsername: req.adminUsername, docs, current });
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
  const kpis = (kpiRows as Record<string, unknown>[])[0];

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

  // ─── Alertas extras: inatividade, licenças vencidas e erros recentes ───
  const [companyNameRows] = await pool.query('SELECT company_uuid, name FROM companies');
  const companyNames = new Map(
    (companyNameRows as { company_uuid: string; name: string | null }[]).map((c) => [c.company_uuid, c.name]),
  );

  const [inactiveRows] = await pool.query(
    `SELECT c.company_uuid, c.name, MAX(sr.server_received_at) AS last_activity
       FROM companies c JOIN sync_records sr ON sr.company_uuid = c.company_uuid
       GROUP BY c.company_uuid, c.name
       HAVING MAX(sr.server_received_at) < DATE_SUB(NOW(), INTERVAL 7 DAY)
       ORDER BY last_activity ASC LIMIT 5`,
  );
  for (const r of inactiveRows as { company_uuid: string; name: string | null; last_activity: string }[]) {
    alerts.push({
      type: 'warning', icon: 'pause',
      title: r.name || r.company_uuid.slice(0, 8),
      detail: `sem sincronizar desde ${String(r.last_activity).slice(0, 10)}`,
      link: `/admin/companies/${r.company_uuid}`,
    });
  }

  const [expiredRows] = await pool.query(
    `SELECT name, company_uuid, valid_until FROM companies
      WHERE valid_until IS NOT NULL AND valid_until < NOW()
      ORDER BY valid_until DESC LIMIT 5`,
  );
  for (const e of expiredRows as { name: string | null; company_uuid: string; valid_until: string }[]) {
    alerts.push({
      type: 'danger', icon: 'clock',
      title: e.name || e.company_uuid.slice(0, 8),
      detail: `licença vencida em ${String(e.valid_until).slice(0, 10)}`,
      link: `/admin/companies/${e.company_uuid}`,
    });
  }

  const [errorCompanyRows] = await pool.query(
    `SELECT company_uuid, SUM(occurrences) AS total, MAX(last_seen_at) AS last_seen
       FROM client_error_reports WHERE last_seen_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
       GROUP BY company_uuid ORDER BY total DESC LIMIT 5`,
  );
  for (const e of errorCompanyRows as { company_uuid: string; total: number; last_seen: string }[]) {
    alerts.push({
      type: 'warning', icon: 'alert',
      title: `Erros: ${companyNames.get(e.company_uuid) || e.company_uuid.slice(0, 8)}`,
      detail: `${e.total} ocorrência(s) nos últimos 7 dias`,
      link: `/admin/companies/${e.company_uuid}#diagnostico`,
    });
  }

  // ─── Métricas comerciais ───
  const [mrrRows] = await pool.query(
    `SELECT COALESCE(SUM(amount_cents), 0) AS cents, COUNT(*) AS n
       FROM charges WHERE status = 'paga' AND paid_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`,
  );
  const mrr = (mrrRows as { cents: number; n: number }[])[0];
  const [commercialRows] = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM trial_registry) AS trials,
       (SELECT COUNT(*) FROM trial_registry tr JOIN companies c ON c.company_uuid = tr.company_uuid
          WHERE c.plan IN ('prata','ouro','diamante')) AS converted,
       (SELECT COUNT(*) FROM companies WHERE valid_until IS NOT NULL AND valid_until < NOW() AND plan <> 'trial') AS churned,
       (SELECT COUNT(*) FROM (
          SELECT c.company_uuid FROM companies c JOIN sync_records sr ON sr.company_uuid = c.company_uuid
          GROUP BY c.company_uuid HAVING MAX(sr.server_received_at) < DATE_SUB(NOW(), INTERVAL 30 DAY)
        ) t) AS inactive`,
  );
  const cr = (commercialRows as { trials: number; converted: number; churned: number; inactive: number }[])[0];
  const commercial = {
    revenue30dCents: Number(mrr?.cents || 0),
    paidCount30d: Number(mrr?.n || 0),
    trials: Number(cr?.trials || 0),
    converted: Number(cr?.converted || 0),
    churned: Number(cr?.churned || 0),
    inactive: Number(cr?.inactive || 0),
  };

  // Mais grave primeiro; a lista é longa (inatividade, vencidas, erros...) e virava um
  // paredão — o painel mostra os 8 principais.
  const severity: Record<string, number> = { danger: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => (severity[a.type] ?? 3) - (severity[b.type] ?? 3));

  // ─── Cobranças: o controle de faturamento do negócio ───
  const [billingRows] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'pendente' THEN amount_cents END), 0) AS pending_cents,
       COALESCE(SUM(CASE WHEN status = 'pendente' AND due_date < CURDATE() THEN amount_cents END), 0) AS overdue_cents,
       COALESCE(SUM(CASE WHEN status = 'paga' AND paid_at >= DATE_FORMAT(NOW(), '%Y-%m-01') THEN amount_cents END), 0) AS paid_month_cents,
       COALESCE(SUM(CASE WHEN status = 'paga' AND paid_at >= DATE_FORMAT(NOW(), '%Y-%m-01') THEN discount_cents END), 0) AS discount_month_cents,
       COUNT(CASE WHEN status = 'pendente' THEN 1 END) AS pending_count,
       COUNT(CASE WHEN status = 'pendente' AND due_date < CURDATE() THEN 1 END) AS overdue_count
     FROM charges`,
  );
  const billing = (billingRows as Record<string, number>[])[0] ?? {};
  const [upcomingRows] = await pool.query(
    `SELECT ch.id, ch.description, ch.amount_cents, ch.due_date, c.name AS company_name, c.company_uuid
       FROM charges ch LEFT JOIN companies c ON c.company_uuid = ch.company_uuid
      WHERE ch.status = 'pendente'
      ORDER BY ch.due_date ASC LIMIT 5`,
  );
  const upcomingCharges = upcomingRows as {
    id: number;
    description: string;
    amount_cents: number;
    due_date: string;
    company_name: string | null;
    company_uuid: string;
  }[];

  // ─── Afiliados: comissões a pagar e previsão ───
  const [affRows] = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM affiliates WHERE active = 1) AS active_affiliates,
       (SELECT COALESCE(SUM(amount_cents), 0) FROM affiliate_commissions WHERE status = 'disponivel') AS available_cents,
       (SELECT COALESCE(SUM(amount_cents), 0) FROM affiliate_commissions WHERE status = 'solicitado') AS requested_cents,
       (SELECT COALESCE(SUM(amount_cents), 0) FROM affiliate_commissions
         WHERE status = 'pago' AND paid_at >= DATE_FORMAT(NOW(), '%Y-%m-01')) AS paid_month_cents,
       (SELECT COUNT(*) FROM affiliate_payouts WHERE status = 'solicitado') AS requested_count,
       (SELECT COALESCE(SUM(ROUND(ch.amount_cents * a.commission_pct / 100)), 0)
          FROM companies c JOIN affiliates a ON a.id = c.affiliate_id
          JOIN charges ch ON ch.company_uuid = c.company_uuid AND ch.status = 'pendente') AS forecast_cents`,
  );
  const affiliateStats = (affRows as Record<string, number>[])[0] ?? {};

  const [payoutAlerts] = await pool.query(
    `SELECT p.id, p.amount_cents, a.name AS affiliate_name
       FROM affiliate_payouts p LEFT JOIN affiliates a ON a.id = p.affiliate_id
      WHERE p.status = 'solicitado' ORDER BY p.id DESC LIMIT 5`,
  );
  for (const p of payoutAlerts as { id: number; amount_cents: number; affiliate_name: string | null }[]) {
    alerts.push({
      type: 'warning', icon: 'money',
      title: `Pagamento a ${p.affiliate_name || 'afiliado'}`,
      detail: `R$ ${(Number(p.amount_cents) / 100).toFixed(2)} aguardando confirmação`,
      link: '/admin/payouts',
    });
  }
  if (Number(affiliateStats.available_cents || 0) > 0) {
    alerts.push({
      type: 'info', icon: 'money',
      title: 'Comissões de afiliados disponíveis',
      detail: `R$ ${(Number(affiliateStats.available_cents) / 100).toFixed(2)} a pagar`,
      link: '/admin/commissions?status=disponivel',
    });
  }

  res.render('dashboard', {
    planTiers: PLAN_TIERS, planLabels: PLAN_LABELS,
    kpis, planDistribution, recentActivity, alerts: alerts.slice(0, 8), syncTrend, revenueTrend, commercial,
    billing, upcomingCharges, affiliateStats,
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
  res.render('company-detail', {
    ...detail,
    revealedLicenseKey: null,
    planTiers: PLAN_TIERS,
    planLabels: PLAN_LABELS,
    ok: typeof req.query.ok === 'string' ? req.query.ok : null,
    error: typeof req.query.error === 'string' ? req.query.error : null,
  });
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
  const { plan, modules, validUntil, maxDevices, licensedVersion, affiliateId } = req.body ?? {};
  const modulesList = parseModules(modules);
  await getPool().query(
    'UPDATE companies SET plan = ?, modules = CAST(? AS JSON), valid_until = ?, max_devices = ?, licensed_version = ?, affiliate_id = ? WHERE company_uuid = ?',
    [
      plan || null,
      modulesList.length ? JSON.stringify(modulesList) : null,
      resolveValidUntil(plan || null, validUntil),
      maxDevices ? Math.max(1, Number(maxDevices)) : 1,
      textOrNull(licensedVersion),
      affiliateId ? Number(affiliateId) : null,
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
 * precisar abrir empresa por empresa procurando uma máquina específica. Junto vai o
 * registro de testes grátis já reivindicados — é o que decide se uma máquina consegue
 * pedir trial de novo, e sem essa lista não havia como o suporte enxergar (nem soltar)
 * uma marca deixada por uma empresa que já foi excluída. */
router.get('/devices', requireAdminAuth, async (_req, res) => {
  const pool = getPool();
  const [devices] = await pool.query(
    `SELECT cd.id, cd.company_uuid, cd.machine_id, cd.first_seen_at, cd.last_seen_at, cd.removed_at,
            c.name AS company_name, c.plan AS company_plan
     FROM company_devices cd
     JOIN companies c ON c.company_uuid = cd.company_uuid
     ORDER BY cd.last_seen_at DESC`,
  );
  // O cruzamento trial → empresa é feito aqui, não em SQL: `trial_registry` nasceu (0015)
  // com collation diferente do resto do schema, e um JOIN com `companies` estourava
  // ER_CANT_AGGREGATE_2COLLATIONS em produção. A 0017 alinha as duas, mas esta tela não
  // pode depender de a migração ter rodado — o deploy reinicia o PM2 mesmo se o
  // `npm run migrate` falhar, e aí a página cairia inteira por causa de uma lista lateral.
  // O volume é de uma linha por máquina que já pediu trial: casar em memória sai de graça.
  const [trialRows] = await pool.query(
    'SELECT machine_id_hash, company_uuid, claimed_at FROM trial_registry ORDER BY claimed_at DESC',
  );
  const [companyRows] = await pool.query('SELECT company_uuid, name FROM companies');
  // Map só das empresas VIVAS: a ausência da chave é o que marca a linha como órfã —
  // `companies.name` é nullable e não serve para isso (nome vazio ≠ empresa excluída).
  const companyNames = new Map(
    (companyRows as { company_uuid: string; name: string | null }[]).map((c) => [c.company_uuid, c.name]),
  );
  const trials = (trialRows as { machine_id_hash: string; company_uuid: string; claimed_at: string }[]).map((t) => ({
    ...t,
    company_name: companyNames.get(t.company_uuid) ?? null,
    company_exists: companyNames.has(t.company_uuid),
  }));
  res.render('devices', { devices, trials, planLabels: PLAN_LABELS });
});

/** Libera o teste grátis de uma máquina: apaga a marca em `trial_registry` e ela volta
 * a poder pedir os 15 dias. Decisão de suporte (mesmo espírito de liberar a vaga de um
 * dispositivo) — o cliente não alcança essa rota. */
router.post('/trials/:machineId/release', requireAdminAuth, async (req: AdminRequest, res) => {
  const machineId = String(req.params.machineId);
  await getPool().query('DELETE FROM trial_registry WHERE machine_id_hash = ?', [machineId]);
  console.log(`[TRIAL RELEASE] admin=${req.adminUsername} machine=${machineId} at=${new Date().toISOString()}`);
  res.redirect('/admin/devices');
});

/**
 * Erros anônimos reportados pelos desktops, agrupados por (empresa, fingerprint).
 * É a tela de onde o suporte copia a mensagem/stack para investigar.
 */
router.get('/errors', requireAdminAuth, async (_req, res) => {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT company_uuid, fingerprint, MAX(scope) AS scope, MAX(level) AS level, MAX(message) AS message,
            MAX(stack) AS stack, SUM(occurrences) AS total, COUNT(DISTINCT machine_id) AS devices,
            MAX(last_seen_at) AS last_seen_at, MIN(first_seen_at) AS first_seen_at
       FROM client_error_reports
       GROUP BY company_uuid, fingerprint
       ORDER BY last_seen_at DESC
       LIMIT 300`,
  );
  const [companyRows] = await pool.query('SELECT company_uuid, name FROM companies');
  const names = new Map(
    (companyRows as { company_uuid: string; name: string | null }[]).map((c) => [c.company_uuid, c.name]),
  );
  const errors = (rows as Record<string, unknown>[]).map((r) => ({
    ...r,
    company_name: names.get(String(r.company_uuid)) ?? null,
  }));
  res.render('errors', { errors });
});

/**
 * Inventário de hardware (anônimo) por instalação, mais um resumo por perfil
 * (OS + CPU + RAM) para achar padrões de placa/máquina que dão problema.
 */
router.get('/hardware', requireAdminAuth, async (_req, res) => {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT company_uuid, machine_id, data, os, cpu, ram_gb, app_version, first_seen_at, last_seen_at
       FROM client_machine_inventory ORDER BY last_seen_at DESC LIMIT 1000`,
  );
  const [companyRows] = await pool.query('SELECT company_uuid, name FROM companies');
  const names = new Map(
    (companyRows as { company_uuid: string; name: string | null }[]).map((c) => [c.company_uuid, c.name]),
  );
  interface MachineRow {
    company_uuid: string;
    machine_id: string;
    os: string | null;
    cpu: string | null;
    ram_gb: number | null;
    app_version: string | null;
    first_seen_at: string;
    last_seen_at: string;
    company_name: string | null;
    data: unknown;
  }
  const machines: MachineRow[] = (rows as Record<string, unknown>[]).map((r) => ({
    ...(r as unknown as MachineRow),
    company_name: names.get(String(r.company_uuid)) ?? null,
    data: typeof r.data === 'string' ? safeJson(r.data) : r.data,
  }));

  const groups = new Map<string, { os: string | null; cpu: string | null; ram_gb: number | null; machines: number; companies: Set<string> }>();
  for (const m of machines) {
    const key = `${m.os ?? '?'}|${m.cpu ?? '?'}|${m.ram_gb ?? '?'}`;
    const g = groups.get(key) ?? { os: m.os as string | null, cpu: m.cpu as string | null, ram_gb: m.ram_gb as number | null, machines: 0, companies: new Set<string>() };
    g.machines++;
    g.companies.add(String(m.company_uuid));
    groups.set(key, g);
  }
  const profiles = [...groups.values()]
    .map((g) => ({ os: g.os, cpu: g.cpu, ram_gb: g.ram_gb, machines: g.machines, companies: g.companies.size }))
    .sort((a, b) => b.machines - a.machines);

  res.render('hardware', { machines, profiles });
});

/** Compara versões "x.y.z" (só os três primeiros números). */
function cmpVersao(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Versões: distribuição de versões do app e, por instalação, a versão que está rodando
 * contra a versão exigida pelo suporte (`companies.licensed_version`). Alimenta o painel
 * para ver quem está desatualizado.
 */
router.get('/versions', requireAdminAuth, async (_req, res) => {
  const pool = getPool();
  const [deviceRows] = await pool.query(
    `SELECT c.company_uuid, c.name AS company_name, c.plan, c.licensed_version,
            cd.machine_id, cd.app_version, cd.last_seen_at
       FROM company_devices cd JOIN companies c ON c.company_uuid = cd.company_uuid
      WHERE cd.removed_at IS NULL
      ORDER BY c.name, cd.last_seen_at DESC`,
  );
  const devices = (deviceRows as Record<string, unknown>[]).map((d) => ({
    ...d,
    desatualizado: !!d.licensed_version && !!d.app_version
      && cmpVersao(String(d.app_version), String(d.licensed_version)) < 0,
  }));

  const [versionRows] = await pool.query(
    `SELECT COALESCE(app_version, 'desconhecida') AS app_version, COUNT(*) AS total
       FROM company_devices WHERE removed_at IS NULL
      GROUP BY app_version ORDER BY total DESC`,
  );
  const distribution = versionRows as { app_version: string; total: number }[];
  const outdated = devices.filter((d) => d.desatualizado).length;

  res.render('versions', { devices, distribution, outdated, totalDevices: devices.length });
});

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Exclusão definitiva de uma empresa e de TODO o dado dela no cloud.
 *
 * TODA tabela que referencia `companies` precisa aparecer aqui: `menu_items` tem FK e ficou
 * de fora até a 0.3.1; `company_mobile_grants`/`company_commands` (0019) também; e `ai_usage`
 * (0037) entrou depois — sem apagá-la, excluir uma empresa que usou a KIVO IA estourava a FK
 * e virava um "Erro interno do servidor." genérico. `client_error_reports` e
 * `client_machine_inventory` (telemetria) e `message_targets` (central de mensagens) não têm
 * FK, mas guardam `company_uuid` e sairiam órfãos.
 *
 * Imagens do banco (catalog_images) só perdem o vínculo (company_uuid = NULL) — são um
 * acervo compartilhado, não pertencem só a quem enviou.
 *
 * `trial_registry` também sai: sem isso a máquina daquela empresa ficava marcada para sempre
 * como "já usou o teste" mesmo depois da empresa apagada (ver `/admin/trials/:machineId/release`).
 */
async function deleteCompanyCompletely(uuid: string): Promise<void> {
  const pool = getPool();
  const [backupRows] = await pool.query('SELECT storage_path FROM cloud_backups WHERE company_uuid = ?', [uuid]);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM sync_records WHERE company_uuid = ?', [uuid]);
    await conn.query('DELETE FROM cloud_backups WHERE company_uuid = ?', [uuid]);
    await conn.query('DELETE FROM charges WHERE company_uuid = ?', [uuid]);
    await conn.query('DELETE FROM menu_items WHERE company_uuid = ?', [uuid]);
    // support_messages cai junto por ON DELETE CASCADE em fk_support_messages_ticket.
    await conn.query('DELETE FROM support_tickets WHERE company_uuid = ?', [uuid]);
    await conn.query('DELETE FROM trial_registry WHERE company_uuid = ?', [uuid]);
    await conn.query('DELETE FROM company_mobile_grants WHERE company_uuid = ?', [uuid]);
    await conn.query('DELETE FROM company_commands WHERE company_uuid = ?', [uuid]);
    await conn.query('DELETE FROM theme_grants WHERE company_uuid = ?', [uuid]);
    await conn.query('DELETE FROM company_devices WHERE company_uuid = ?', [uuid]);
    await conn.query('DELETE FROM ai_usage WHERE company_uuid = ?', [uuid]);
    await conn.query('DELETE FROM client_error_reports WHERE company_uuid = ?', [uuid]);
    await conn.query('DELETE FROM client_machine_inventory WHERE company_uuid = ?', [uuid]);
    await conn.query('DELETE FROM message_targets WHERE company_uuid = ?', [uuid]);
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
}

router.post('/companies/:uuid/delete', requireAdminAuth, async (req, res) => {
  const uuid = String(req.params.uuid);
  const [companyRows] = await getPool().query('SELECT company_uuid FROM companies WHERE company_uuid = ?', [uuid]);
  if (!(companyRows as { company_uuid: string }[])[0]) {
    res.status(404).send('Empresa não encontrada.');
    return;
  }
  await deleteCompanyCompletely(uuid);
  res.redirect('/admin/companies');
});

/**
 * Limpeza dos testes grátis vencidos: apaga em lote as empresas cujo plano é `trial` e cuja
 * validade já passou, junto com TODO o dado delas (ver `deleteCompanyCompletely`). É o que o
 * time usa para não deixar lixo de quem só quis experimentar. O `trial_registry` também sai,
 * então a máquina volta a poder pedir o teste.
 *
 * A exclusão é sequencial de propósito: o volume é baixo e, se uma falhar, as outras seguem.
 */
router.post('/companies/purge-expired-trials', requireAdminAuth, async (req: AdminRequest, res) => {
  const [rows] = await getPool().query(
    "SELECT company_uuid FROM companies WHERE plan = 'trial' AND valid_until IS NOT NULL AND valid_until < NOW()",
  );
  const uuids = (rows as { company_uuid: string }[]).map((r) => r.company_uuid);
  let removed = 0;
  for (const uuid of uuids) {
    try {
      await deleteCompanyCompletely(uuid);
      removed++;
    } catch (e) {
      console.error(`[PURGE TRIALS] falha ao excluir ${uuid}:`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`[PURGE TRIALS] admin=${req.adminUsername} removidas=${removed}/${uuids.length} at=${new Date().toISOString()}`);
  res.redirect('/admin/companies?ok=' + encodeURIComponent(
    removed === 0 ? 'Nenhum teste vencido para excluir.' : `${removed} teste(s) vencido(s) excluído(s) com todos os dados.`,
  ));
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

/**
 * Resposta do resgate de senha, para o atendente ditar ao telefone.
 *
 * O que sai daqui é a resposta de UM desafio — nunca o `recovery_secret` da empresa.
 * Quem tiver o segredo destrava qualquer máquina dela para sempre; quem tem uma resposta
 * destrava um usuário, uma vez, nos próximos 30 minutos.
 *
 * Sem validar o formato do desafio de propósito: o HMAC normaliza a entrada (ver
 * `recoveryCodes.normalize`), e recusar aqui só transformaria um erro de transcrição do
 * atendente numa mensagem genérica em vez de num código que o cliente diz não funcionar —
 * a diferença é que a segunda o cliente reporta na hora e a primeira ele não entende.
 */
router.post('/companies/:uuid/recovery-code', requireAdminAuth, async (req: AdminRequest, res) => {
  const uuid = String(req.params.uuid);
  const challenge = String(req.body?.challenge ?? '').trim();
  const detail = await loadCompanyDetail(uuid);
  if (!detail) {
    res.status(404).send('Empresa não encontrada.');
    return;
  }
  const secret = (detail.company as { recovery_secret?: string | null }).recovery_secret;
  const recoveryCode = secret && challenge ? expectedResponse(secret, challenge) : null;
  if (recoveryCode) {
    console.log(`[admin] resgate de senha gerado para ${uuid} por ${req.adminUsername ?? '?'} (desafio ${challenge})`);
  }
  res.render('company-detail', {
    ...detail,
    revealedLicenseKey: null,
    recoveryChallenge: challenge,
    recoveryCode,
    planTiers: PLAN_TIERS,
    planLabels: PLAN_LABELS,
  });
});

// --- Comandos de suporte (fila company_commands, executada pelo desktop) ---

/** Só estes tipos podem ser disparados pelo painel — evita virar um executor genérico. */
const SUPPORT_COMMANDS = new Set(['support.sync_now', 'support.diagnostics', 'support.force_update']);

router.post('/companies/:uuid/commands', requireAdminAuth, async (req: AdminRequest, res) => {
  const uuid = String(req.params.uuid);
  const kind = String((req.body ?? {}).kind ?? '');
  if (!SUPPORT_COMMANDS.has(kind)) {
    res.status(400).send('Comando de suporte inválido.');
    return;
  }

  const payload = JSON.stringify({ by: req.adminUsername ?? 'admin' });
  const bySystem = '00000000-0000-0000-0000-000000000000';

  /**
   * Forçar atualização é para TODAS as máquinas da empresa: como o ack encerra o comando
   * (status sai de 'pendente'), uma linha só seria consumida pela primeira máquina que
   * respondesse. Então grava uma linha por dispositivo ativo, cada uma com o seu alvo.
   *
   * Sem dispositivo conhecido (empresa recém-criada, nenhuma validação de licença ainda),
   * cai no comando sem alvo: qualquer máquina que consultar pega.
   */
  if (kind === 'support.force_update') {
    const [deviceRows] = await getPool().query(
      'SELECT machine_id FROM company_devices WHERE company_uuid = ? AND removed_at IS NULL',
      [uuid],
    );
    const machines = (deviceRows as { machine_id: string }[]).map((d) => d.machine_id);
    const alvos: (string | null)[] = machines.length ? machines : [null];

    let primeiroId: number | null = null;
    for (const machine of alvos) {
      const [result] = await getPool().query(
        `INSERT INTO company_commands (company_uuid, kind, payload, created_by_user_uuid, target_machine_id)
         VALUES (?, ?, CAST(? AS JSON), ?, ?)`,
        [uuid, kind, payload, bySystem, machine],
      );
      if (primeiroId === null) primeiroId = (result as { insertId: number }).insertId;
    }
    // Um único aviso já acorda todas as máquinas da empresa — elas consultam e filtram.
    if (primeiroId !== null) emitToCompany(uuid, 'command', { id: primeiroId, kind });
    res.redirect(`/admin/companies/${uuid}#diagnostico`);
    return;
  }

  const [result] = await getPool().query(
    `INSERT INTO company_commands (company_uuid, kind, payload, created_by_user_uuid)
     VALUES (?, ?, CAST(? AS JSON), ?)`,
    [uuid, kind, payload, bySystem],
  );
  // Acorda o desktop na hora, se o canal SSE dele estiver conectado.
  emitToCompany(uuid, 'command', { id: (result as { insertId: number }).insertId, kind });
  res.redirect(`/admin/companies/${uuid}#diagnostico`);
});

router.get('/api/companies/:uuid/commands', requireAdminAuth, async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT id, kind, status, result, created_at, applied_at
       FROM company_commands WHERE company_uuid = ? ORDER BY id DESC LIMIT 10`,
    [req.params.uuid],
  );
  res.json({
    commands: (rows as Record<string, unknown>[]).map((c) => ({
      ...c,
      result: typeof c.result === 'string' ? safeJson(c.result) : c.result,
    })),
  });
});

// --- Cobrança manual (sem gateway — só registro e baixa manual) ---

router.post('/companies/:uuid/charges', requireAdminAuth, async (req, res) => {
  const uuid = String(req.params.uuid);
  const { description, amount, dueDate, instructions } = req.body ?? {};
  if (description && amount && dueDate) {
    const amountCents = parseAmountCents(amount);
    // Mesmo desconto de indicação da tela global: o valor informado é o cheio.
    const { pct, discountCents } = await affiliateDiscountFor(uuid, amountCents);
    await getPool().query(
      `INSERT INTO charges
         (company_uuid, description, instructions, amount_cents, original_amount_cents, discount_pct, discount_cents, due_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuid, description, instructions || null, amountCents - discountCents, amountCents, pct, discountCents, dueDate],
    );
  }
  res.redirect(`/admin/companies/${uuid}`);
});

/** Redireciona de volta para a aba de cobranças da empresa, com mensagem opcional. */
function redirectCompanyCharges(res: import('express').Response, uuid: string, kind: 'ok' | 'error', msg?: string): void {
  const qs = msg ? `?${kind}=${encodeURIComponent(msg)}` : '';
  res.redirect(`/admin/companies/${uuid}${qs}#cobrancas`);
}

router.post('/companies/:uuid/charges/:id/pay', requireAdminAuth, async (req, res) => {
  const uuid = String(req.params.uuid);
  // Só baixa o que ainda está pendente: re-clicar não re-paga nem re-lança comissão.
  const [result] = await getPool().query(
    "UPDATE charges SET status = 'paga', paid_at = NOW(3) WHERE id = ? AND company_uuid = ? AND status = 'pendente'",
    [req.params.id, uuid],
  );
  if ((result as { affectedRows: number }).affectedRows > 0) {
    // Recebeu: lança o crédito de comissão do afiliado que indicou a empresa (se houver).
    await accrueCommissionForCharge(Number(req.params.id));
    redirectCompanyCharges(res, uuid, 'ok', 'Cobrança marcada como paga.');
    return;
  }
  redirectCompanyCharges(res, uuid, 'error', 'Só é possível marcar como paga uma cobrança pendente.');
});

router.post('/companies/:uuid/charges/:id/cancel', requireAdminAuth, async (req, res) => {
  const uuid = String(req.params.uuid);
  const [result] = await getPool().query(
    "UPDATE charges SET status = 'cancelada' WHERE id = ? AND company_uuid = ? AND status = 'pendente'",
    [req.params.id, uuid],
  );
  if ((result as { affectedRows: number }).affectedRows > 0) {
    redirectCompanyCharges(res, uuid, 'ok', 'Cobrança cancelada.');
    return;
  }
  redirectCompanyCharges(res, uuid, 'error', 'Só é possível cancelar uma cobrança pendente.');
});

// Estorno: desfaz a baixa de uma cobrança paga (volta a pendente e apaga a comissão gerada).
router.post('/companies/:uuid/charges/:id/reverse', requireAdminAuth, async (req, res) => {
  const uuid = String(req.params.uuid);
  const result = await reverseChargePayment(Number(req.params.id), uuid);
  if (result.ok) {
    redirectCompanyCharges(res, uuid, 'ok', 'Pagamento estornado — a cobrança voltou a ficar pendente.');
    return;
  }
  const msg =
    result.reason === 'commission_in_payout'
      ? 'Não é possível estornar: a comissão desta cobrança já entrou em um pedido de pagamento ao afiliado.'
      : 'Só é possível estornar uma cobrança paga.';
  redirectCompanyCharges(res, uuid, 'error', msg);
});

// Reabre uma cobrança cancelada, devolvendo-a para pendente.
router.post('/companies/:uuid/charges/:id/reopen', requireAdminAuth, async (req, res) => {
  const uuid = String(req.params.uuid);
  const [result] = await getPool().query(
    "UPDATE charges SET status = 'pendente' WHERE id = ? AND company_uuid = ? AND status = 'cancelada'",
    [req.params.id, uuid],
  );
  if ((result as { affectedRows: number }).affectedRows > 0) {
    redirectCompanyCharges(res, uuid, 'ok', 'Cobrança reaberta.');
    return;
  }
  redirectCompanyCharges(res, uuid, 'error', 'Só é possível reabrir uma cobrança cancelada.');
});

// --- Cobranças (visão global) + Afiliados (programa de indicação) ---

/**
 * Valor em centavos a partir do que o formulário manda. Aceita "100", "100,00" e "1.234,56"
 * (vírgula decimal) e "1234.56" — o lojista digita em português e o `Number()` cru devolvia
 * NaN com vírgula, o que silenciosamente não criava a cobrança.
 */
function parseAmountCents(v: unknown): number {
  const s = String(v ?? '').replace(/[^\d,.]/g, '');
  const norm = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const n = parseFloat(norm);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/**
 * Desconto de indicação da empresa: se ela aponta para um afiliado ATIVO, devolve o
 * percentual e o desconto em centavos sobre o valor cheio. Sem afiliado (ou inativo),
 * zero. É a única fonte da regra — a criação da cobrança e a prévia da tela usam a mesma.
 */
async function affiliateDiscountFor(companyUuid: string, amountCents: number): Promise<{ pct: number; discountCents: number }> {
  const [rows] = await getPool().query(
    `SELECT a.discount_pct FROM companies c
       JOIN affiliates a ON a.id = c.affiliate_id
      WHERE c.company_uuid = ? AND a.active = 1`,
    [companyUuid],
  );
  const pct = Number((rows as { discount_pct: number }[])[0]?.discount_pct || 0);
  const discountCents = pct > 0 ? Math.round((amountCents * pct) / 100) : 0;
  return { pct, discountCents };
}

router.get('/charges', requireAdminAuth, async (req, res) => {
  const status = typeof req.query.status === 'string' && ['pendente', 'paga', 'cancelada'].includes(req.query.status)
    ? req.query.status
    : '';
  const vencidas = req.query.vencidas === '1';
  const pool = getPool();

  const where: string[] = [];
  const params: unknown[] = [];
  if (status) {
    where.push('ch.status = ?');
    params.push(status);
  }
  if (vencidas) where.push("ch.status = 'pendente' AND ch.due_date < CURDATE()");

  const [chargeRows] = await pool.query(
    `SELECT ch.id, ch.company_uuid, ch.description, ch.instructions, ch.amount_cents,
            ch.original_amount_cents, ch.discount_pct, ch.discount_cents, ch.due_date,
            ch.status, ch.paid_at, ch.created_at,
            c.name AS company_name, a.name AS affiliate_name
       FROM charges ch
       LEFT JOIN companies c ON c.company_uuid = ch.company_uuid
       LEFT JOIN affiliates a ON a.id = c.affiliate_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY (ch.status = 'pendente') DESC, ch.due_date ASC, ch.id DESC
      LIMIT 500`,
    params,
  );

  const [sumRows] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'pendente' THEN amount_cents END), 0) AS pending_cents,
       COALESCE(SUM(CASE WHEN status = 'pendente' AND due_date < CURDATE() THEN amount_cents END), 0) AS overdue_cents,
       COALESCE(SUM(CASE WHEN status = 'paga' AND paid_at >= DATE_FORMAT(NOW(), '%Y-%m-01') THEN amount_cents END), 0) AS paid_month_cents,
       COALESCE(SUM(CASE WHEN status = 'paga' AND paid_at >= DATE_FORMAT(NOW(), '%Y-%m-01') THEN discount_cents END), 0) AS discount_month_cents
     FROM charges`,
  );
  const summary = (sumRows as Record<string, number>[])[0] ?? {};

  const [companies] = await pool.query(
    `SELECT c.company_uuid, c.name, a.id AS affiliate_id, a.name AS affiliate_name, a.discount_pct, a.commission_pct
       FROM companies c LEFT JOIN affiliates a ON a.id = c.affiliate_id
      ORDER BY c.name`,
  );
  const [affiliates] = await pool.query('SELECT id, name, discount_pct, commission_pct, active FROM affiliates ORDER BY name');

  res.render('charges', {
    charges: chargeRows,
    summary,
    companies,
    affiliates,
    filter: { status, vencidas },
    active: 'charges',
    ok: typeof req.query.ok === 'string' ? req.query.ok : null,
    error: typeof req.query.error === 'string' ? req.query.error : null,
  });
});

router.post('/charges', requireAdminAuth, async (req, res) => {
  const { companyUuid, description, amount, dueDate, instructions } = req.body ?? {};
  if (!companyUuid || !description || !amount || !dueDate) {
    res.redirect('/admin/charges');
    return;
  }
  const amountCents = parseAmountCents(amount);
  if (amountCents <= 0) {
    res.redirect('/admin/charges');
    return;
  }
  // O desconto de indicação é aplicado aqui: o valor cheio fica guardado e o que o cliente
  // deve é amount_cents (já líquido).
  const { pct, discountCents } = await affiliateDiscountFor(String(companyUuid), amountCents);
  await getPool().query(
    `INSERT INTO charges
       (company_uuid, description, instructions, amount_cents, original_amount_cents, discount_pct, discount_cents, due_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [String(companyUuid), description, instructions || null, amountCents - discountCents, amountCents, pct, discountCents, dueDate],
  );
  res.redirect('/admin/charges');
});

/** Volta para a lista de cobranças com uma mensagem opcional (ok/erro). */
function redirectCharges(res: import('express').Response, kind: 'ok' | 'error', msg?: string): void {
  res.redirect(`/admin/charges${msg ? `?${kind}=${encodeURIComponent(msg)}` : ''}`);
}

router.post('/charges/:id/pay', requireAdminAuth, async (req, res) => {
  // Só baixa o que ainda está pendente: re-clicar não re-paga nem re-lança comissão.
  const [result] = await getPool().query(
    "UPDATE charges SET status = 'paga', paid_at = NOW(3) WHERE id = ? AND status = 'pendente'",
    [req.params.id],
  );
  if ((result as { affectedRows: number }).affectedRows > 0) {
    // Recebeu: lança o crédito de comissão do afiliado que indicou a empresa (se houver).
    await accrueCommissionForCharge(Number(req.params.id));
    redirectCharges(res, 'ok', 'Cobrança marcada como paga.');
    return;
  }
  redirectCharges(res, 'error', 'Só é possível marcar como paga uma cobrança pendente.');
});

router.post('/charges/:id/cancel', requireAdminAuth, async (req, res) => {
  const [result] = await getPool().query(
    "UPDATE charges SET status = 'cancelada' WHERE id = ? AND status = 'pendente'",
    [req.params.id],
  );
  if ((result as { affectedRows: number }).affectedRows > 0) {
    redirectCharges(res, 'ok', 'Cobrança cancelada.');
    return;
  }
  redirectCharges(res, 'error', 'Só é possível cancelar uma cobrança pendente.');
});

// Estorno: desfaz a baixa de uma cobrança paga (volta a pendente e apaga a comissão gerada).
router.post('/charges/:id/reverse', requireAdminAuth, async (req, res) => {
  const result = await reverseChargePayment(Number(req.params.id));
  if (result.ok) {
    redirectCharges(res, 'ok', 'Pagamento estornado — a cobrança voltou a ficar pendente.');
    return;
  }
  redirectCharges(
    res,
    'error',
    result.reason === 'commission_in_payout'
      ? 'Não é possível estornar: a comissão desta cobrança já entrou em um pedido de pagamento ao afiliado.'
      : 'Só é possível estornar uma cobrança paga.',
  );
});

// Reabre uma cobrança cancelada, devolvendo-a para pendente.
router.post('/charges/:id/reopen', requireAdminAuth, async (req, res) => {
  const [result] = await getPool().query(
    "UPDATE charges SET status = 'pendente' WHERE id = ? AND status = 'cancelada'",
    [req.params.id],
  );
  if ((result as { affectedRows: number }).affectedRows > 0) {
    redirectCharges(res, 'ok', 'Cobrança reaberta.');
    return;
  }
  redirectCharges(res, 'error', 'Só é possível reabrir uma cobrança cancelada.');
});

/** Percentual inteiro de 0 a 100, tolerante a vazio/valor inválido. */
function parsePct(v: unknown): number {
  return Math.min(100, Math.max(0, Math.round(Number(v) || 0)));
}

/** Campos comuns do cadastro/edição do afiliado, já normalizados. */
function affiliateFields(b: Record<string, unknown>) {
  return {
    name: String(b.name ?? '').trim(),
    city: textOrNull(b.city),
    contact: textOrNull(b.contact),
    document: textOrNull(b.document),
    discountPct: parsePct(b.discountPct),
    commissionPct: parsePct(b.commissionPct),
    pixKey: textOrNull(b.pixKey),
    notes: textOrNull(b.notes),
    portalUser: textOrNull(b.portalUser),
  };
}

router.get('/affiliates', requireAdminAuth, async (req, res) => {
  const pool = getPool();
  const [affiliates] = await pool.query(
    `SELECT a.id, a.name, a.city, a.contact, a.discount_pct, a.commission_pct, a.active,
            a.created_at, a.username,
            (SELECT COUNT(*) FROM companies c WHERE c.affiliate_id = a.id) AS companies_count,
            (SELECT COALESCE(SUM(ac.amount_cents),0) FROM affiliate_commissions ac
              WHERE ac.affiliate_id = a.id AND ac.status = 'disponivel') AS available_cents,
            (SELECT COALESCE(SUM(ac.amount_cents),0) FROM affiliate_commissions ac
              WHERE ac.affiliate_id = a.id AND ac.status = 'solicitado') AS requested_cents,
            (SELECT COALESCE(SUM(ac.amount_cents),0) FROM affiliate_commissions ac
              WHERE ac.affiliate_id = a.id AND ac.status = 'pago') AS paid_cents
       FROM affiliates a ORDER BY a.active DESC, a.name`,
  );
  const totals = (affiliates as Record<string, unknown>[]).reduce<{
    available: number;
    requested: number;
    paid: number;
    activeCount: number;
  }>(
    (acc, a) => {
      acc.available += Number(a.available_cents) || 0;
      acc.requested += Number(a.requested_cents) || 0;
      acc.paid += Number(a.paid_cents) || 0;
      if (a.active) acc.activeCount += 1;
      return acc;
    },
    { available: 0, requested: 0, paid: 0, activeCount: 0 },
  );
  res.render('affiliates', {
    affiliates,
    totals,
    active: 'affiliates',
    ok: typeof req.query.ok === 'string' ? 'Operação realizada com sucesso.' : null,
    error: typeof req.query.error === 'string' ? req.query.error : null,
  });
});

router.post('/affiliates', requireAdminAuth, async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const f = affiliateFields(b);
  if (f.name.length < 2) {
    res.redirect('/admin/affiliates?error=Informe+o+nome+do+afiliado');
    return;
  }
  const password = String(b.portalPassword ?? '').trim();
  const passwordHash = f.portalUser && password ? hashAffiliatePassword(password) : null;
  try {
    await getPool().query(
      `INSERT INTO affiliates
         (name, city, contact, document, discount_pct, commission_pct, pix_key, notes, username, password_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [f.name, f.city, f.contact, f.document, f.discountPct, f.commissionPct, f.pixKey, f.notes, f.portalUser, passwordHash],
    );
  } catch {
    res.redirect('/admin/affiliates?error=Usu%C3%A1rio+do+portal+j%C3%A1+est%C3%A1+em+uso');
    return;
  }
  res.redirect('/admin/affiliates?ok=criado');
});

router.get('/affiliates/:id', requireAdminAuth, async (req, res) => {
  const pool = getPool();
  const affiliateId = Number(req.params.id);
  const [rows] = await pool.query(
    `SELECT a.*,
            (SELECT COUNT(*) FROM companies c WHERE c.affiliate_id = a.id) AS companies_count
       FROM affiliates a WHERE a.id = ?`,
    [affiliateId],
  );
  const affiliate = (rows as Record<string, unknown>[])[0];
  if (!affiliate) {
    res.status(404).send('Afiliado não encontrado.');
    return;
  }
  const summary = await affiliateSummary(affiliateId);
  const [companies] = await pool.query(
    `SELECT c.company_uuid, c.name, c.plan, c.valid_until, c.city, c.state,
            (SELECT COALESCE(SUM(ch.amount_cents),0) FROM charges ch
              WHERE ch.company_uuid = c.company_uuid AND ch.status = 'pendente') AS pending_cents,
            (SELECT COALESCE(SUM(ch.amount_cents),0) FROM charges ch
              WHERE ch.company_uuid = c.company_uuid AND ch.status = 'paga') AS paid_cents
       FROM companies c WHERE c.affiliate_id = ? ORDER BY c.name`,
    [affiliateId],
  );
  const [commissions] = await pool.query(
    `SELECT ac.id, ac.amount_cents, ac.base_cents, ac.pct, ac.status, ac.created_at, ac.paid_at,
            c.name AS company_name, c.company_uuid, ch.description AS charge_description
       FROM affiliate_commissions ac
       LEFT JOIN companies c ON c.company_uuid = ac.company_uuid
       LEFT JOIN charges ch ON ch.id = ac.charge_id
      WHERE ac.affiliate_id = ? ORDER BY ac.id DESC LIMIT 200`,
    [affiliateId],
  );
  const [payouts] = await pool.query(
    `SELECT id, amount_cents, status, method, notes, requested_by, requested_at, paid_at, paid_by
       FROM affiliate_payouts WHERE affiliate_id = ? ORDER BY id DESC`,
    [affiliateId],
  );
  res.render('affiliate-detail', {
    affiliate,
    summary,
    companies,
    commissions,
    payouts,
    active: 'affiliates',
    ok: typeof req.query.ok === 'string' ? req.query.ok : null,
    error: typeof req.query.error === 'string' ? req.query.error : null,
  });
});

router.post('/affiliates/:id/update', requireAdminAuth, async (req, res) => {
  const affiliateId = Number(req.params.id);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const f = affiliateFields(b);
  if (f.name.length < 2) {
    res.redirect(`/admin/affiliates/${affiliateId}?error=Informe+o+nome+do+afiliado`);
    return;
  }
  const sets = [
    'name = ?', 'city = ?', 'contact = ?', 'document = ?', 'discount_pct = ?',
    'commission_pct = ?', 'pix_key = ?', 'notes = ?', 'username = ?',
  ];
  const params: unknown[] = [f.name, f.city, f.contact, f.document, f.discountPct, f.commissionPct, f.pixKey, f.notes, f.portalUser];
  // Senha só muda quando o campo vem preenchido; usuário vazio remove o acesso ao portal.
  const password = String(b.portalPassword ?? '').trim();
  if (password) {
    sets.push('password_hash = ?');
    params.push(hashAffiliatePassword(password));
  } else if (!f.portalUser) {
    sets.push('password_hash = NULL');
  }
  params.push(affiliateId);
  try {
    await getPool().query(`UPDATE affiliates SET ${sets.join(', ')} WHERE id = ?`, params);
  } catch {
    res.redirect(`/admin/affiliates/${affiliateId}?error=Usu%C3%A1rio+do+portal+j%C3%A1+est%C3%A1+em+uso`);
    return;
  }
  res.redirect(`/admin/affiliates/${affiliateId}?ok=salvo`);
});

router.post('/affiliates/:id/toggle', requireAdminAuth, async (req, res) => {
  await getPool().query('UPDATE affiliates SET active = 1 - active WHERE id = ?', [req.params.id]);
  res.redirect('/admin/affiliates');
});

router.post('/affiliates/:id/delete', requireAdminAuth, async (req, res) => {
  const affiliateId = Number(req.params.id);
  // Com histórico financeiro, excluir apagaria o rastro das comissões. Aí só desativa.
  const [histRows] = await getPool().query(
    'SELECT (SELECT COUNT(*) FROM affiliate_commissions WHERE affiliate_id = ?) + (SELECT COUNT(*) FROM affiliate_payouts WHERE affiliate_id = ?) AS n',
    [affiliateId, affiliateId],
  );
  if (Number((histRows as { n: number }[])[0]?.n || 0) > 0) {
    res.redirect('/admin/affiliates?error=Afiliado+tem+hist%C3%B3rico+de+comiss%C3%B5es.+Desative+em+vez+de+excluir.');
    return;
  }
  // Solta as empresas antes: sem o afiliado, elas voltam a pagar o valor cheio.
  await getPool().query('UPDATE companies SET affiliate_id = NULL WHERE affiliate_id = ?', [affiliateId]);
  await getPool().query('DELETE FROM affiliates WHERE id = ?', [affiliateId]);
  res.redirect('/admin/affiliates?ok=excluido');
});

// --- Comissões e pagamentos (visão global) ---

router.get('/commissions', requireAdminAuth, async (req, res) => {
  const status = typeof req.query.status === 'string' &&
    ['disponivel', 'solicitado', 'pago', 'cancelado'].includes(req.query.status)
    ? req.query.status
    : '';
  const affiliateId = Number(req.query.affiliateId) || 0;
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) {
    where.push('ac.status = ?');
    params.push(status);
  }
  if (affiliateId) {
    where.push('ac.affiliate_id = ?');
    params.push(affiliateId);
  }
  const pool = getPool();
  const [commissions] = await pool.query(
    `SELECT ac.id, ac.amount_cents, ac.base_cents, ac.pct, ac.status, ac.created_at, ac.paid_at,
            a.id AS affiliate_id, a.name AS affiliate_name,
            c.name AS company_name, c.company_uuid, ch.description AS charge_description
       FROM affiliate_commissions ac
       LEFT JOIN affiliates a ON a.id = ac.affiliate_id
       LEFT JOIN companies c ON c.company_uuid = ac.company_uuid
       LEFT JOIN charges ch ON ch.id = ac.charge_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ac.id DESC LIMIT 500`,
    params,
  );
  const [sumRows] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'disponivel' THEN amount_cents END),0) AS available_cents,
       COALESCE(SUM(CASE WHEN status = 'solicitado' THEN amount_cents END),0) AS requested_cents,
       COALESCE(SUM(CASE WHEN status = 'pago' THEN amount_cents END),0) AS paid_cents,
       COUNT(*) AS total_count
     FROM affiliate_commissions`,
  );
  const summary = (sumRows as Record<string, number>[])[0] ?? {};
  const [affiliates] = await pool.query('SELECT id, name FROM affiliates ORDER BY name');
  res.render('commissions', {
    commissions,
    summary,
    affiliates,
    filter: { status, affiliateId },
    active: 'commissions',
  });
});

router.get('/payouts', requireAdminAuth, async (req, res) => {
  const status = typeof req.query.status === 'string' &&
    ['solicitado', 'pago', 'cancelado'].includes(req.query.status)
    ? req.query.status
    : '';
  const pool = getPool();
  const [payouts] = await pool.query(
    `SELECT p.id, p.affiliate_id, p.amount_cents, p.method, p.notes, p.status, p.requested_by,
            p.requested_at, p.paid_at, p.paid_by, a.name AS affiliate_name, a.pix_key
       FROM affiliate_payouts p LEFT JOIN affiliates a ON a.id = p.affiliate_id
      ${status ? 'WHERE p.status = ?' : ''}
      ORDER BY (p.status = 'solicitado') DESC, p.id DESC LIMIT 500`,
    status ? [status] : [],
  );
  const [sumRows] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'solicitado' THEN amount_cents END),0) AS requested_cents,
       COUNT(CASE WHEN status = 'solicitado' THEN 1 END) AS requested_count,
       COALESCE(SUM(CASE WHEN status = 'pago' AND paid_at >= DATE_FORMAT(NOW(), '%Y-%m-01') THEN amount_cents END),0) AS paid_month_cents
     FROM affiliate_payouts`,
  );
  const summary = (sumRows as Record<string, number>[])[0] ?? {};
  res.render('payouts', {
    payouts,
    summary,
    filter: { status },
    active: 'payouts',
    ok: typeof req.query.ok === 'string' ? req.query.ok : null,
    error: typeof req.query.error === 'string' ? req.query.error : null,
  });
});

router.post('/affiliates/:id/payouts', requireAdminAuth, async (req: AdminRequest, res) => {
  const affiliateId = Number(req.params.id);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const markPaid = b.markPaid === '1' || b.markPaid === true;
  const result = await createPayoutFromAvailable({
    affiliateId,
    method: textOrNull(b.method),
    notes: textOrNull(b.notes),
    requestedBy: req.adminUsername ?? 'admin',
    markPaid,
  });
  if (!result) {
    res.redirect(`/admin/affiliates/${affiliateId}?error=Sem+cr%C3%A9dito+dispon%C3%ADvel+para+pagar`);
    return;
  }
  res.redirect(`/admin/affiliates/${affiliateId}?ok=${markPaid ? 'pagamento+confirmado' : 'pedido+de+pagamento+criado'}`);
});

router.post('/payouts/:id/pay', requireAdminAuth, async (req: AdminRequest, res) => {
  await payPayout(Number(req.params.id), req.adminUsername ?? 'admin');
  res.redirect('/admin/payouts');
});

router.post('/payouts/:id/cancel', requireAdminAuth, async (req, res) => {
  await cancelPayout(Number(req.params.id));
  res.redirect('/admin/payouts');
});

// Estorno: desfaz um pagamento já confirmado — créditos voltam a ficar disponíveis.
router.post('/payouts/:id/reverse', requireAdminAuth, async (req, res) => {
  const ok = await reversePayout(Number(req.params.id));
  const qs = ok
    ? '?ok=' + encodeURIComponent('Pagamento estornado — os créditos voltaram a ficar disponíveis.')
    : '?error=' + encodeURIComponent('Só é possível estornar um pagamento já confirmado.');
  res.redirect('/admin/payouts' + qs);
});

// --- Configurações globais (contato de suporte exibido no app quando a licença vence) ---

router.get('/settings', requireAdminAuth, async (req, res) => {
  const [rows] = await getPool().query('SELECT setting_key, setting_value FROM app_settings');
  const settings = Object.fromEntries(
    (rows as { setting_key: string; setting_value: string | null }[]).map((r) => [r.setting_key, r.setting_value]),
  );
  // Segredos nunca voltam para a tela: só sinalizamos que já existe um salvo.
  const smtpPasswordSet = Boolean(settings.smtp_password);
  settings.smtp_password = '';
  const imageApiKeySet = Boolean(settings.image_api_key);
  settings.image_api_key = '';
  // KIVO IA: provedores e chaves ficam aqui (o cliente não configura nada). As chaves não
  // voltam para a tela — só o sinalizador de "já configurada".
  const ai = await loadAiSettingsForView();
  res.render('admin-settings', {
    settings,
    smtpPasswordSet,
    imageApiKeySet,
    ai,
    ok: typeof req.query.ok === 'string' ? req.query.ok : null,
    error: typeof req.query.error === 'string' ? req.query.error : null,
  });
});

router.post('/settings', requireAdminAuth, async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const upsert = (key: string, value: unknown) =>
    getPool().query(
      'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
      [key, value || null],
    );
  await Promise.all([
    upsert('support_phone', b.supportPhone),
    upsert('support_email', b.supportEmail),
    upsert('smtp_host', b.smtpHost),
    upsert('smtp_port', b.smtpPort),
    upsert('smtp_secure', b.smtpSecure),
    upsert('smtp_user', b.smtpUser),
    upsert('smtp_from_name', b.smtpFromName),
    upsert('smtp_from_email', b.smtpFromEmail),
    // Checkbox: ausente = desligado. Guardamos '1'/'0' explícito para o load saber diferenciar.
    upsert('image_api_enabled', b.imageApiEnabled ? '1' : '0'),
    upsert('image_api_provider', 'pexels'),
    // KIVO IA: provedor padrão e endpoint do Ollama.
    upsert('ai_enabled', b.aiEnabled ? '1' : '0'),
    upsert('ai_default_provider', isProviderId(b.aiDefaultProvider) ? b.aiDefaultProvider : 'ollama'),
    upsert('ai_ollama_url', String(b.aiOllamaUrl ?? '').trim() || null),
    upsert('ai_ollama_model', String(b.aiOllamaModel ?? '').trim() || null),
  ]);
  // Senha em branco mantém a que já estava salva (não sobrescreve com NULL).
  const password = String(b.smtpPassword ?? '').trim();
  if (password) await upsert('smtp_password', password);
  // Chave da API de imagens: em branco mantém a salva.
  const imageApiKey = String(b.imageApiKey ?? '').trim();
  if (imageApiKey) await upsert('image_api_key', imageApiKey);
  // Chaves dos provedores de IA: em branco mantém a salva.
  const openaiKey = String(b.aiOpenaiKey ?? '').trim();
  if (openaiKey) await upsert('ai_openai_key', openaiKey);
  const deepseekKey = String(b.aiDeepseekKey ?? '').trim();
  if (deepseekKey) await upsert('ai_deepseek_key', deepseekKey);
  const anthropicKey = String(b.aiAnthropicKey ?? '').trim();
  if (anthropicKey) await upsert('ai_anthropic_key', anthropicKey);
  res.redirect('/admin/settings?ok=' + encodeURIComponent('Configurações salvas.'));
});

/**
 * Botão "Testar envio": valida e envia um e-mail usando os dados do formulário (mesmo antes
 * de salvar). A senha em branco usa a já salva, então dá para testar sem redigitá-la.
 */
router.post('/settings/smtp/test', requireAdminAuth, async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const to = String(b.smtpTestTo ?? '').trim();
  if (!to) {
    res.status(400).json({ ok: false, message: 'Informe o e-mail de destino do teste.' });
    return;
  }
  const [rows] = await getPool().query("SELECT setting_value FROM app_settings WHERE setting_key = 'smtp_password'");
  const storedPassword = (rows as { setting_value: string | null }[])[0]?.setting_value ?? null;
  const cfg = smtpConfigFromBody(b, storedPassword);
  if (!cfg.host) {
    res.status(400).json({ ok: false, message: 'Informe o servidor SMTP.' });
    return;
  }
  try {
    await sendTestEmail(to, cfg);
    res.json({ ok: true, message: `E-mail de teste enviado para ${to}. Confira a caixa de entrada (e o spam).` });
  } catch (err) {
    res.status(502).json({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
});

/** Botão "Testar busca" da API de imagens: usa a chave do formulário (ou a salva) e busca um termo. */
router.post('/settings/image-api/test', requireAdminAuth, async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const query = String(b.imageApiQuery ?? '').trim() || 'produto';
  const [rows] = await getPool().query("SELECT setting_value FROM app_settings WHERE setting_key = 'image_api_key'");
  const storedKey = (rows as { setting_value: string | null }[])[0]?.setting_value ?? '';
  const apiKey = String(b.imageApiKey ?? '').trim() || storedKey;
  if (!apiKey) {
    res.status(400).json({ ok: false, message: 'Informe a API Key da busca de imagens.' });
    return;
  }
  try {
    const results = await searchPexels(query, 3, { provider: 'pexels', apiKey });
    res.json({
      ok: true,
      message: `Busca OK: ${results.length} resultado(s) para "${query}".`,
      count: results.length,
    });
  } catch (err) {
    res.status(502).json({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
});

/** Botão "Testar IA" do painel: usa o provedor escolhido (chave do formulário ou a salva). */
router.post('/settings/ai/test', requireAdminAuth, async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const provider = isProviderId(b.provider) ? b.provider : 'ollama';
  const cfg = await loadAiConfig();
  // Chave digitada no formulário tem prioridade sobre a salva (testa antes de salvar).
  const formKey = String(b.apiKey ?? '').trim();
  if (formKey && provider !== 'ollama') cfg.keys[provider] = formKey;
  if (provider !== 'ollama' && !keyFor(cfg, provider)) {
    res.status(400).json({ ok: false, message: `Informe a chave de ${PROVIDER_LABELS[provider]}.` });
    return;
  }
  const model = String(b.model ?? '').trim() || defaultModelFor(cfg, provider);
  try {
    const result = await aiProviderChat(cfg, {
      provider,
      model,
      messages: [{ role: 'user', content: 'Responda apenas: funcionando.' }],
      temperature: 0,
    });
    res.json({ ok: true, message: `${PROVIDER_LABELS[provider]} respondeu (${result.model}): ${result.content.slice(0, 200)}` });
  } catch (err) {
    res.status(502).json({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Lista os modelos instalados no Ollama, para o seletor do campo "modelo padrão". Usa a URL
 * digitada no formulário (permite conferir antes de salvar) ou a já configurada.
 */
router.get('/settings/ai/models', requireAdminAuth, async (req, res) => {
  const cfg = await loadAiConfig();
  const url = String(req.query.url ?? '').trim() || cfg.ollamaUrl;
  try {
    const models = await listOllamaModels(url);
    res.json({ ok: true, models });
  } catch (err) {
    res.status(502).json({ ok: false, models: [], error: err instanceof Error ? err.message : String(err) });
  }
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

async function loadProfileRow(username: string) {
  const [rows] = await getPool().query('SELECT username, email, created_at FROM admin_users WHERE username = ?', [username]);
  return (rows as { username: string; email: string | null; created_at: string }[])[0];
}

router.get('/profile', requireAdminAuth, async (req: AdminRequest, res) => {
  const admin = await loadProfileRow(req.adminUsername!);
  res.render('profile', { admin, error: null, success: null });
});

// E-mail usado na recuperação de senha ("Esqueci minha senha" na tela de login).
router.post('/profile/email', requireAdminAuth, async (req: AdminRequest, res) => {
  const email = String(req.body?.email ?? '').trim();
  const admin = await loadProfileRow(req.adminUsername!);
  const render = (error: string | null, success: string | null) =>
    res.status(400).render('profile', { admin, error, success });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    render('E-mail inválido.', null);
    return;
  }
  await setAdminEmail(req.adminUsername!, email || null);
  res.render('profile', { admin: { ...admin, email: email || null }, error: null, success: 'E-mail de recuperação salvo.' });
});

router.post('/profile/password', requireAdminAuth, async (req: AdminRequest, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body ?? {};
  const admin = await loadProfileRow(req.adminUsername!);
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
  barcode: string | null;
  image_path: string;
  format: 'jpeg' | 'png' | 'webp' | 'avif';
  width: number;
  height: number;
  size_bytes: number;
  status: 'pendente' | 'aprovada' | 'rejeitada';
  source: 'submissao' | 'manual';
  created_at: string;
  reviewed_at?: string | null;
}

const CATALOG_PAGE_SIZE = 48;
const DEMAND_PAGE_SIZE = 50;

function clampPage(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Janela de páginas com reticências (1 … 4 5 [6] 7 8 … 20). */
function pageWindow(page: number, totalPages: number): (number | '…')[] {
  const out: (number | '…')[] = [];
  const start = Math.max(1, page - 2);
  const end = Math.min(totalPages, page + 2);
  if (start > 1) {
    out.push(1);
    if (start > 2) out.push('…');
  }
  for (let i = start; i <= end; i++) out.push(i);
  if (end < totalPages) {
    if (end < totalPages - 1) out.push('…');
    out.push(totalPages);
  }
  return out;
}

/** Aceita `ids` como array (campos repetidos) ou string "1,2,3". */
function parseCatalogIds(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  return [...new Set(list.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))];
}

router.get('/catalog', requireAdminAuth, async (req, res) => {
  const pool = getPool();
  const activeTab = req.query.tab === 'demanda' ? 'demanda' : 'imagens';
  const activeStatus = req.query.status === 'aprovada' ? 'aprovada' : 'pendente';
  const q = String(req.query.q ?? '').trim().slice(0, 80);
  const source =
    req.query.source === 'manual' ? 'manual'
      : req.query.source === 'empresa' ? 'empresa'
        : req.query.source === 'api' ? 'api'
          : '';
  const format = ['jpeg', 'png', 'webp', 'avif'].includes(String(req.query.format))
    ? String(req.query.format)
    : '';
  const sort = ['recentes', 'antigas', 'nome'].includes(String(req.query.sort))
    ? String(req.query.sort)
    : activeStatus === 'aprovada'
      ? 'recentes'
      : 'antigas';

  // ─── Estatísticas gerais (independem do filtro) ───
  const [statsRows] = await pool.query(
    `SELECT
       SUM(status = 'pendente') AS pending,
       SUM(status = 'aprovada') AS approved,
       SUM(status = 'rejeitada') AS rejected,
       -- rejeitada não soma: o arquivo já foi apagado do disco na rejeição, só sobra a linha (tombstone anti-duplicata)
       SUM(CASE WHEN status IN ('pendente', 'aprovada') THEN size_bytes ELSE 0 END) AS storage_bytes
     FROM catalog_images`,
  );
  const stats = (
    statsRows as { pending: number | null; approved: number | null; rejected: number | null; storage_bytes: number | null }[]
  )[0];

  // ─── Imagens (paginadas, com busca e filtros no servidor) ───
  const where: string[] = ['status = ?'];
  const params: unknown[] = [activeStatus];
  if (q) {
    where.push('(product_name LIKE ? OR keywords LIKE ? OR barcode LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (source === 'manual') where.push("source = 'manual'");
  else if (source === 'empresa') where.push("source = 'submissao'");
  else if (source === 'api') where.push("source = 'api'");
  if (format) {
    where.push('format = ?');
    params.push(format);
  }
  const orderBy =
    sort === 'nome'
      ? 'product_name ASC'
      : sort === 'recentes'
        ? activeStatus === 'aprovada'
          ? 'reviewed_at DESC'
          : 'created_at DESC'
        : activeStatus === 'aprovada'
          ? 'reviewed_at ASC'
          : 'created_at ASC';

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM catalog_images WHERE ${where.join(' AND ')}`,
    params,
  );
  const totalImages = Number((countRows as { total: number }[])[0]?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalImages / CATALOG_PAGE_SIZE));
  const page = Math.min(clampPage(req.query.page), totalPages);
  const offset = (page - 1) * CATALOG_PAGE_SIZE;
  const [images] = await pool.query(
    `SELECT id, company_uuid, product_name, keywords, barcode, image_path, format, width, height, size_bytes, status, source, created_at, reviewed_at
       FROM catalog_images WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy} LIMIT ${CATALOG_PAGE_SIZE} OFFSET ${offset}`,
    params,
  );

  // ─── Demanda (paginada, com busca) ───
  const demandWhere = q ? 'WHERE term LIKE ?' : '';
  const demandParams = q ? [`%${q}%`] : [];
  const [demandCountRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM catalog_demand ${demandWhere}`,
    demandParams,
  );
  const demandTotal = Number((demandCountRows as { total: number }[])[0]?.total ?? 0);
  const demandTotalPages = Math.max(1, Math.ceil(demandTotal / DEMAND_PAGE_SIZE));
  const demandPage = Math.min(clampPage(req.query.page), demandTotalPages);
  const demandOffset = (demandPage - 1) * DEMAND_PAGE_SIZE;
  const [demandRows] = await pool.query(
    `SELECT id, term, misses, last_seen_at FROM catalog_demand ${demandWhere}
      ORDER BY misses DESC, last_seen_at DESC LIMIT ${DEMAND_PAGE_SIZE} OFFSET ${demandOffset}`,
    demandParams,
  );
  const [aliasStatsRows] = await pool.query(
    'SELECT COUNT(*) AS total, COALESCE(SUM(occurrences), 0) AS hits FROM catalog_image_aliases',
  );
  const aliasStats = (aliasStatsRows as { total: number; hits: number }[])[0] ?? { total: 0, hits: 0 };

  res.render('catalog-queue', {
    images: images as CatalogImageRow[],
    activeStatus,
    activeTab,
    q,
    source,
    format,
    sort,
    page,
    totalImages,
    totalPages,
    pageWindow: pageWindow(page, totalPages),
    demand: demandRows,
    demandPage,
    demandTotal,
    demandTotalPages,
    demandPageWindow: pageWindow(demandPage, demandTotalPages),
    stats: {
      pending: stats?.pending ?? 0,
      approved: stats?.approved ?? 0,
      rejected: stats?.rejected ?? 0,
      storageBytes: stats?.storage_bytes ?? 0,
    },
    aliasStats: { total: Number(aliasStats.total), hits: Number(aliasStats.hits) },
    error: null,
    deleted: req.query.deleted ? Number(req.query.deleted) : null,
  });
});

/** Tira um termo da lista de demanda (já atendido / irrelevante). */
router.post('/catalog/demand/:id/delete', requireAdminAuth, async (req, res) => {
  await getPool().query('DELETE FROM catalog_demand WHERE id = ?', [req.params.id]);
  res.redirect('/admin/catalog?tab=demanda');
});

/** Miniatura no painel de curadoria — serve qualquer status (a pública em /api/catalog/image só serve aprovada). */
router.get('/catalog/:id/image', requireAdminAuth, async (req, res) => {
  const [rows] = await getPool().query('SELECT image_path, format FROM catalog_images WHERE id = ?', [req.params.id]);
  const row = (rows as { image_path: string; format: 'jpeg' | 'png' | 'webp' | 'avif' }[])[0];
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
  const ids = parseCatalogIds(req.body?.ids);
  if (!ids.length) {
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
  const ids = parseCatalogIds(req.body?.ids);
  if (!ids.length) {
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
  const barcode = String(req.header('X-Kivo-Product-Barcode') ?? '').replace(/[^0-9A-Za-z]/g, '').slice(0, 64) || null;
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
       (company_uuid, product_name, keywords, barcode, image_path, sha256, width, height, format, size_bytes, status, source, reviewed_by, reviewed_at)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aprovada', 'manual', ?, NOW(3))`,
    [productName, normalizeKeywords(productName), barcode, filename, hash, check.width, check.height, check.format, body.length, req.adminUsername],
  );
  res.status(201).json({ ok: true, catalogImageId: (info as { insertId: number }).insertId });
});

/**
 * Define/limpa o código de barras de uma imagem já no catálogo. O nome do arquivo raramente
 * traz o EAN; deixar o admin entrar/corrigir o código é o que faz a busca casar exato.
 */
router.post('/catalog/:id/barcode', requireAdminAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Imagem inválida.' });
    return;
  }
  const barcode = String(req.body?.barcode ?? '').replace(/[^0-9A-Za-z]/g, '').slice(0, 64) || null;
  await getPool().query('UPDATE catalog_images SET barcode = ? WHERE id = ?', [barcode, id]);
  res.json({ ok: true, barcode });
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

// --- Busca global do topo: empresa (nome/documento/uuid) e máquina (machine id) ---

router.get('/api/search', requireAdminAuth, async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) {
    res.json({ results: [] });
    return;
  }
  const like = `%${q}%`;
  const pool = getPool();
  const [companyRows] = await pool.query(
    `SELECT company_uuid, name FROM companies
      WHERE name LIKE ? OR document LIKE ? OR company_uuid = ?
      ORDER BY name LIMIT 6`,
    [like, like, q],
  );
  const [deviceRows] = await pool.query(
    `SELECT cd.company_uuid, cd.machine_id, c.name AS company_name
       FROM company_devices cd JOIN companies c ON c.company_uuid = cd.company_uuid
      WHERE cd.machine_id LIKE ?
      ORDER BY cd.last_seen_at DESC LIMIT 6`,
    [like],
  );
  const results = [
    ...(companyRows as { company_uuid: string; name: string | null }[]).map((c) => ({
      type: 'Empresa',
      label: c.name || c.company_uuid,
      sub: c.company_uuid,
      href: `/admin/companies/${c.company_uuid}`,
    })),
    ...(deviceRows as { company_uuid: string; machine_id: string; company_name: string | null }[]).map((d) => ({
      type: 'Máquina',
      label: d.company_name || d.company_uuid,
      sub: `${String(d.machine_id).slice(0, 16)}…`,
      href: `/admin/companies/${d.company_uuid}`,
    })),
  ];
  res.json({ results });
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
  const [payoutRows] = await pool.query(
    `SELECT p.id, p.amount_cents, a.name AS affiliate_name
       FROM affiliate_payouts p LEFT JOIN affiliates a ON a.id = p.affiliate_id
      WHERE p.status = 'solicitado'
      ORDER BY p.id DESC LIMIT 5`,
  );
  res.json({
    unreadTickets: Number((ticketRows as { cnt: number }[])[0]?.cnt ?? 0),
    newLeads: Number((leadRows as { cnt: number }[])[0]?.cnt ?? 0),
    pendingPayouts: Number((payoutRows as unknown[]).length),
    recentTickets: recentTickets as { id: number; subject: string; admin_unread: number; last_message_at: string; company_name: string | null }[],
    recentLeads: recentLeads as { id: number; name: string; whatsapp: string; created_at: string }[],
    recentPayouts: payoutRows as { id: number; amount_cents: number; affiliate_name: string | null }[],
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

// --- Loja de temas (pacotes de ícones) ---

/** Slug de URL a partir do nome: sem acento, minúsculo, só hífens. */
function slugifyTheme(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

const THEME_COVER_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

router.get('/themes', requireAdminAuth, async (req, res) => {
  const pool = getPool();
  const [themes] = await pool.query(
    `SELECT id, slug, name, description, price_cents, cover_path, files_count, active, created_at
       FROM themes ORDER BY active DESC, name ASC`,
  );
  const [grantRows] = await pool.query(
    `SELECT g.theme_id, g.company_uuid, c.name AS company_name
       FROM theme_grants g LEFT JOIN companies c ON c.company_uuid = g.company_uuid
      ORDER BY g.granted_at DESC`,
  );
  const [companyRows] = await pool.query('SELECT company_uuid, name FROM companies ORDER BY name');

  // Agrupa as liberações por tema para a view não varrer a lista toda por linha.
  const grants = new Map<number, { company_uuid: string; company_name: string | null }[]>();
  for (const g of grantRows as { theme_id: number; company_uuid: string; company_name: string | null }[]) {
    const list = grants.get(Number(g.theme_id)) ?? [];
    list.push({ company_uuid: g.company_uuid, company_name: g.company_name });
    grants.set(Number(g.theme_id), list);
  }

  res.render('themes', {
    themes,
    companies: companyRows,
    grants,
    active: 'themes',
    error: typeof req.query.error === 'string' ? req.query.error : null,
    ok: typeof req.query.ok === 'string' ? req.query.ok : null,
  });
});

/** Ícones do tema, para a pré-visualização no painel. */
router.get('/themes/:id/icons', requireAdminAuth, async (req, res) => {
  const [rows] = await getPool().query('SELECT name, pack_json FROM themes WHERE id = ?', [req.params.id]);
  const row = (rows as { name: string; pack_json: string }[])[0];
  if (!row) {
    res.status(404).json({ error: 'Tema não encontrado.' });
    return;
  }
  let icons: Record<string, string> = {};
  try {
    icons = JSON.parse(row.pack_json) as Record<string, string>;
  } catch {
    // pack corrompido: devolve vazio e a tela mostra "sem ícones"
  }
  res.json({ name: row.name, icons });
});

/** Capa do tema para a listagem do painel. */
router.get('/themes/:id/cover', requireAdminAuth, async (req, res) => {
  const [rows] = await getPool().query('SELECT cover_path, cover_mime FROM themes WHERE id = ?', [req.params.id]);
  const row = (rows as { cover_path: string | null; cover_mime: string | null }[])[0];
  const filePath = row?.cover_path ? path.join(THEMES_STORAGE_DIR, path.basename(row.cover_path)) : null;
  if (!filePath || !fs.existsSync(filePath)) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', row!.cover_mime || 'image/jpeg');
  res.send(fs.readFileSync(filePath));
});

/**
 * Cadastra um tema. O corpo vem em JSON (não multipart): os SVGs são texto e a capa vai como
 * data URL base64 — assim não é preciso biblioteca de upload nem de zip em lugar nenhum.
 */
router.post('/themes', requireAdminAuth, async (req, res) => {
  const body = (req.body ?? {}) as {
    name?: unknown;
    description?: unknown;
    free?: unknown;
    priceCents?: unknown;
    coverBase64?: unknown;
    files?: unknown;
  };
  const name = String(body.name ?? '').trim();
  if (name.length < 2) {
    res.status(400).json({ error: 'Informe o nome do tema.' });
    return;
  }

  // `files` = { "cart.svg": "<svg…>", "manifest.json": "{…}" }. Só SVG e manifest entram.
  const rawFiles = body.files && typeof body.files === 'object' ? (body.files as Record<string, unknown>) : {};
  const files: Record<string, string> = {};
  for (const [nome, conteudo] of Object.entries(rawFiles)) {
    const base = path.basename(nome);
    const ehSvg = base.toLowerCase().endsWith('.svg');
    const ehManifest = base.toLowerCase() === 'manifest.json';
    if ((!ehSvg && !ehManifest) || typeof conteudo !== 'string') continue;
    files[base] = conteudo;
  }
  const svgCount = Object.keys(files).filter((f) => f.toLowerCase().endsWith('.svg')).length;
  if (!svgCount) {
    res.status(400).json({ error: 'Envie ao menos um arquivo .svg do tema.' });
    return;
  }

  const priceCents =
    body.free === true || body.free === '1' ? 0 : Math.max(0, Math.round(Number(body.priceCents) || 0));

  const pool = getPool();
  const baseSlug = slugifyTheme(name) || 'tema';
  let slug = baseSlug;
  for (let i = 2; i < 200; i++) {
    const [ex] = await pool.query('SELECT id FROM themes WHERE slug = ?', [slug]);
    if (!(ex as unknown[]).length) break;
    slug = `${baseSlug}-${i}`;
  }

  let coverPath: string | null = null;
  let coverMime: string | null = null;
  const cover = String(body.coverBase64 ?? '');
  const m = cover.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (m) {
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 0 && buf.length <= 6 * 1024 * 1024) {
      coverMime = m[1];
      coverPath = `${slug}-${randomUUID().slice(0, 8)}.${THEME_COVER_EXT[coverMime]}`;
      fs.mkdirSync(THEMES_STORAGE_DIR, { recursive: true });
      fs.writeFileSync(path.join(THEMES_STORAGE_DIR, coverPath), buf);
    }
  }

  await pool.query(
    `INSERT INTO themes (slug, name, description, price_cents, cover_path, cover_mime, pack_json, files_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [slug, name, textOrNull(body.description), priceCents, coverPath, coverMime, JSON.stringify(files), svgCount],
  );
  res.json({ ok: true, slug });
});

/** Edita um tema: nome, descrição, preço e, opcionalmente, capa e ícones. */
router.post('/themes/:id/update', requireAdminAuth, async (req, res) => {
  const body = (req.body ?? {}) as {
    name?: unknown;
    description?: unknown;
    free?: unknown;
    priceCents?: unknown;
    coverBase64?: unknown;
    files?: unknown;
  };
  const id = Number(req.params.id);
  const name = String(body.name ?? '').trim();
  if (!Number.isInteger(id) || name.length < 2) {
    res.status(400).json({ error: 'Informe o nome do tema.' });
    return;
  }
  const pool = getPool();
  const [rows] = await pool.query('SELECT cover_path FROM themes WHERE id = ?', [id]);
  const atual = (rows as { cover_path: string | null }[])[0];
  if (!atual) {
    res.status(404).json({ error: 'Tema não encontrado.' });
    return;
  }

  const priceCents =
    body.free === true || body.free === '1' ? 0 : Math.max(0, Math.round(Number(body.priceCents) || 0));
  // `edited_at` marca a edição manual: o seed pula temas editados para não desfazer nada.
  const sets: string[] = ['name = ?', 'description = ?', 'price_cents = ?', 'edited_at = NOW(3)'];
  const params: unknown[] = [name, textOrNull(body.description), priceCents];

  // Ícones (opcional): se vierem, substituem o pacote inteiro.
  const rawFiles = body.files && typeof body.files === 'object' ? (body.files as Record<string, unknown>) : {};
  const files: Record<string, string> = {};
  for (const [nome, conteudo] of Object.entries(rawFiles)) {
    const base = path.basename(nome);
    const ehSvg = base.toLowerCase().endsWith('.svg');
    const ehManifest = base.toLowerCase() === 'manifest.json';
    if ((!ehSvg && !ehManifest) || typeof conteudo !== 'string') continue;
    files[base] = conteudo;
  }
  const svgCount = Object.keys(files).filter((f) => f.toLowerCase().endsWith('.svg')).length;
  if (svgCount > 0) {
    sets.push('pack_json = ?', 'files_count = ?');
    params.push(JSON.stringify(files), svgCount);
  }

  // Capa (opcional): grava a nova e só depois apaga a antiga.
  const cover = String(body.coverBase64 ?? '');
  const m = cover.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  let novoCover: string | null = null;
  if (m) {
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 0 && buf.length <= 6 * 1024 * 1024) {
      const mime = m[1];
      novoCover = `theme-${id}-${randomUUID().slice(0, 8)}.${THEME_COVER_EXT[mime]}`;
      fs.mkdirSync(THEMES_STORAGE_DIR, { recursive: true });
      fs.writeFileSync(path.join(THEMES_STORAGE_DIR, novoCover), buf);
      sets.push('cover_path = ?', 'cover_mime = ?');
      params.push(novoCover, mime);
    }
  }

  params.push(id);
  await pool.query(`UPDATE themes SET ${sets.join(', ')} WHERE id = ?`, params);

  if (novoCover && atual.cover_path && atual.cover_path !== novoCover) {
    try {
      fs.unlinkSync(path.join(THEMES_STORAGE_DIR, path.basename(atual.cover_path)));
    } catch {
      // Arquivo antigo já não existe.
    }
  }
  res.json({ ok: true, id });
});

router.post('/themes/:id/delete', requireAdminAuth, async (req, res) => {
  const [rows] = await getPool().query('SELECT cover_path FROM themes WHERE id = ?', [req.params.id]);
  const row = (rows as { cover_path: string | null }[])[0];
  if (row?.cover_path) {
    try {
      fs.unlinkSync(path.join(THEMES_STORAGE_DIR, path.basename(row.cover_path)));
    } catch {
      // Arquivo já não existe — o registro some mesmo assim.
    }
  }
  await getPool().query('DELETE FROM theme_grants WHERE theme_id = ?', [req.params.id]);
  await getPool().query('DELETE FROM themes WHERE id = ?', [req.params.id]);
  res.redirect('/admin/themes?ok=removido');
});

router.post('/themes/:id/grant', requireAdminAuth, async (req, res) => {
  const companyUuid = String(req.body?.companyUuid ?? '').trim();
  if (!companyUuid) {
    res.redirect('/admin/themes?error=Selecione+uma+empresa');
    return;
  }
  await getPool().query(
    `INSERT INTO theme_grants (company_uuid, theme_id) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE granted_at = granted_at`,
    [companyUuid, req.params.id],
  );
  res.redirect('/admin/themes?ok=liberado');
});

router.post('/themes/:id/revoke', requireAdminAuth, async (req, res) => {
  await getPool().query('DELETE FROM theme_grants WHERE company_uuid = ? AND theme_id = ?', [
    String(req.body?.companyUuid ?? ''),
    req.params.id,
  ]);
  res.redirect('/admin/themes?ok=revogado');
});

export default router;
