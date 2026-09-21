import { getSqlite } from '../../core/database/connection';

export type DreLine = 'receita_bruta' | 'deducoes' | 'cmv' | 'despesas_operacionais' | 'despesas_financeiras';

/** Base de apuração: por competência (emissão/venda) ou por caixa (efetivamente pago/recebido). */
export type DreBasis = 'competencia' | 'caixa';

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
  basis: DreBasis;
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

type Db = ReturnType<typeof getSqlite>;

const SALES_LOCAL_DATE = "date(s.created_at, 'localtime')";

/** Receita de vendas por competência (data da venda). */
function revenueCompetencia(db: Db, from: string, to: string): number {
  return (db.prepare(
    `SELECT COALESCE(SUM(s.total_cents), 0) AS v FROM sales s
     WHERE s.status = 'concluida' AND s.deleted_at IS NULL AND ${SALES_LOCAL_DATE} BETWEEN ? AND ?`,
  ).get(from, to) as { v: number }).v;
}

/**
 * Receita por caixa: recebimentos imediatos (dinheiro/cartão/PIX) + contas a receber
 * quitadas no período. Formas que não entram dinheiro (prazo/convênio/crédito/fidelidade)
 * ficam de fora dos pagamentos e entram quando o título correspondente é recebido.
 */
function revenueCaixa(db: Db, from: string, to: string): number {
  const immediate = (db.prepare(
    `SELECT COALESCE(SUM(sp.amount_cents), 0) AS v
       FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
      WHERE s.status = 'concluida' AND s.deleted_at IS NULL
        AND sp.method_type IN ('dinheiro', 'debito', 'credito', 'pix', 'outro', 'cartao_debito', 'cartao_credito')
        AND ${SALES_LOCAL_DATE} BETWEEN ? AND ?`,
  ).get(from, to) as { v: number }).v;
  const received = (db.prepare(
    `SELECT COALESCE(SUM(COALESCE(received_cents, amount_cents)), 0) AS v FROM receivables
      WHERE status = 'recebida' AND deleted_at IS NULL AND date(received_at, 'localtime') BETWEEN ? AND ?`,
  ).get(from, to) as { v: number }).v;
  return immediate + received;
}

/** Devoluções de venda por competência (data da devolução). */
function returnsCompetencia(db: Db, from: string, to: string): number {
  return (db.prepare(
    `SELECT COALESCE(SUM(total_cents), 0) AS v FROM sale_returns
     WHERE deleted_at IS NULL AND date(created_at, 'localtime') BETWEEN ? AND ?`,
  ).get(from, to) as { v: number }).v;
}

/** Devoluções por caixa: só as que saíram dinheiro da gaveta. */
function returnsCaixa(db: Db, from: string, to: string): number {
  return (db.prepare(
    `SELECT COALESCE(SUM(total_cents), 0) AS v FROM sale_returns
     WHERE deleted_at IS NULL AND refund_method = 'dinheiro' AND date(created_at, 'localtime') BETWEEN ? AND ?`,
  ).get(from, to) as { v: number }).v;
}

/** CMV (custo congelado na venda) das vendas concluídas no período. */
function cogs(db: Db, from: string, to: string): number {
  return (db.prepare(
    `SELECT COALESCE(SUM(i.qty * i.cost_cents), 0) AS v
     FROM sale_items i JOIN sales s ON s.id = i.sale_id
     WHERE s.status = 'concluida' AND s.deleted_at IS NULL AND ${SALES_LOCAL_DATE} BETWEEN ? AND ?`,
  ).get(from, to) as { v: number }).v;
}

/** Custo dos itens devolvidos (recompostos ao estoque) no período. */
function returnedCogs(db: Db, from: string, to: string): number {
  return (db.prepare(
    `SELECT COALESCE(SUM(ri.qty * sub.avg_cost), 0) AS v
       FROM sale_return_items ri
       JOIN sale_returns sr ON sr.id = ri.return_id
       LEFT JOIN (
         SELECT sale_id, product_id, SUM(cost_cents * qty) / NULLIF(SUM(qty), 0) AS avg_cost
         FROM sale_items GROUP BY sale_id, product_id
       ) sub ON sub.sale_id = ri.sale_id AND sub.product_id = ri.product_id
      WHERE sr.deleted_at IS NULL AND ri.deleted_at IS NULL
        AND date(sr.created_at, 'localtime') BETWEEN ? AND ?`,
  ).get(from, to) as { v: number }).v;
}

/** Taxas de cartão das vendas do período. */
function cardFees(db: Db, from: string, to: string): number {
  return (db.prepare(
    `SELECT COALESCE(SUM(sp.fee_cents), 0) AS v
     FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
     WHERE s.status = 'concluida' AND s.deleted_at IS NULL AND ${SALES_LOCAL_DATE} BETWEEN ? AND ?`,
  ).get(from, to) as { v: number }).v;
}

/**
 * Despesas manuais (contas a pagar) por categoria.
 *  - competência: títulos pelo mês de emissão (`issue_date`, com fallback no vencimento),
 *    exceto cancelados, pelo valor original.
 *  - caixa: títulos efetivamente pagos no período (`paid_at`), pelo valor pago.
 */
function manualExpenses(db: Db, from: string, to: string, basis: DreBasis): { byCategory: Map<number, number>; uncategorized: number } {
  const dateExpr = basis === 'caixa' ? "date(paid_at, 'localtime')" : 'COALESCE(issue_date, due_date)';
  const statusCond = basis === 'caixa' ? "status = 'paga'" : "status != 'cancelada'";
  const amountExpr = basis === 'caixa' ? 'COALESCE(paid_cents, amount_cents)' : 'amount_cents';

  const byCategory = new Map<number, number>();
  for (const row of db.prepare(
    `SELECT dre_category_id AS id, COALESCE(SUM(${amountExpr}), 0) AS v
     FROM payables WHERE ${statusCond} AND deleted_at IS NULL AND dre_category_id IS NOT NULL
       AND ${dateExpr} BETWEEN ? AND ?
     GROUP BY dre_category_id`,
  ).all(from, to) as { id: number; v: number }[]) {
    byCategory.set(row.id, row.v);
  }
  const uncategorized = (db.prepare(
    `SELECT COALESCE(SUM(${amountExpr}), 0) AS v
     FROM payables WHERE ${statusCond} AND deleted_at IS NULL AND dre_category_id IS NULL
       AND ${dateExpr} BETWEEN ? AND ?`,
  ).get(from, to) as { v: number }).v;
  return { byCategory, uncategorized };
}

/**
 * Demonstrativo de Resultado do Exercício no intervalo [from, to].
 *
 * `basis`:
 *  - `competencia` (padrão): vendas pela data da venda; despesas pelo mês de emissão do
 *    título; devoluções pelo mês da devolução.
 *  - `caixa`: receita pelos recebimentos (venda imediata + títulos recebidos); despesas
 *    pelos títulos efetivamente pagos; devoluções só as reembolsadas em dinheiro.
 *
 * Em ambas as bases as devoluções são NETADAS (contra-receita e contra-CMV), para a
 * receita bruta e o CMV não ficarem superestimados. O CMV continua sendo o custo congelado
 * na venda (sale_items.cost_cents), e não o custo atual do produto.
 */
export function demonstrativoResultado(from: string, to: string, basis: DreBasis = 'competencia'): DreReport {
  const db = getSqlite();

  const categories = db.prepare(
    `SELECT id, key, label, dre_line, source, system, adjustment_bps, sort
     FROM dre_categories WHERE active = 1 AND deleted_at IS NULL ORDER BY dre_line, sort, label`,
  ).all() as CategoryRow[];

  const salesRevenue = basis === 'caixa' ? revenueCaixa(db, from, to) : revenueCompetencia(db, from, to);
  const returnsRevenue = basis === 'caixa' ? returnsCaixa(db, from, to) : returnsCompetencia(db, from, to);
  const cogsReal = cogs(db, from, to);
  const returnsCogsReal = returnedCogs(db, from, to);
  const cardFeesReal = cardFees(db, from, to);
  const { byCategory: manualByCategory, uncategorized: uncategorizedCents } = manualExpenses(db, from, to, basis);

  // Devoluções entram como linhas virtuais negativas (contra-receita / contra-CMV), só
  // quando há o que abater — assim a Receita Bruta e o CMV saem líquidos sem depender de
  // categoria cadastrada nem de migration.
  const virtualReturns: CategoryRow[] = [];
  if (returnsRevenue > 0) {
    virtualReturns.push({
      id: -2, key: 'devolucoes_vendas', label: '(-) Devoluções de Vendas', dre_line: 'receita_bruta',
      source: 'manual', system: 1, adjustment_bps: 0, sort: 50,
    });
  }
  if (returnsCogsReal > 0) {
    virtualReturns.push({
      id: -3, key: 'devolucoes_cmv', label: '(-) Devoluções (Custo)', dre_line: 'cmv',
      source: 'manual', system: 1, adjustment_bps: 0, sort: 50,
    });
  }
  const allCategories = [...categories, ...virtualReturns];

  let realByCategory = (cat: CategoryRow): number => {
    if (cat.id === -2) return -returnsRevenue;
    if (cat.id === -3) return -returnsCogsReal;
    if (cat.source === 'sales_revenue') return salesRevenue;
    if (cat.source === 'cogs') return cogsReal;
    if (cat.source === 'card_fees') return cardFeesReal;
    return manualByCategory.get(cat.id) ?? 0;
  };

  // Contas sem categoria caem como despesas operacionais (guarda-chuva) — evita que
  // valores "escapem" do relatório se a categoria fallback for excluída.
  if (uncategorizedCents > 0) {
    const operacionalCat = allCategories.find((c) => c.dre_line === 'despesas_operacionais' && c.source === 'manual');
    if (operacionalCat) {
      const _realByCategory = realByCategory;
      realByCategory = (cat: CategoryRow) =>
        cat.id === operacionalCat.id ? _realByCategory(cat) + uncategorizedCents : _realByCategory(cat);
    } else {
      allCategories.push({
        id: -1, key: 'sem_categoria', label: 'Sem categoria', dre_line: 'despesas_operacionais',
        source: 'manual', system: 0, adjustment_bps: 0, sort: 999,
      });
      manualByCategory.set(-1, uncategorizedCents);
    }
  }

  const lineOrder: DreLine[] = ['receita_bruta', 'deducoes', 'cmv', 'despesas_operacionais', 'despesas_financeiras'];
  const lines = {} as Record<DreLine, DreLineResult>;
  for (const line of lineOrder) {
    const cats = allCategories.filter((c) => c.dre_line === line).map((c) => {
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
    from, to, basis, lines,
    totals: {
      receitaBrutaReal, receitaBrutaAjustada,
      receitaLiquidaReal, receitaLiquidaAjustada,
      lucroBrutoReal, lucroBrutoAjustada,
      resultadoOperacionalReal, resultadoOperacionalAjustada,
      resultadoLiquidoReal, resultadoLiquidoAjustada,
    },
  };
}
