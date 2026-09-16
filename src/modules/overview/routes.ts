import { Router, type Request } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import { audit } from '../../core/audit/service';
import { toCsv } from '../../shared/csv';
import { cashReport, isStockFilter, overviewKpis, stockReport, type CashReportRow, type StockFilter } from './data';

/** API do Painel (montada em /api/overview). Só leitura + exportação. */
const router = Router();
const view = requirePermission('overview.view');

router.get('/kpis', view, (_req, res) => {
  res.json(overviewKpis());
});

router.get('/stock', view, (req, res) => {
  const filter: StockFilter = isStockFilter(req.query.filter) ? req.query.filter : 'all';
  res.json({ filter, rows: stockReport(filter) });
});

router.get('/stock/export.csv', view, (req, res) => {
  const filter: StockFilter = isStockFilter(req.query.filter) ? req.query.filter : 'all';
  const rows = stockReport(filter);
  const csv = toCsv([
    ['Produto', 'SKU', 'Código de barras', 'Unidade', 'Estoque', 'Mínimo', 'Custo (R$)', 'Preço (R$)'],
    ...rows.map((r) => [
      r.name, r.sku ?? '', r.barcode ?? '', r.unit,
      num(r.stock_qty), num(r.min_stock), reais(r.cost_cents), reais(r.price_cents),
    ]),
  ]);
  sendCsv(req, res, `estoque-${filter}`, csv, { filter, total: rows.length }, 'overview_stock');
});

router.get('/cash', view, (req, res) => {
  const { from, to } = period(req);
  const rows = cashReport(from, to);
  res.json({ from, to, rows, totals: cashTotals(rows) });
});

router.get('/cash/export.csv', view, (req, res) => {
  const { from, to } = period(req);
  const rows = cashReport(from, to);
  const csv = toCsv([
    ['Caixa', 'Aberto em', 'Fechado em', 'Status', 'Abertura (R$)', 'Entradas (R$)', 'Saídas (R$)',
      'Esperado (R$)', 'Contado (R$)', 'Diferença (R$)', 'Vendas', 'Total vendas (R$)'],
    ...rows.map((r) => [
      `#${r.id}`, r.opened_at, r.closed_at ?? '', r.status,
      reais(r.opening_cents), reais(r.entradas), reais(r.saidas),
      r.expected_cents != null ? reais(r.expected_cents) : '',
      r.counted_cents != null ? reais(r.counted_cents) : '',
      r.difference_cents != null ? reais(r.difference_cents) : '',
      r.vendas, reais(r.vendas_cents),
    ]),
  ]);
  sendCsv(req, res, `caixas-${from}_a_${to}`, csv, { from, to, total: rows.length }, 'overview_cash');
});

function cashTotals(rows: CashReportRow[]): {
  count: number; entradas: number; saidas: number; vendas: number; vendasCents: number; differenceCents: number;
} {
  const sum = (pick: (r: CashReportRow) => number): number => rows.reduce((a, r) => a + (pick(r) || 0), 0);
  return {
    count: rows.length,
    entradas: sum((r) => r.entradas),
    saidas: sum((r) => r.saidas),
    vendas: sum((r) => r.vendas),
    vendasCents: sum((r) => r.vendas_cents),
    differenceCents: sum((r) => r.difference_cents ?? 0),
  };
}

/** Período do relatório de caixas: `from`/`to` (YYYY-MM-DD) ou o mês corrente. */
function period(req: Request): { from: string; to: string } {
  const ymd = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const valid = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const today = new Date();
  const from = valid(req.query.from) ? req.query.from : ymd(new Date(today.getFullYear(), today.getMonth(), 1));
  const to = valid(req.query.to) ? req.query.to : ymd(new Date(today.getFullYear(), today.getMonth() + 1, 0));
  return { from, to };
}

/** Centavos → "1234,56" (vírgula decimal, sem milhar: o Excel BR lê como número). */
function reais(cents: number): string {
  return (Math.round(cents || 0) / 100).toFixed(2).replace('.', ',');
}

/** Quantidade sem zeros à toa (2.5 → "2,5"). */
function num(n: number): string {
  return String(n ?? 0).replace('.', ',');
}

function sendCsv(
  req: Request,
  res: import('express').Response,
  name: string,
  csv: string,
  meta: Record<string, unknown>,
  entity: string,
): void {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-${stamp}.csv"`);
  audit(req, 'exportar', entity, 0, null, meta);
  res.send(csv);
}

export default router;
