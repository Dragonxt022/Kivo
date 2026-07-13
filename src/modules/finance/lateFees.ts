import { settingsRepository } from '../../core/repositories/SettingsRepository';

export interface LateFeeConfig {
  multaAtiva: boolean;
  multaPercentual: number;
  jurosAtivo: boolean;
  jurosPercentualDia: number;
}

const KEYS = [
  'financeiro.multa_atraso.ativa',
  'financeiro.multa_atraso.percentual',
  'financeiro.juros_atraso.ativo',
  'financeiro.juros_atraso.percentual_dia',
] as const;

export function readLateFeeConfig(): LateFeeConfig {
  const rows = settingsRepository.raw(
    `SELECT key, value FROM settings WHERE key IN (${KEYS.map(() => '?').join(',')}) AND deleted_at IS NULL`,
    ...KEYS,
  ) as { key: string; value: string | null }[];
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    multaAtiva: map['financeiro.multa_atraso.ativa'] === '1',
    multaPercentual: Number(map['financeiro.multa_atraso.percentual'] ?? 0) || 0,
    jurosAtivo: map['financeiro.juros_atraso.ativo'] === '1',
    jurosPercentualDia: Number(map['financeiro.juros_atraso.percentual_dia'] ?? 0) || 0,
  };
}

export interface LateCharges {
  multaCents: number;
  jurosCents: number;
  diasAtraso: number;
}

export function computeLateCharges(baseCents: number, dueDate: string): LateCharges {
  const today = new Date().toISOString().slice(0, 10);
  const dias = Math.floor(
    (new Date(`${today}T00:00:00Z`).getTime() - new Date(`${dueDate}T00:00:00Z`).getTime()) / 86400000,
  );
  if (!Number.isFinite(dias) || dias <= 0) return { multaCents: 0, jurosCents: 0, diasAtraso: 0 };
  const cfg = readLateFeeConfig();
  const multaCents = cfg.multaAtiva ? Math.round((baseCents * cfg.multaPercentual) / 100) : 0;
  const jurosCents = cfg.jurosAtivo ? Math.round(baseCents * (cfg.jurosPercentualDia / 100) * dias) : 0;
  return { multaCents, jurosCents, diasAtraso: dias };
}
