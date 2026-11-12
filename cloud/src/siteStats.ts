import { getPool } from './db';

/**
 * Números públicos do Kuruk Cloud.
 *
 * A landing deixou de ser só uma página de venda e passou a contar a história da
 * empresa. Para isso ela mostra dados agregados e reais do banco: quantos negócios
 * estão cadastrados, quantos estão usando o sistema, quantos dispositivos estão
 * ativos e como a base cresceu mês a mês.
 *
 * Regras:
 * - Nunca expõe nome, e-mail, documento ou qualquer dado individual de cliente.
 * - Cache curto em memória (60 s) para não consultar o banco a cada visita.
 * - Se o banco cair, devolve o último retrato conhecido; sem retrato, devolve
 *   `live: false` para a página avisar em vez de mostrar zeros como se fossem reais.
 */

export type GrowthPoint = {
  /** Chave `YYYY-MM`. */
  key: string;
  /** Rótulo curto em português (jan, fev...). */
  label: string;
  /** Negócios que entraram naquele mês. */
  newCompanies: number;
  /** Total acumulado até o fim daquele mês. */
  totalCompanies: number;
};

export type SiteStats = {
  live: boolean;
  totalCompanies: number;
  activeCompanies: number;
  payingCompanies: number;
  activeDevices: number;
  syncRecords: number;
  states: number;
  growth: GrowthPoint[];
  firstCompanyAt: string | null;
  lastSyncAt: string | null;
  updatedAt: string;
};

const CACHE_TTL_MS = 60_000;
const WINDOW_MONTHS = 6;
const MONTH_LABELS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

let cached: { at: number; data: SiteStats } | null = null;

function emptyStats(live: boolean): SiteStats {
  return {
    live,
    totalCompanies: 0,
    activeCompanies: 0,
    payingCompanies: 0,
    activeDevices: 0,
    syncRecords: 0,
    states: 0,
    growth: [],
    firstCompanyAt: null,
    lastSyncAt: null,
    updatedAt: new Date().toISOString(),
  };
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Monta a série dos últimos 6 meses. O total acumulado parte da base anterior à
 * janela, então a linha continua correta mesmo quando a empresa já tinha clientes
 * antes do primeiro mês exibido.
 */
function buildGrowth(
  countByMonth: Map<string, number>,
  baseBeforeWindow: number,
  totalNow: number,
  now: Date,
): GrowthPoint[] {
  const points: GrowthPoint[] = [];
  let running = baseBeforeWindow;

  for (let i = WINDOW_MONTHS - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = monthKey(d);
    const newCompanies = countByMonth.get(key) ?? 0;
    running += newCompanies;
    points.push({
      key,
      label: MONTH_LABELS[d.getMonth()],
      newCompanies,
      totalCompanies: running,
    });
  }

  // Pequena proteção contra divergência de fuso/relógio entre as consultas:
  // o último ponto representa o total atual do banco.
  if (points.length) points[points.length - 1].totalCompanies = totalNow;
  return points;
}

export async function getSiteStats(): Promise<SiteStats> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  try {
    const pool = getPool();

    const [kpiRows] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM companies) AS total_companies,
         (SELECT COUNT(DISTINCT company_uuid)
            FROM sync_records
           WHERE server_received_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS active_companies,
         (SELECT COUNT(*) FROM companies
           WHERE plan IS NOT NULL AND plan <> '' AND plan <> 'trial') AS paying_companies,
         (SELECT COUNT(*) FROM company_devices WHERE removed_at IS NULL) AS active_devices,
         (SELECT COUNT(*) FROM sync_records) AS sync_records,
         (SELECT COUNT(DISTINCT state) FROM companies
           WHERE state IS NOT NULL AND state <> '') AS states,
         (SELECT MIN(created_at) FROM companies) AS first_company_at,
         (SELECT MAX(server_received_at) FROM sync_records) AS last_sync_at`,
    );

    const kpis = (kpiRows as Record<string, unknown>[])[0] ?? {};

    const now = new Date();
    const windowStart = new Date(now.getFullYear(), now.getMonth() - (WINDOW_MONTHS - 1), 1);

    const [monthRows] = await pool.query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m') AS ym, COUNT(*) AS n
         FROM companies
        WHERE created_at >= ?
        GROUP BY ym
        ORDER BY ym ASC`,
      [windowStart],
    );

    const countByMonth = new Map<string, number>();
    for (const row of monthRows as { ym: string; n: number }[]) {
      countByMonth.set(String(row.ym), Number(row.n) || 0);
    }

    const [baseRows] = await pool.query(
      `SELECT COUNT(*) AS n FROM companies WHERE created_at < ?`,
      [windowStart],
    );
    const baseBeforeWindow = Number((baseRows as { n: number }[])[0]?.n) || 0;
    const totalCompanies = Number(kpis.total_companies) || 0;

    const data: SiteStats = {
      live: true,
      totalCompanies,
      activeCompanies: Number(kpis.active_companies) || 0,
      payingCompanies: Number(kpis.paying_companies) || 0,
      activeDevices: Number(kpis.active_devices) || 0,
      syncRecords: Number(kpis.sync_records) || 0,
      states: Number(kpis.states) || 0,
      growth: buildGrowth(countByMonth, baseBeforeWindow, totalCompanies, now),
      firstCompanyAt: (kpis.first_company_at as string | null) ?? null,
      lastSyncAt: (kpis.last_sync_at as string | null) ?? null,
      updatedAt: new Date().toISOString(),
    };

    cached = { at: Date.now(), data };
    return data;
  } catch (error) {
    console.error('[site-stats] falha ao consultar os números públicos:', error);
    // Mantém o último retrato conhecido; se nunca houve, sinaliza indisponível.
    return cached?.data ?? emptyStats(false);
  }
}
