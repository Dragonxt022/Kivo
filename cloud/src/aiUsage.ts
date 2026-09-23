import { getPool } from './db';

/**
 * Medição de uso da KIVO IA e créditos por empresa.
 *
 * O teto (`companies.ai_token_limit`) é em TOKENS; 0 = ilimitado. O consumo zera a cada mês
 * de calendário (`ai_period` = AAAA-MM). O detalhe de cada requisição vai para `ai_usage`,
 * que alimenta os gráficos do painel.
 */

export function currentPeriod(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface AiCredits {
  /** 0 = ilimitado. */
  limit: number;
  used: number;
  period: string | null;
}

/** Zera o consumo quando o período virou (reset mensal). */
export async function ensurePeriod(companyUuid: string, period: string): Promise<void> {
  await getPool().query(
    'UPDATE companies SET ai_tokens_used = 0, ai_period = ? WHERE company_uuid = ? AND (ai_period IS NULL OR ai_period <> ?)',
    [period, companyUuid, period],
  );
}

export async function getCredits(companyUuid: string): Promise<AiCredits | null> {
  const [rows] = await getPool().query(
    'SELECT ai_token_limit, ai_tokens_used, ai_period FROM companies WHERE company_uuid = ?',
    [companyUuid],
  );
  const r = (rows as { ai_token_limit: number; ai_tokens_used: number; ai_period: string | null }[])[0];
  if (!r) return null;
  return { limit: Number(r.ai_token_limit), used: Number(r.ai_tokens_used), period: r.ai_period };
}

/** Grava o consumo de uma requisição e soma no total da empresa (transação). */
export async function recordUsage(
  companyUuid: string,
  period: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
): Promise<void> {
  const total = Math.max(0, Math.round(promptTokens)) + Math.max(0, Math.round(completionTokens));
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      'INSERT INTO ai_usage (company_uuid, period, model, prompt_tokens, completion_tokens, total_tokens) VALUES (?, ?, ?, ?, ?, ?)',
      [companyUuid, period, model, Math.round(promptTokens), Math.round(completionTokens), total],
    );
    await conn.query(
      'UPDATE companies SET ai_tokens_used = ai_tokens_used + ?, ai_period = ? WHERE company_uuid = ?',
      [total, period, companyUuid],
    );
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}
