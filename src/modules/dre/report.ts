import { getSqlite } from '../../core/database/connection';

export type DreLine = 'receita_bruta' | 'deducoes' | 'cmv' | 'despesas_operacionais' | 'despesas_financeiras';

interface CategoryRow {
  id: number;
  key: string;
  label: string;
  dre_line: DreLine;
  source: 'manual' | 'sales_revenue' | 'cogs' | 'card_fees';
  system: number;
  adjustment_bps: number;
  sort: number;
}

export interface DreCategoryResult {
  id: number;
  key: string;
  label: string;
  system: boolean;
  adjustmentBps: number;
  realCents: number;
  adjustedCents: number;
}

export interface DreLineResult {
  line: DreLine;
  categories: DreCategoryResult[];
  realCents: number;
  adjustedCents: number;
}

export interface DreReport {
  from: string;
  to: string;
  lines: Record<DreLine, DreLineResult>;
  totals: {
    receitaBrutaReal: number; receitaBrutaAjustada: number;
    receitaLiquidaReal: number; receitaLiquidaAjustada: number;
    lucroBrutoReal: number; lucroBrutoAjustada: number;
    resultadoOperacionalReal: number; resultadoOperacionalAjustada: number;
    resultadoLiquidoReal: number; resultadoLiquidoAjustada: number;
  };
}

function adjust(realCents: number, adjustmentBps: number): number {
  return realCents + Math.round((realCents * adjustmentBps) / 10000);
}

/** Demonstrativo de Resultado do Exercício, por competência (due_date/data da venda), no intervalo [from, to]. */
export function demonstrativoResultado(from: string, to: string): DreReport {
  const db = getSqlite();

  const categories = db.prepare(
    `SELECT id, key, label, dre_line, source, system, adjustment_bps, sort
     FROM dre_categories WHERE active = 1 AND deleted_at IS NULL ORDER BY dre_line, sort, label`,
  ).all() as CategoryRow[];

  const salesRevenueReal = (db.prepare(
    `SELECT COALESCE(SUM(total_cents), 0) AS v FROM sales
     WHERE status = 'concluida' AND deleted_at IS NULL AND date(created_at) BETWEEN ? AND ?`,
  ).get(from, to) as { v: number }).v;

  const cogsReal = (db.prepare(
    `SELECT COALESCE(SUM(i.qty * p.cost_cents), 0) AS v
     FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN products p ON p.id = i.product_id
     WHERE s.status = 'concluida' AND s.deleted_at IS NULL AND date(s.created_at) BETWEEN ? AND ?`,
  ).get(from, to) as { v: number }).v;

  const cardFeesReal = (db.prepare(
    `SELECT COALESCE(SUM(sp.fee_cents), 0) AS v
     FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
     WHERE s.status = 'concluida' AND s.deleted_at IS NULL AND date(s.created_at) BETWEEN ? AND ?`,
  ).get(from, to) as { v: number }).v;

  const manualByCategory = new Map<number, number>();
  for (const row of db.prepare(
    `SELECT dre_category_id AS id, COALESCE(SUM(amount_cents), 0) AS v
     FROM payables WHERE status != 'cancelada' AND deleted_at IS NULL AND dre_category_id IS NOT NULL
       AND due_date BETWEEN ? AND ?
     GROUP BY dre_category_id`,
  ).all(from, to) as { id: number; v: number }[]) {
    manualByCategory.set(row.id, row.v);
  }

  const realByCategory = (cat: CategoryRow): number => {
    if (cat.source === 'sales_revenue') return salesRevenueReal;
    if (cat.source === 'cogs') return cogsReal;
    if (cat.source === 'card_fees') return cardFeesReal;
    return manualByCategory.get(cat.id) ?? 0;
  };

  const lineOrder: DreLine[] = ['receita_bruta', 'deducoes', 'cmv', 'despesas_operacionais', 'despesas_financeiras'];
  const lines = {} as Record<DreLine, DreLineResult>;
  for (const line of lineOrder) {
    const cats = categories.filter((c) => c.dre_line === line).map((c) => {
      const realCents = realByCategory(c);
      return {
        id: c.id, key: c.key, label: c.label, system: !!c.system,
        adjustmentBps: c.adjustment_bps, realCents, adjustedCents: adjust(realCents, c.adjustment_bps),
      };
    });
    lines[line] = {
      line, categories: cats,
      realCents: cats.reduce((s, c) => s + c.realCents, 0),
      adjustedCents: cats.reduce((s, c) => s + c.adjustedCents, 0),
    };
  }

  const receitaBrutaReal = lines.receita_bruta.realCents;
  const receitaBrutaAjustada = lines.receita_bruta.adjustedCents;
  const receitaLiquidaReal = receitaBrutaReal - lines.deducoes.realCents;
  const receitaLiquidaAjustada = receitaBrutaAjustada - lines.deducoes.adjustedCents;
  const lucroBrutoReal = receitaLiquidaReal - lines.cmv.realCents;
  const lucroBrutoAjustada = receitaLiquidaAjustada - lines.cmv.adjustedCents;
  const resultadoOperacionalReal = lucroBrutoReal - lines.despesas_operacionais.realCents;
  const resultadoOperacionalAjustada = lucroBrutoAjustada - lines.despesas_operacionais.adjustedCents;
  const resultadoLiquidoReal = resultadoOperacionalReal - lines.despesas_financeiras.realCents;
  const resultadoLiquidoAjustada = resultadoOperacionalAjustada - lines.despesas_financeiras.adjustedCents;

  return {
    from, to, lines,
    totals: {
      receitaBrutaReal, receitaBrutaAjustada,
      receitaLiquidaReal, receitaLiquidaAjustada,
      lucroBrutoReal, lucroBrutoAjustada,
      resultadoOperacionalReal, resultadoOperacionalAjustada,
      resultadoLiquidoReal, resultadoLiquidoAjustada,
    },
  };
}
