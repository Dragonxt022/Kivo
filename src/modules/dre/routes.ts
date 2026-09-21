import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { getSqlite } from '../../core/database/connection';
import { requirePermission } from '../../core/permissions/middleware';
import { audit } from '../../core/audit/service';
import { validateBody } from '../../shared/validateBody';
import { createDreCategorySchema, updateDreCategorySchema } from '../../shared/schemas';
import { toCsv } from '../../shared/csv';
import { demonstrativoResultado, type DreBasis, type DreReport } from './report';

const router = Router();
const db = () => getSqlite();


// Ordem contábil do DRE (não é a ordem alfabética de dre_line) — usada tanto para ordenar a
// listagem quanto para gerar o código "1.0.0 em diante" (dígito principal = posição da linha).
const DRE_LINE_ORDER = ['receita_bruta', 'deducoes', 'cmv', 'despesas_operacionais', 'despesas_financeiras'];

interface DreCategoryRow {
  id: number; key: string; label: string; dre_line: string; source: string;
  system: number; adjustment_bps: number; sort: number; active: number;
}

/** Numeração automática e só-leitura (ninguém edita): dígito principal = posição da linha do
 * DRE, dígito secundário = ordem dentro da linha (sort/criação) — ex. "4.2.0". Calculada em
 * leitura, não persistida, pra não precisar renumerar quando uma categoria é excluída do meio. */
function withCodes(rows: DreCategoryRow[]): (DreCategoryRow & { code: string })[] {
  const sorted = [...rows].sort((a, b) => {
    const la = DRE_LINE_ORDER.indexOf(a.dre_line);
    const lb = DRE_LINE_ORDER.indexOf(b.dre_line);
    if (la !== lb) return la - lb;
    if (a.sort !== b.sort) return a.sort - b.sort;
    return a.label.localeCompare(b.label);
  });
  const counters = new Map<string, number>();
  return sorted.map((row) => {
    const major = DRE_LINE_ORDER.indexOf(row.dre_line) + 1;
    const minor = (counters.get(row.dre_line) ?? 0) + 1;
    counters.set(row.dre_line, minor);
    return { ...row, code: `${major}.${minor}.0` };
  });
}

router.get('/categories', requirePermission('dre.view'), (req, res) => {
  // manualOnly=1: só categorias atribuíveis a uma conta a pagar (exclui as 3 linhas
  // calculadas automaticamente de vendas — receita, CMV e taxas de cartão — cujo valor
  // real ignora dre_category_id de qualquer jeito, ver report.ts:realByCategory).
  const manualOnly = req.query.manualOnly === '1';
  const where = manualOnly ? "AND source = 'manual' AND active = 1" : '';
  const rows = db().prepare(
    `SELECT id, key, label, dre_line, source, system, adjustment_bps, sort, active
     FROM dre_categories WHERE deleted_at IS NULL ${where}`,
  ).all() as DreCategoryRow[];
  res.json(withCodes(rows));
});

router.post('/categories', requirePermission('dre.categories.edit'), validateBody(createDreCategorySchema), (req, res) => {
  const { label, dreLine, adjustmentBps } = req.body;
  const adj = adjustmentBps ?? 0;
  const key = `manual_${randomUUID().slice(0, 8)}`;
  const info = db().prepare(
    `INSERT INTO dre_categories (key, label, dre_line, source, system, adjustment_bps, sort, uuid)
     VALUES (?, ?, ?, 'manual', 0, ?, 99, ?)`,
  ).run(key, label, dreLine, adj, randomUUID());
  const created = db().prepare('SELECT id, key, label, dre_line, source, system, adjustment_bps, sort, active FROM dre_categories WHERE id = ?')
    .get(Number(info.lastInsertRowid));
  audit(req, 'criar', 'dre_category', Number(info.lastInsertRowid), null, created);
  res.status(201).json(created);
});

router.put('/categories/:id', requirePermission('dre.categories.edit'), validateBody(updateDreCategorySchema), (req, res) => {
  const id = String(req.params.id);
  const before = db().prepare('SELECT id, label, dre_line, system, adjustment_bps, active FROM dre_categories WHERE id = ? AND deleted_at IS NULL').get(id) as
    { id: number; label: string; dre_line: string; system: number; adjustment_bps: number; active: number } | undefined;
  if (!before) {
    res.status(404).json({ error: 'Categoria não encontrada.' });
    return;
  }
  const { label, adjustmentBps, active, dreLine } = req.body;
  if (dreLine != null && dreLine !== before.dre_line && before.system) {
    res.status(400).json({ error: 'Categorias do sistema não podem trocar de linha do DRE.' });
    return;
  }
  db().prepare(
    `UPDATE dre_categories SET label = COALESCE(?, label), dre_line = COALESCE(?, dre_line),
       adjustment_bps = COALESCE(?, adjustment_bps), active = COALESCE(?, active), updated_at = datetime('now')
     WHERE id = ?`,
  ).run(label ?? null, before.system ? null : (dreLine ?? null), adjustmentBps != null ? Math.round(adjustmentBps) : null,
    active != null ? (active ? 1 : 0) : null, id);
  const after = db().prepare('SELECT id, key, label, dre_line, source, system, adjustment_bps, sort, active FROM dre_categories WHERE id = ?').get(id);
  audit(req, 'editar', 'dre_category', id, before, after);
  res.json(after);
});

router.delete('/categories/:id', requirePermission('dre.categories.edit'), (req, res) => {
  const id = String(req.params.id);
  const before = db().prepare('SELECT id, label, system FROM dre_categories WHERE id = ? AND deleted_at IS NULL').get(id) as
    { id: number; label: string; system: number } | undefined;
  if (!before) {
    res.status(404).json({ error: 'Categoria não encontrada.' });
    return;
  }
  if (before.system) {
    res.status(409).json({ error: 'Categorias do sistema não podem ser excluídas.' });
    return;
  }
  const inUse = (db().prepare(
    "SELECT COUNT(*) AS n FROM payables WHERE dre_category_id = ? AND deleted_at IS NULL AND status != 'cancelada'",
  ).get(id) as { n: number }).n;
  if (inUse > 0) {
    res.status(409).json({ error: `Categoria em uso em ${inUse} conta(s) a pagar — reclassifique antes de excluir.` });
    return;
  }
  db().prepare(`UPDATE dre_categories SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  audit(req, 'excluir', 'dre_category', id, before, null);
  res.json({ ok: true });
});

/** Período e base de apuração vindos da query string. */
function reportParams(req: { query: Record<string, unknown> }): { from: string; to: string; basis: DreBasis } {
  return {
    from: String(req.query.from || '0000-01-01'),
    to: String(req.query.to || '9999-12-31'),
    basis: req.query.basis === 'caixa' ? 'caixa' : 'competencia',
  };
}

const DRE_LINE_LABELS: Record<string, string> = {
  receita_bruta: 'Receita Bruta', deducoes: 'Deduções da Receita', cmv: 'CMV',
  despesas_operacionais: 'Despesas Operacionais', despesas_financeiras: 'Despesas Financeiras',
};

function dreCsvRows(report: DreReport): (string | number)[][] {
  const reais = (c: number): string => (Math.round(c || 0) / 100).toFixed(2).replace('.', ',');
  const pct = (bps: number): string => (bps === 0 ? '' : (bps / 100).toFixed(2).replace('.', ',') + '%');
  const rows: (string | number)[][] = [['Seção', 'Categoria', 'Real (R$)', 'Ajuste', 'Projetado (R$)']];
  const order = ['receita_bruta', 'deducoes', 'cmv', 'despesas_operacionais', 'despesas_financeiras'];
  const afterLine: Record<string, { label: string; real: number; adjusted: number }> = {
    deducoes: { label: 'Receita Líquida', real: report.totals.receitaLiquidaReal, adjusted: report.totals.receitaLiquidaAjustada },
    cmv: { label: 'Lucro Bruto', real: report.totals.lucroBrutoReal, adjusted: report.totals.lucroBrutoAjustada },
    despesas_operacionais: { label: 'Resultado Operacional', real: report.totals.resultadoOperacionalReal, adjusted: report.totals.resultadoOperacionalAjustada },
    despesas_financeiras: { label: 'Resultado Líquido do Período', real: report.totals.resultadoLiquidoReal, adjusted: report.totals.resultadoLiquidoAjustada },
  };
  for (const line of order) {
    const group = report.lines[line as keyof typeof report.lines];
    const label = DRE_LINE_LABELS[line];
    for (const c of group.categories) {
      rows.push([label, c.label, reais(c.realCents), pct(c.adjustmentBps), reais(c.adjustedCents)]);
    }
    rows.push([label, 'Total ' + label, reais(group.realCents), '', reais(group.adjustedCents)]);
    if (afterLine[line]) {
      rows.push([label, '= ' + afterLine[line].label, reais(afterLine[line].real), '', reais(afterLine[line].adjusted)]);
    }
  }
  return rows;
}

router.get('/report', requirePermission('dre.view'), (req, res) => {
  const { from, to, basis } = reportParams(req);
  res.json(demonstrativoResultado(from, to, basis));
});

// Exportação em CSV (Excel BR: separador ';' + BOM). Mesma árvore da tela/impressão.
router.get('/report/export.csv', requirePermission('dre.view'), (req, res) => {
  const { from, to, basis } = reportParams(req);
  const report = demonstrativoResultado(from, to, basis);
  const csv = toCsv(dreCsvRows(report));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="dre-${from}_a_${to}-${basis}.csv"`);
  audit(req, 'exportar', 'dre_report', 0, null, { from, to, basis });
  res.send(csv);
});

export default router;
