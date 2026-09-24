import { getPool } from './db';
import { dateInTz } from './tz';

/**
 * Cota diária das ferramentas de IA que COBRAM créditos (por uso).
 *
 * O suporte é grátis e não passa por aqui. Cada ferramenta tem um custo (créditos por uso) e
 * uma cota diária padrão (`ai_tools`), com override opcional por empresa
 * (`company_ai_quotas.daily_limit`). O consumo zera sozinho quando vira o dia — a comparação é
 * `period_day` (AAAA-MM-DD no fuso do cliente), então a "meia-noite" é a do lojista.
 *
 * A reserva é ATÔMICA (um único UPDATE condicional): duas chamadas simultâneas não furam o
 * teto. Se a ferramenta falhar depois de reservar, `refund` devolve o crédito.
 */

export interface AiTool {
  id: string;
  label: string;
  description: string | null;
  cost: number;
  dailyCredits: number;
  enabled: boolean;
}

export interface QuotaStatus {
  feature: string;
  /** 0 = ilimitado. */
  limit: number;
  used: number;
  /** -1 = ilimitado. */
  remaining: number;
  periodDay: string;
  cost: number;
  /** Próximo dia (AAAA-MM-DD) — quando a cota renova. */
  resetAt: string;
}

export async function loadTool(id: string): Promise<AiTool | null> {
  const [rows] = await getPool().query(
    'SELECT id, label, description, cost, daily_credits, enabled FROM ai_tools WHERE id = ?',
    [id],
  );
  const r = (rows as Record<string, unknown>[])[0];
  if (!r) return null;
  return {
    id: String(r.id),
    label: String(r.label),
    description: r.description == null ? null : String(r.description),
    cost: Number(r.cost),
    dailyCredits: Number(r.daily_credits),
    enabled: Number(r.enabled) === 1,
  };
}

export async function listTools(): Promise<AiTool[]> {
  const [rows] = await getPool().query(
    'SELECT id, label, description, cost, daily_credits, enabled FROM ai_tools ORDER BY label',
  );
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    label: String(r.label),
    description: r.description == null ? null : String(r.description),
    cost: Number(r.cost),
    dailyCredits: Number(r.daily_credits),
    enabled: Number(r.enabled) === 1,
  }));
}

export async function updateTool(id: string, patch: { cost?: number; dailyCredits?: number; enabled?: boolean }): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.cost !== undefined) { fields.push('cost = ?'); values.push(Math.max(1, Math.floor(patch.cost))); }
  if (patch.dailyCredits !== undefined) { fields.push('daily_credits = ?'); values.push(Math.max(0, Math.floor(patch.dailyCredits))); }
  if (patch.enabled !== undefined) { fields.push('enabled = ?'); values.push(patch.enabled ? 1 : 0); }
  if (!fields.length) return;
  values.push(id);
  await getPool().query(`UPDATE ai_tools SET ${fields.join(', ')} WHERE id = ?`, values);
}

/** Define (ou limpa, com null) o limite diário específico de uma empresa para a ferramenta. */
export async function setCompanyLimit(companyUuid: string, feature: string, dailyLimit: number | null): Promise<void> {
  await getPool().query(
    `INSERT INTO company_ai_quotas (company_uuid, feature, daily_limit, used, period_day)
     VALUES (?, ?, ?, 0, NULL)
     ON DUPLICATE KEY UPDATE daily_limit = VALUES(daily_limit)`,
    [companyUuid, feature, dailyLimit],
  );
}

/** Situação da cota do dia para a empresa/ferramenta. `null` se a ferramenta não existe. */
export async function quotaStatus(companyUuid: string, feature: string, tz: string): Promise<QuotaStatus | null> {
  const tool = await loadTool(feature);
  if (!tool) return null;
  const today = dateInTz(tz, 0);
  const [rows] = await getPool().query(
    'SELECT daily_limit, used, period_day FROM company_ai_quotas WHERE company_uuid = ? AND feature = ?',
    [companyUuid, feature],
  );
  const r = (rows as Record<string, unknown>[])[0];
  const override = r && r.daily_limit != null ? Number(r.daily_limit) : null;
  const limit = override != null ? override : tool.dailyCredits;
  const used = r && String(r.period_day) === today ? Number(r.used) : 0;
  return {
    feature,
    limit,
    used,
    remaining: limit > 0 ? Math.max(0, limit - used) : -1,
    periodDay: today,
    cost: tool.cost,
    resetAt: dateInTz(tz, 1),
  };
}

export type ReserveResult = { ok: true; tool: AiTool; status: QuotaStatus } | { ok: false; tool: AiTool | null; status: QuotaStatus };

/** Reserva um uso (atômico). `ok=false` quando a cota do dia acabou ou a ferramenta está off. */
export async function reserve(companyUuid: string, feature: string, tz: string): Promise<ReserveResult> {
  const tool = await loadTool(feature);
  const today = dateInTz(tz, 0);
  if (!tool || !tool.enabled) {
    const status = await quotaStatus(companyUuid, feature, tz);
    return { ok: false, tool, status: status ?? { feature, limit: 0, used: 0, remaining: 0, periodDay: today, cost: 0, resetAt: dateInTz(tz, 1) } };
  }
  const pool = getPool();
  // Garante a linha da empresa/ferramenta.
  await pool.query(
    'INSERT INTO company_ai_quotas (company_uuid, feature, daily_limit, used, period_day) VALUES (?, ?, NULL, 0, NULL) ON DUPLICATE KEY UPDATE company_uuid = company_uuid',
    [companyUuid, feature],
  );
  const [orows] = await pool.query(
    'SELECT daily_limit FROM company_ai_quotas WHERE company_uuid = ? AND feature = ?',
    [companyUuid, feature],
  );
  const override = (orows as Record<string, unknown>[])[0]?.daily_limit;
  const limit = override != null ? Number(override) : tool.dailyCredits;
  const cost = tool.cost;
  const [res] = await pool.query(
    `UPDATE company_ai_quotas
        SET used = CASE WHEN period_day = ? THEN used + ? ELSE ? END,
            period_day = ?
      WHERE company_uuid = ? AND feature = ?
        AND (period_day <> ? OR ? = 0 OR used + ? <= ?)`,
    [today, cost, cost, today, companyUuid, feature, today, limit, cost, limit],
  );
  const status = await quotaStatus(companyUuid, feature, tz);
  const affected = (res as { affectedRows?: number }).affectedRows ?? 0;
  return affected === 0
    ? { ok: false, tool, status: status! }
    : { ok: true, tool, status: status! };
}

/** Devolve o crédito reservado quando a ferramenta falha depois de reservar. */
export async function refund(companyUuid: string, feature: string, tz: string): Promise<void> {
  const tool = await loadTool(feature);
  const cost = tool ? tool.cost : 1;
  await getPool().query(
    `UPDATE company_ai_quotas SET used = GREATEST(0, used - ?)
      WHERE company_uuid = ? AND feature = ? AND period_day = ?`,
    [cost, companyUuid, feature, dateInTz(tz, 0)],
  );
}
