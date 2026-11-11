import { Router } from 'express';
import { getPool } from '../db';
import { requireAdminAuth } from '../adminAuth';

/**
 * Uso do sistema por empresa, para o suporte enxergar quem está realmente usando o Kuruk:
 * última atividade, frequência de sincronização, horários, módulos mais sincronizados e
 * dispositivos. Lê `sync_records` (registros sincronizados) e `company_devices`
 * (validações de licença), sem expor payload — só metadados.
 */

const router = Router();

const PERIODS = [7, 30, 90] as const;
type Period = (typeof PERIODS)[number];

const MODULE_LABELS: Record<string, string> = {
  commercial: 'Comercial',
  store: 'PDV / Vendas',
  finance: 'Financeiro',
  comandas: 'Comandas / Mesas',
  foodservice: 'Cozinha',
  odonto: 'Odonto',
  fiscal: 'Fiscal',
  labels: 'Etiquetas',
  dre: 'DRE',
  maisdelivery: 'Mais Delivery',
  nfe: 'NF-e',
  core: 'Sistema',
};

function parsePeriod(value: unknown): Period {
  const n = Number(value);
  return n === 7 || n === 90 ? n : 30;
}

function moduleLabel(key: string | null): string {
  const k = String(key || '');
  return MODULE_LABELS[k] ?? (k ? k.charAt(0).toUpperCase() + k.slice(1) : 'Outros');
}

function asDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(String(value).replace(' ', 'T'));
  return Number.isFinite(d.getTime()) ? d : null;
}

function latest(a: string | null | undefined, b: string | null | undefined): string | null {
  const da = asDate(a);
  const db = asDate(b);
  if (!da) return b ? String(b) : null;
  if (!db) return String(a);
  return da >= db ? String(a) : String(b);
}

function relative(value: string | null | undefined): string {
  const d = asDate(value);
  if (!d) return 'Sem atividade';
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'agora';
  if (mins < 60) return `há ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'ontem';
  if (days < 30) return `há ${days} dias`;
  const months = Math.floor(days / 30);
  return `há ${months} ${months === 1 ? 'mês' : 'meses'}`;
}

function activityStatus(value: string | null | undefined): { label: string; tone: 'on' | 'warn' | 'off' } {
  const d = asDate(value);
  if (!d) return { label: 'Sem atividade', tone: 'off' };
  const hours = (Date.now() - d.getTime()) / 3600e3;
  if (hours <= 24) return { label: 'Ativo hoje', tone: 'on' };
  if (hours <= 24 * 7) return { label: 'Ativo na semana', tone: 'warn' };
  return { label: 'Sem uso recente', tone: 'off' };
}

function percent(part: number, total: number): number {
  return total > 0 ? Math.max(1, Math.round((part / total) * 100)) : 0;
}

router.get('/usage', requireAdminAuth, async (req, res) => {
  const period = parsePeriod(req.query.period);
  const q = String(req.query.q ?? '').trim().slice(0, 120);
  const filter = req.query.filter === 'all' ? 'all' : 'active';
  const requestedPage = Math.max(1, Number(req.query.page) || 1);
  const perPage = 25;
  const pool = getPool();

  const companyParams: unknown[] = [];
  let companyWhere = '';
  if (q) {
    companyWhere = 'WHERE (c.name LIKE ? OR c.email LIKE ?)';
    companyParams.push(`%${q}%`, `%${q}%`);
  }

  const [companyRows] = await pool.query(
    `SELECT c.company_uuid, c.name, c.email, c.plan, c.valid_until
       FROM companies c
       ${companyWhere}
      ORDER BY c.name
      LIMIT 500`,
    companyParams,
  );

  const [deviceRows] = await pool.query(
    `SELECT company_uuid, COUNT(*) AS devices, MAX(last_seen_at) AS last_device_seen
       FROM company_devices
      WHERE removed_at IS NULL
      GROUP BY company_uuid`,
  );

  const [syncRows] = await pool.query(
    `SELECT company_uuid,
            COUNT(*) AS syncs,
            SUM(CASE WHEN entity_type = 'store.sales' THEN 1 ELSE 0 END) AS sales,
            MAX(server_received_at) AS last_sync,
            MAX(CASE WHEN entity_type = 'store.sales' THEN server_received_at END) AS last_sale,
            COUNT(DISTINCT DATE(server_received_at)) AS active_days
       FROM sync_records
      WHERE server_received_at >= DATE_SUB(NOW(3), INTERVAL ? DAY)
      GROUP BY company_uuid`,
    [period],
  );

  const [moduleRows] = await pool.query(
    `SELECT company_uuid,
            SUBSTRING_INDEX(entity_type, '.', 1) AS module_key,
            COUNT(*) AS total,
            MAX(server_received_at) AS last_at
       FROM sync_records
      WHERE server_received_at >= DATE_SUB(NOW(3), INTERVAL ? DAY)
      GROUP BY company_uuid, module_key
      ORDER BY total DESC`,
    [period],
  );

  type CompanyRow = { company_uuid: string; name: string | null; email: string | null; plan: string | null; valid_until: string | null };
  type DeviceAgg = { company_uuid: string; devices: number; last_device_seen: string | null };
  type SyncAgg = { company_uuid: string; syncs: number; sales: number; last_sync: string | null; last_sale: string | null; active_days: number };
  type ModuleAgg = { company_uuid: string; module_key: string; total: number; last_at: string | null };

  const devicesByCompany = new Map((deviceRows as DeviceAgg[]).map((r) => [r.company_uuid, r]));
  const syncByCompany = new Map((syncRows as SyncAgg[]).map((r) => [r.company_uuid, r]));
  const modulesByCompany = new Map<string, { key: string; label: string; total: number; last_at: string | null }[]>();
  for (const row of moduleRows as ModuleAgg[]) {
    const list = modulesByCompany.get(row.company_uuid) ?? [];
    list.push({ key: row.module_key, label: moduleLabel(row.module_key), total: Number(row.total), last_at: row.last_at });
    modulesByCompany.set(row.company_uuid, list);
  }

  const rows = (companyRows as CompanyRow[]).map((company) => {
    const sync = syncByCompany.get(company.company_uuid);
    const device = devicesByCompany.get(company.company_uuid);
    const last = latest(sync?.last_sync, device?.last_device_seen);
    const mods = (modulesByCompany.get(company.company_uuid) ?? []).slice(0, 3);
    return {
      ...company,
      syncs: Number(sync?.syncs ?? 0),
      sales: Number(sync?.sales ?? 0),
      active_days: Number(sync?.active_days ?? 0),
      last_sync: sync?.last_sync ?? null,
      last_sale: sync?.last_sale ?? null,
      devices: Number(device?.devices ?? 0),
      last_device_seen: device?.last_device_seen ?? null,
      last_activity: last,
      last_activity_label: relative(last),
      status: activityStatus(last),
      modules: mods,
    };
  });
  rows.sort((a, b) => (asDate(b.last_activity)?.getTime() ?? 0) - (asDate(a.last_activity)?.getTime() ?? 0));

  const totalCompanies = rows.length;
  const periodStart = Date.now() - period * 86400e3;
  const activeInPeriod = rows.filter(
    (r) => r.syncs > 0 || (asDate(r.last_device_seen)?.getTime() ?? 0) >= periodStart,
  );
  const filteredRows = filter === 'all' ? rows : activeInPeriod;
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / perPage));
  const page = Math.min(requestedPage, totalPages);
  const pageRows = filteredRows.slice((page - 1) * perPage, page * perPage);

  const summary = {
    companies: totalCompanies,
    activeToday: rows.filter((r) => r.status.tone === 'on').length,
    activeWeek: rows.filter((r) => r.status.tone !== 'off').length,
    syncs: rows.reduce((sum, r) => sum + r.syncs, 0),
    sales: rows.reduce((sum, r) => sum + r.sales, 0),
    noActivity: rows.filter((r) => !r.last_activity).length,
  };

  res.render('usage', {
    companies: pageRows,
    summary,
    period,
    periods: PERIODS,
    q,
    filter,
    page,
    perPage,
    totalPages,
    totalFiltered: filteredRows.length,
    moduleLabel,
  });
});

router.get('/usage/:uuid', requireAdminAuth, async (req, res) => {
  const uuid = String(req.params.uuid);
  const period = parsePeriod(req.query.period);
  const dailyDays = period === 90 ? 30 : period;
  const pool = getPool();

  const [companyRows] = await pool.query(
    `SELECT company_uuid, name, email, phone, plan, valid_until, created_at
       FROM companies WHERE company_uuid = ?`,
    [uuid],
  );
  const company = (companyRows as {
    company_uuid: string; name: string | null; email: string | null; phone: string | null;
    plan: string | null; valid_until: string | null; created_at: string | null;
  }[])[0];
  if (!company) {
    res.status(404).send('Empresa não encontrada.');
    return;
  }

  const [deviceRows] = await pool.query(
    `SELECT machine_id, app_version, first_seen_at, last_seen_at
       FROM company_devices
      WHERE company_uuid = ? AND removed_at IS NULL
      ORDER BY last_seen_at DESC`,
    [uuid],
  );

  const [syncSummaryRows] = await pool.query(
    `SELECT COUNT(*) AS syncs,
            SUM(CASE WHEN entity_type = 'store.sales' THEN 1 ELSE 0 END) AS sales,
            MAX(server_received_at) AS last_sync,
            MAX(CASE WHEN entity_type = 'store.sales' THEN server_received_at END) AS last_sale,
            COUNT(DISTINCT DATE(server_received_at)) AS active_days
       FROM sync_records
      WHERE company_uuid = ? AND server_received_at >= DATE_SUB(NOW(3), INTERVAL ? DAY)`,
    [uuid, period],
  );
  const syncSummary = (syncSummaryRows as {
    syncs: number; sales: number; last_sync: string | null; last_sale: string | null; active_days: number;
  }[])[0] ?? {
    syncs: 0, sales: 0, last_sync: null, last_sale: null, active_days: 0,
  };

  const [moduleRows] = await pool.query(
    `SELECT SUBSTRING_INDEX(entity_type, '.', 1) AS module_key,
            COUNT(*) AS total,
            MAX(server_received_at) AS last_at
       FROM sync_records
      WHERE company_uuid = ? AND server_received_at >= DATE_SUB(NOW(3), INTERVAL ? DAY)
      GROUP BY module_key
      ORDER BY total DESC`,
    [uuid, period],
  );
  const modules = (moduleRows as { module_key: string; total: number; last_at: string | null }[]).map((m) => ({
    key: m.module_key,
    label: moduleLabel(m.module_key),
    total: Number(m.total),
    last_at: m.last_at,
  }));
  const moduleTotal = modules.reduce((sum, m) => sum + m.total, 0);
  modules.forEach((m) => { (m as { pct?: number }).pct = percent(m.total, moduleTotal); });

  const [hourRows] = await pool.query(
    `SELECT HOUR(server_received_at) AS hour, COUNT(*) AS total
       FROM sync_records
      WHERE company_uuid = ? AND server_received_at >= DATE_SUB(NOW(3), INTERVAL ? DAY)
      GROUP BY hour
      ORDER BY hour`,
    [uuid, period],
  );
  const hourMap = new Map<number, number>();
  for (const r of hourRows as { hour: number; total: number }[]) hourMap.set(Number(r.hour), Number(r.total));
  const hourMax = Math.max(1, ...Array.from(hourMap.values()));
  const hours = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    total: hourMap.get(h) ?? 0,
    pct: Math.round(((hourMap.get(h) ?? 0) / hourMax) * 100),
  }));

  const [dayRows] = await pool.query(
    `SELECT DATE(server_received_at) AS day, COUNT(*) AS total
       FROM sync_records
      WHERE company_uuid = ? AND server_received_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY day
      ORDER BY day`,
    [uuid, dailyDays],
  );
  const dayMap = new Map<string, number>();
  for (const r of dayRows as { day: string; total: number }[]) dayMap.set(String(r.day).slice(0, 10), Number(r.total));
  const today = new Date();
  const days = Array.from({ length: dailyDays }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (dailyDays - 1 - i));
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { day: key, total: dayMap.get(key) ?? 0 };
  });
  const dayMax = Math.max(1, ...days.map((d) => d.total));
  days.forEach((d) => { (d as { pct?: number }).pct = Math.round((d.total / dayMax) * 100); });

  const [recentRows] = await pool.query(
    `SELECT entity_type, server_received_at, origin_machine
       FROM sync_records
      WHERE company_uuid = ?
      ORDER BY server_received_at DESC
      LIMIT 40`,
    [uuid],
  );
  const recent = (recentRows as { entity_type: string; server_received_at: string; origin_machine: string }[]).map((r) => ({
    ...r,
    module_label: moduleLabel(String(r.entity_type).split('.')[0]),
  }));

  const [errorRows] = await pool.query(
    `SELECT COUNT(*) AS total, MAX(last_seen_at) AS last_at
       FROM client_error_reports
      WHERE company_uuid = ? AND last_seen_at >= DATE_SUB(NOW(3), INTERVAL ? DAY)`,
    [uuid, period],
  );
  const errors = (errorRows as { total: number; last_at: string | null }[])[0] ?? { total: 0, last_at: null };

  const [aiRows] = await pool.query(
    `SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS tokens
       FROM ai_usage
      WHERE company_uuid = ? AND created_at >= DATE_SUB(NOW(3), INTERVAL ? DAY)`,
    [uuid, period],
  );
  const ai = (aiRows as { calls: number; tokens: number }[])[0] ?? { calls: 0, tokens: 0 };

  const [inventoryRows] = await pool.query(
    `SELECT os, cpu, ram_gb, app_version, last_seen_at
       FROM client_machine_inventory
      WHERE company_uuid = ?
      ORDER BY last_seen_at DESC
      LIMIT 10`,
    [uuid],
  );

  const devices = deviceRows as { machine_id: string; app_version: string | null; first_seen_at: string; last_seen_at: string }[];
  const lastActivity = latest(syncSummary.last_sync, devices[0]?.last_seen_at);

  res.render('usage-detail', {
    company,
    period,
    periods: PERIODS,
    syncSummary,
    lastActivity,
    lastActivityLabel: relative(lastActivity),
    status: activityStatus(lastActivity),
    modules,
    moduleTotal,
    hours,
    days,
    recent,
    devices,
    errors,
    ai,
    inventory: inventoryRows as { os: string | null; cpu: string | null; ram_gb: number | null; app_version: string | null; last_seen_at: string }[],
    moduleLabel,
  });
});

export default router;
