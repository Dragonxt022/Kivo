import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import { audit } from '../../core/audit/service';
import { currentRegister, addMovement } from './cash';
import { addDays } from '../../shared/date';
import { computeLateCharges } from './lateFees';
import { payableRepository, receivableRepository, billSettlementPaymentRepository } from './repositories/BillRepository';
import { paymentMethodRepository } from './repositories/PaymentMethodRepository';
import { cashRegisterRepository } from './repositories/CashRegisterRepository';

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
  categoryField?: boolean;
}

interface BillRow {
  id: number;
  description: string;
  party_id: number | null;
  party: string | null;
  amount_cents: number;
  issue_date: string | null;
  due_date: string;
  status: string;
  notes: string | null;
  installment_group_id: string | null;
  installment_no: number | null;
  installment_count: number | null;
  sale_id?: number | null;
}

const repoForTable = (table: string) =>
  table === 'payables' ? payableRepository : receivableRepository;

function getBill(cfg: BillsConfig, id: string | number): (BillRow & Record<string, unknown>) | undefined {
  const repo = repoForTable(cfg.table);
  const joins = `LEFT JOIN ${cfg.partyTable} p ON p.id = b.${cfg.partyColumn}
                  LEFT JOIN payment_methods spm ON spm.id = b.settle_payment_method_id`;
  const categoryJoin = cfg.categoryField ? ' LEFT JOIN dre_categories dc ON dc.id = b.dre_category_id' : '';
  const categoryCols = cfg.categoryField ? ', b.dre_category_id, dc.label AS dre_category_label' : '';
  const saleIdCol = cfg.table === 'receivables' ? ', b.sale_id' : '';
  return repo.rawOne(
    `SELECT b.id, b.description, b.${cfg.partyColumn} AS party_id, p.name AS party,
            b.amount_cents, b.issue_date, b.due_date, b.status, b.${cfg.settleDateCol} AS settled_at,
            b.${cfg.settleCentsCol} AS settled_cents, b.notes, b.updated_at,
            b.settle_payment_method_id, spm.name AS settle_method_name,
            b.installment_group_id, b.installment_no, b.installment_count${saleIdCol}${categoryCols}
     FROM ${cfg.table} b ${joins}${categoryJoin}
     WHERE b.id = ? AND b.deleted_at IS NULL`,
    id,
  ) as (BillRow & Record<string, unknown>) | undefined;
}

function validateDreCategory(dreCategoryId: unknown): number | null | 'invalid' {
  if (dreCategoryId == null) return null;
  const row = payableRepository.rawOne(
    "SELECT id FROM dre_categories WHERE id = ? AND active = 1 AND deleted_at IS NULL AND source = 'manual'",
    dreCategoryId as number,
  ) as { id: number } | undefined;
  return row ? Number(dreCategoryId) : 'invalid';
}

function defaultCategoryId(): number | null {
  const row = payableRepository.rawOne(
    "SELECT id FROM dre_categories WHERE key = 'outras_despesas_operacionais' AND deleted_at IS NULL",
  ) as { id: number } | undefined;
  return row?.id ?? null;
}

function withLateInfo<T extends { status: string; amount_cents: number; due_date: string }>(row: T): T & {
  lateMultaCents?: number; lateJurosCents?: number; diasAtraso?: number; suggestedSettleCents?: number;
} {
  if (!row || row.status !== 'aberta') return row;
  const { multaCents, jurosCents, diasAtraso } = computeLateCharges(row.amount_cents, row.due_date);
  return {
    ...row,
    lateMultaCents: multaCents, lateJurosCents: jurosCents, diasAtraso,
    suggestedSettleCents: row.amount_cents + multaCents + jurosCents,
  };
}

export function makeBillsRouter(cfg: BillsConfig): Router {
  const router = Router();
  const repo = repoForTable(cfg.table);
  const categoryCols = cfg.categoryField ? ', b.dre_category_id, dc.label AS dre_category_label' : '';
  const categoryJoin = cfg.categoryField ? ' LEFT JOIN dre_categories dc ON dc.id = b.dre_category_id' : '';
  const saleIdCol = cfg.table === 'receivables' ? ', b.sale_id' : '';

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
    const sql = `SELECT b.id, b.description, p.name AS party, b.amount_cents, b.issue_date, b.due_date, b.status,
                        b.notes, b.${cfg.settleDateCol} AS settled_at, b.${cfg.settleCentsCol} AS settled_cents,
                        spm.name AS settle_method_name,
                        b.installment_group_id, b.installment_no, b.installment_count${saleIdCol}${categoryCols}
                 FROM ${cfg.table} b LEFT JOIN ${cfg.partyTable} p ON p.id = b.${cfg.partyColumn}
                      LEFT JOIN payment_methods spm ON spm.id = b.settle_payment_method_id${categoryJoin}
                 WHERE b.deleted_at IS NULL ${conditions} ORDER BY b.due_date, b.id`;
    const rows = repo.raw(sql, ...params) as { status: string; amount_cents: number; due_date: string }[];
    res.json(rows.map(withLateInfo));
  });

  router.post('/', requirePermission(`${cfg.permPrefix}.create`), (req, res) => {
    const { description, amountCents, issueDate, dueDate, partyId, notes, dreCategoryId, installments } = req.body ?? {};
    if (!description || !amountCents || !dueDate) {
      res.status(400).json({ error: 'Campos obrigatórios: description, amountCents, dueDate.' });
      return;
    }
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      res.status(400).json({ error: 'Valor deve ser inteiro em centavos, maior que zero.' });
      return;
    }
    const count = installments != null ? Math.round(installments) : 1;
    if (!Number.isInteger(count) || count < 1 || count > 24) {
      res.status(400).json({ error: 'Parcelas deve ser um número entre 1 e 24.' });
      return;
    }
    const issueDateValue = issueDate || new Date().toISOString().slice(0, 10);
    let categoryId: number | null = null;
    if (cfg.categoryField) {
      const validated = validateDreCategory(dreCategoryId);
      if (validated === 'invalid') {
        res.status(400).json({ error: 'Categoria do DRE inválida.' });
        return;
      }
      categoryId = validated ?? defaultCategoryId();
    }

    const groupId = count > 1 ? randomUUID() : null;
    const base = Math.floor(amountCents / count);
    const remainder = amountCents - base * count;
    const cols = ['description', cfg.partyColumn, 'amount_cents', 'issue_date', 'due_date', 'notes',
      'installment_group_id', 'installment_no', 'installment_count', 'original_amount_cents', 'uuid'];
    if (cfg.categoryField) cols.push('dre_category_id');

    let firstId = 0;
    repo.transaction(() => {
      for (let n = 0; n < count; n++) {
        const amt = n === 0 ? base + remainder : base;
        const due = addDays(dueDate, 30 * n);
        const values: Record<string, unknown> = {
          description,
          [cfg.partyColumn]: partyId ?? null,
          amount_cents: amt,
          issue_date: issueDateValue,
          due_date: due,
          notes: notes ?? null,
          installment_group_id: groupId,
          installment_no: count > 1 ? n + 1 : null,
          installment_count: count > 1 ? count : null,
          original_amount_cents: amt,
          uuid: randomUUID(),
        };
        if (cfg.categoryField) values.dre_category_id = categoryId;
        const infoId = repo.create(values);
        if (n === 0) firstId = infoId;
      }
    });
    const created = withLateInfo(getBill(cfg, firstId) as BillRow & { status: string; amount_cents: number; due_date: string });
    audit(req, 'criar', cfg.entity, firstId, null, { ...created, installments: count });
    res.status(201).json(created);
  });

  router.put('/:id', requirePermission(`${cfg.permPrefix}.edit`), (req, res) => {
    const id = String(req.params.id);
    const before = getBill(cfg, id) as { status: string } | undefined;
    if (!before) {
      res.status(404).json({ error: 'Conta não encontrada.' });
      return;
    }
    if (before.status !== 'aberta') {
      res.status(400).json({ error: 'Só contas abertas podem ser editadas.' });
      return;
    }
    const { description, amountCents, issueDate, dueDate, partyId, notes, status, dreCategoryId } = req.body ?? {};
    if (status && status !== 'cancelada') {
      res.status(400).json({ error: 'Via edição, o único status permitido é "cancelada".' });
      return;
    }
    let categoryId: number | null | undefined = undefined;
    if (cfg.categoryField && dreCategoryId !== undefined) {
      const validated = validateDreCategory(dreCategoryId);
      if (validated === 'invalid') {
        res.status(400).json({ error: 'Categoria do DRE inválida.' });
        return;
      }
      categoryId = validated;
    }

    const updates: Record<string, unknown> = {};
    if (description !== undefined) updates.description = description;
    if (amountCents !== undefined) updates.amount_cents = amountCents;
    if (issueDate !== undefined) updates.issue_date = issueDate;
    if (dueDate !== undefined) updates.due_date = dueDate;
    if (partyId !== undefined) updates[cfg.partyColumn] = partyId;
    if (notes !== undefined) updates.notes = notes;
    if (status !== undefined) updates.status = status;
    if (cfg.categoryField && categoryId !== undefined) updates.dre_category_id = categoryId;

    repo.update(id, updates);

    const after = getBill(cfg, id);
    audit(req, status === 'cancelada' ? 'cancelar' : 'editar', cfg.entity, id, before, after);
    res.json(after);
  });

  router.post('/:id/settle', requirePermission(cfg.settlePermission), (req: Request, res) => {
    const id = String(req.params.id);
    const bill = getBill(cfg, id) as BillRow | undefined;
    if (!bill) {
      res.status(404).json({ error: 'Conta não encontrada.' });
      return;
    }
    if (bill.status !== 'aberta') {
      res.status(400).json({ error: `Conta já está "${bill.status}".` });
      return;
    }

    const paymentsInput = Array.isArray(req.body?.payments) ? req.body.payments : null;
    if (!paymentsInput || !paymentsInput.length) {
      res.status(400).json({ error: 'Informe ao menos uma forma de pagamento.' });
      return;
    }
    const resolved: { method: { id: number; type: string }; amountCents: number }[] = [];
    for (const p of paymentsInput) {
      const amt = Math.round(Number(p?.amountCents));
      if (!Number.isInteger(amt) || amt <= 0) {
        res.status(400).json({ error: 'Valor inválido em uma das formas de pagamento.' });
        return;
      }
      const method = paymentMethodRepository.rawOne(
        "SELECT id, type FROM payment_methods WHERE id = ? AND active = 1 AND deleted_at IS NULL AND type != 'prazo'",
        p?.paymentMethodId,
      ) as { id: number; type: string } | undefined;
      if (!method) {
        res.status(400).json({ error: 'Forma de pagamento inválida.' });
        return;
      }
      resolved.push({ method, amountCents: amt });
    }
    const totalPaidCents = resolved.reduce((s, p) => s + p.amountCents, 0);

    let settledAtValue: string | null = null;
    if (req.body?.settledAt) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(req.body.settledAt));
      if (!m) {
        res.status(400).json({ error: 'Data do pagamento inválida (use AAAA-MM-DD).' });
        return;
      }
      settledAtValue = `${req.body.settledAt} 12:00:00`;
    }

    const { multaCents, jurosCents } = computeLateCharges(bill.amount_cents, bill.due_date);
    const owedCents = bill.amount_cents + multaCents + jurosCents;

    const hasCash = resolved.some((p) => p.method.type === 'dinheiro');
    const cashCents = resolved.filter((p) => p.method.type === 'dinheiro').reduce((s, p) => s + p.amountCents, 0);
    const reg = currentRegister();
    if (hasCash && !reg) {
      res.status(400).json({ error: 'Abra o caixa antes de liquidar em dinheiro.', code: 'no_register' });
      return;
    }

    let rolledOverCents = 0;
    let rolloverTarget: 'existing' | 'new' | null = null;

    repo.transaction(() => {
      const soleMethodId = resolved.length === 1 ? resolved[0].method.id : null;

      const settleSql = settledAtValue
        ? `UPDATE ${cfg.table} SET status = ?, ${cfg.settleDateCol} = ?, ${cfg.settleCentsCol} = ?, amount_cents = ?, settle_payment_method_id = ?, updated_at = datetime('now') WHERE id = ?`
        : `UPDATE ${cfg.table} SET status = ?, ${cfg.settleDateCol} = datetime('now'), ${cfg.settleCentsCol} = ?, amount_cents = ?, settle_payment_method_id = ?, updated_at = datetime('now') WHERE id = ?`;
      const settleParams = settledAtValue
        ? [cfg.settleStatus, settledAtValue, totalPaidCents, totalPaidCents, soleMethodId, id]
        : [cfg.settleStatus, totalPaidCents, totalPaidCents, soleMethodId, id];
      repo.rawRun(settleSql, ...settleParams);

      for (const p of resolved) {
        billSettlementPaymentRepository.create({
          entity: cfg.entity,
          bill_id: id,
          payment_method_id: p.method.id,
          amount_cents: p.amountCents,
        });
      }

      if (hasCash && reg && cashCents > 0) {
        addMovement(req, reg.id, cfg.movementDirection, cfg.movementType, cashCents, bill.description, cfg.entity, id);
      }

      const shortfall = owedCents - totalPaidCents;
      if (shortfall > 0) {
        rolledOverCents = shortfall;
        const currentNo = bill.installment_no ?? 1;
        let next: { id: number } | undefined;
        if (bill.installment_group_id) {
          next = repo.rawOne(
            `SELECT id FROM ${cfg.table} WHERE installment_group_id = ? AND installment_no = ? AND status = 'aberta'`,
            bill.installment_group_id, currentNo + 1,
          ) as { id: number } | undefined;
        } else if (cfg.table === 'receivables' && bill.sale_id) {
          next = receivableRepository.rawOne(
            `SELECT id FROM receivables WHERE sale_id = ? AND installment_no = ? AND status = 'aberta'`,
            bill.sale_id, currentNo + 1,
          ) as { id: number } | undefined;
        }

        if (next) {
          repo.rawRun(
            `UPDATE ${cfg.table} SET amount_cents = amount_cents + ?, updated_at = datetime('now') WHERE id = ?`,
            shortfall, next.id,
          );
          rolloverTarget = 'existing';
        } else {
          const groupId = bill.installment_group_id ?? randomUUID();
          if (!bill.installment_group_id) {
            repo.rawRun(
              `UPDATE ${cfg.table} SET installment_group_id = ?, installment_no = 1 WHERE id = ?`,
              groupId, id,
            );
          }
          const newDue = addDays(bill.due_date, 30);
          const newNo = currentNo + 1;
          const cols = ['description', cfg.partyColumn, 'amount_cents', 'issue_date', 'due_date', 'notes',
            'installment_group_id', 'installment_no', 'installment_count', 'original_amount_cents', 'uuid'];
          if (cfg.categoryField) cols.push('dre_category_id');
          const values: Record<string, unknown> = {
            description: bill.description,
            [cfg.partyColumn]: bill.party_id,
            amount_cents: shortfall,
            issue_date: new Date().toISOString().slice(0, 10),
            due_date: newDue,
            notes: bill.notes,
            installment_group_id: groupId,
            installment_no: newNo,
            installment_count: null,
            original_amount_cents: shortfall,
            uuid: randomUUID(),
          };
          if (cfg.categoryField) {
            values.dre_category_id = (bill as unknown as { dre_category_id: number | null }).dre_category_id ?? defaultCategoryId();
          }
          repo.create(values);
          rolloverTarget = 'new';
          repo.rawRun(
            `UPDATE ${cfg.table} SET installment_count = (SELECT COUNT(*) FROM ${cfg.table} WHERE installment_group_id = ? AND deleted_at IS NULL)
             WHERE installment_group_id = ?`,
            groupId, groupId,
          );
        }
      }
    });

    audit(req, cfg.settleAction, cfg.entity, id, bill, {
      totalPaidCents, methods: resolved.map((p) => ({ id: p.method.id, amountCents: p.amountCents })),
      rolledOverCents, rolloverTarget, caixa: hasCash ? reg?.id : null,
    });
    res.json({ ok: true, settledCents: totalPaidCents, rolledOverCents, rolloverTarget, registeredInCash: hasCash });
  });

  return router;
}
