import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { getSqlite } from '../../core/database/connection';
import { requirePermission } from '../../core/permissions/middleware';
import { audit } from '../../core/audit/service';
import { currentRegister, addMovement } from './cash';

/**
 * Fábrica de contas (a pagar / a receber) — mesma mecânica, direções opostas.
 * Liquidar com caixa aberto gera movimento na gaveta (pagamento=saída, recebimento=entrada).
 */
export interface BillsConfig {
  table: 'payables' | 'receivables';
  entity: string;
  permPrefix: string;
  partyColumn: 'supplier_id' | 'customer_id';
  partyTable: 'suppliers' | 'customers';
  settleStatus: 'paga' | 'recebida';
  settleAction: string;
  settleDateCol: 'paid_at' | 'received_at';
  settleCentsCol: 'paid_cents' | 'received_cents';
  movementType: 'pagamento' | 'recebimento';
  movementDirection: 'entrada' | 'saida';
  settlePermission: string;
  /** Só payables: permite associar uma categoria do DRE (despesa), para o relatório de resultado. */
  categoryField?: boolean;
}

/** Categoria precisa existir, estar ativa e ser 'manual' — as 3 categorias-sistema
 * (receita, CMV, taxas de cartão) são calculadas de `sales`/`sale_payments` direto no
 * relatório e ignoram dre_category_id (ver src/modules/dre/report.ts:realByCategory). */
function validateDreCategory(db: () => ReturnType<typeof getSqlite>, dreCategoryId: unknown): number | null | 'invalid' {
  if (dreCategoryId == null) return null;
  const row = db().prepare(
    "SELECT id FROM dre_categories WHERE id = ? AND active = 1 AND deleted_at IS NULL AND source = 'manual'",
  ).get(dreCategoryId as number);
  return row ? Number(dreCategoryId) : 'invalid';
}

/** Toda conta a pagar precisa contribuir em algum lugar do DRE — sem categoria escolhida,
 * cai no "guarda-chuva" de despesas operacionais em vez de sumir do relatório. */
function defaultCategoryId(db: () => ReturnType<typeof getSqlite>): number | null {
  const row = db().prepare(
    "SELECT id FROM dre_categories WHERE key = 'outras_despesas_operacionais' AND deleted_at IS NULL",
  ).get() as { id: number } | undefined;
  return row?.id ?? null;
}

export function makeBillsRouter(cfg: BillsConfig): Router {
  const router = Router();
  const db = () => getSqlite();
  const categoryCols = cfg.categoryField ? ', b.dre_category_id, dc.label AS dre_category_label' : '';
  const categoryJoin = cfg.categoryField ? ' LEFT JOIN dre_categories dc ON dc.id = b.dre_category_id' : '';
  const get = (id: string | number) =>
    db().prepare(
      `SELECT b.id, b.description, b.${cfg.partyColumn} AS party_id, p.name AS party,
              b.amount_cents, b.due_date, b.status, b.${cfg.settleDateCol} AS settled_at,
              b.${cfg.settleCentsCol} AS settled_cents, b.notes, b.updated_at${categoryCols}
       FROM ${cfg.table} b LEFT JOIN ${cfg.partyTable} p ON p.id = b.${cfg.partyColumn}${categoryJoin}
       WHERE b.id = ? AND b.deleted_at IS NULL`,
    ).get(id);

  router.get('/', requirePermission(`${cfg.permPrefix}.view`), (req, res) => {
    const status = String(req.query.status ?? '');
    const partyId = req.query.partyId ? Number(req.query.partyId) : undefined;
    const agreementCompanyId = cfg.table === 'receivables' && req.query.agreementCompanyId ? Number(req.query.agreementCompanyId) : undefined;
    const conditions = [
      status ? 'AND b.status = ?' : '',
      partyId ? `AND b.${cfg.partyColumn} = ?` : '',
      agreementCompanyId ? 'AND b.agreement_company_id = ?' : '',
    ].filter(Boolean).join(' ');
    const params = [status, partyId, agreementCompanyId].filter((v) => v !== undefined && v !== '');
    const sql = `SELECT b.id, b.description, p.name AS party, b.amount_cents, b.due_date, b.status,
                        b.notes, b.${cfg.settleDateCol} AS settled_at, b.${cfg.settleCentsCol} AS settled_cents${categoryCols}
                 FROM ${cfg.table} b LEFT JOIN ${cfg.partyTable} p ON p.id = b.${cfg.partyColumn}${categoryJoin}
                 WHERE b.deleted_at IS NULL ${conditions} ORDER BY b.due_date, b.id`;
    res.json(db().prepare(sql).all(...params));
  });

  router.post('/', requirePermission(`${cfg.permPrefix}.create`), (req, res) => {
    const { description, amountCents, dueDate, partyId, notes, dreCategoryId } = req.body ?? {};
    if (!description || !amountCents || !dueDate) {
      res.status(400).json({ error: 'Campos obrigatórios: description, amountCents, dueDate.' });
      return;
    }
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      res.status(400).json({ error: 'Valor deve ser inteiro em centavos, maior que zero.' });
      return;
    }
    let categoryId: number | null = null;
    if (cfg.categoryField) {
      const validated = validateDreCategory(db, dreCategoryId);
      if (validated === 'invalid') {
        res.status(400).json({ error: 'Categoria do DRE inválida.' });
        return;
      }
      categoryId = validated ?? defaultCategoryId(db);
    }
    const info = db().prepare(
      cfg.categoryField
        ? `INSERT INTO ${cfg.table} (description, ${cfg.partyColumn}, amount_cents, due_date, notes, dre_category_id, uuid)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        : `INSERT INTO ${cfg.table} (description, ${cfg.partyColumn}, amount_cents, due_date, notes, uuid)
           VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(...(cfg.categoryField
      ? [description, partyId ?? null, amountCents, dueDate, notes ?? null, categoryId, randomUUID()]
      : [description, partyId ?? null, amountCents, dueDate, notes ?? null, randomUUID()]));
    const created = get(Number(info.lastInsertRowid));
    audit(req, 'criar', cfg.entity, Number(info.lastInsertRowid), null, created);
    res.status(201).json(created);
  });

  router.put('/:id', requirePermission(`${cfg.permPrefix}.edit`), (req, res) => {
    const id = String(req.params.id);
    const before = get(id) as { status: string } | undefined;
    if (!before) {
      res.status(404).json({ error: 'Conta não encontrada.' });
      return;
    }
    if (before.status !== 'aberta') {
      res.status(400).json({ error: 'Só contas abertas podem ser editadas.' });
      return;
    }
    const { description, amountCents, dueDate, partyId, notes, status, dreCategoryId } = req.body ?? {};
    if (status && status !== 'cancelada') {
      res.status(400).json({ error: 'Via edição, o único status permitido é "cancelada".' });
      return;
    }
    let categoryId: number | null | undefined = undefined;
    if (cfg.categoryField && dreCategoryId !== undefined) {
      const validated = validateDreCategory(db, dreCategoryId);
      if (validated === 'invalid') {
        res.status(400).json({ error: 'Categoria do DRE inválida.' });
        return;
      }
      categoryId = validated;
    }
    db().prepare(
      `UPDATE ${cfg.table} SET description = COALESCE(?, description), amount_cents = COALESCE(?, amount_cents),
         due_date = COALESCE(?, due_date), ${cfg.partyColumn} = COALESCE(?, ${cfg.partyColumn}),
         notes = COALESCE(?, notes), status = COALESCE(?, status),
         ${cfg.categoryField ? 'dre_category_id = COALESCE(?, dre_category_id),' : ''} updated_at = datetime('now')
       WHERE id = ?`,
    ).run(...[description ?? null, amountCents ?? null, dueDate ?? null, partyId ?? null, notes ?? null, status ?? null,
      ...(cfg.categoryField ? [categoryId ?? null] : []), id]);
    const after = get(id);
    audit(req, status === 'cancelada' ? 'cancelar' : 'editar', cfg.entity, id, before, after);
    res.json(after);
  });

  router.post('/:id/settle', requirePermission(cfg.settlePermission), (req: Request, res) => {
    const id = String(req.params.id);
    const bill = get(id) as { status: string; amount_cents: number; description: string } | undefined;
    if (!bill) {
      res.status(404).json({ error: 'Conta não encontrada.' });
      return;
    }
    if (bill.status !== 'aberta') {
      res.status(400).json({ error: `Conta já está "${bill.status}".` });
      return;
    }
    const settledCents = req.body?.amountCents != null ? Math.round(req.body.amountCents) : bill.amount_cents;
    if (!Number.isInteger(settledCents) || settledCents <= 0) {
      res.status(400).json({ error: 'Valor inválido.' });
      return;
    }
    // Data do pagamento: por padrão agora (datetime('now')); se o usuário escolher uma
    // data específica (ex.: pagamento adiantado registrado depois), grava ao meio-dia
    // UTC daquele dia — evita que o fuso de Porto Velho (UTC-4) exiba o dia anterior
    // quando a hora exibida é convertida a partir de meia-noite UTC.
    let settledAtValue: string | null = null;
    if (req.body?.settledAt) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(req.body.settledAt));
      if (!m) {
        res.status(400).json({ error: 'Data do pagamento inválida (use AAAA-MM-DD).' });
        return;
      }
      settledAtValue = `${req.body.settledAt} 12:00:00`;
    }

    const database = db();
    const reg = currentRegister();
    database.transaction(() => {
      database.prepare(
        `UPDATE ${cfg.table} SET status = ?, ${cfg.settleDateCol} = COALESCE(?, datetime('now')),
           ${cfg.settleCentsCol} = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(cfg.settleStatus, settledAtValue, settledCents, id);
      if (reg) {
        addMovement(req, reg.id, cfg.movementDirection, cfg.movementType, settledCents, bill.description, cfg.entity, id);
      }
    })();
    audit(req, cfg.settleAction, cfg.entity, id, bill, { settledCents, caixa: reg?.id ?? null });
    res.json({ ok: true, settledCents, registeredInCash: !!reg });
  });

  return router;
}
