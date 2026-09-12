import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request } from 'express';
import { requirePermission, requireAnyPermission } from '../../core/permissions/middleware';
import { audit } from '../../core/audit/service';
import { currentRegister, addMovement } from './cash';
import { addDays } from '../../shared/date';
import { computeLateCharges } from './lateFees';
import { validateBody } from '../../shared/validateBody';
import { createBillSchema, updateBillSchema, settleBillSchema } from '../../shared/schemas';
import { payableRepository, receivableRepository, billSettlementPaymentRepository } from './repositories/BillRepository';
import { paymentMethodRepository } from './repositories/PaymentMethodRepository';
import { billAttachmentsDir, saveBillAttachment, deleteBillAttachmentFile, contentDisposition } from './attachments';

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
  attachment_file?: string | null;
  attachment_name?: string | null;
  attachment_mime?: string | null;
  attachment_size?: number | null;
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
            b.installment_group_id, b.installment_no, b.installment_count${saleIdCol}${categoryCols},
            b.attachment_file, b.attachment_name, b.attachment_mime, b.attachment_size
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

/** Configurações compartilhadas com o setup do módulo (a receber precisa liquidar via serviço). */
export const RECEIVABLES_CONFIG: BillsConfig = {
  table: 'receivables', entity: 'receivable', permPrefix: 'finance.receivables',
  partyColumn: 'customer_id', partyTable: 'customers',
  settleStatus: 'recebida', settleAction: 'receber', settleDateCol: 'received_at', settleCentsCol: 'received_cents',
  movementType: 'recebimento', movementDirection: 'entrada', settlePermission: 'finance.receivables.receive',
};

export const PAYABLES_CONFIG: BillsConfig = {
  table: 'payables', entity: 'payable', permPrefix: 'finance.payables',
  partyColumn: 'supplier_id', partyTable: 'suppliers',
  settleStatus: 'paga', settleAction: 'pagar', settleDateCol: 'paid_at', settleCentsCol: 'paid_cents',
  movementType: 'pagamento', movementDirection: 'saida', settlePermission: 'finance.payables.pay',
  categoryField: true,
};

export interface SettleBillInput {
  payments: { paymentMethodId?: number; amountCents?: number }[];
  settledAt?: string;
}

export type SettleBillResult =
  | {
      ok: true;
      settledCents: number;
      rolledOverCents: number;
      rolloverTarget: 'existing' | 'new' | null;
      registeredInCash: boolean;
    }
  | { ok: false; status: number; error: string; code?: string };

/**
 * Liquida uma conta (a pagar ou a receber).
 *
 * Extraído da rota para o Kivo Web poder receber pelo celular: a intenção chega como comando
 * e roda no desktop pelo MESMO caminho da tela — caixa, rolagem de saldo e auditoria
 * inclusive. Duplicar essa lógica no handler seria criar uma segunda verdade para dinheiro.
 */
export function settleBill(cfg: BillsConfig, req: Request, id: string | number, input: SettleBillInput): SettleBillResult {
  const repo = repoForTable(cfg.table);
  const bill = getBill(cfg, id) as BillRow | undefined;
  if (!bill) return { ok: false, status: 404, error: 'Conta não encontrada.' };
  if (bill.status !== 'aberta') return { ok: false, status: 400, error: `Conta já está "${bill.status}".` };

  const paymentsInput = Array.isArray(input?.payments) ? input.payments : null;
  if (!paymentsInput || !paymentsInput.length) {
    return { ok: false, status: 400, error: 'Informe ao menos uma forma de pagamento.' };
  }
  const resolved: { method: { id: number; type: string }; amountCents: number }[] = [];
  for (const p of paymentsInput) {
    const amt = Math.round(Number(p?.amountCents));
    if (!Number.isInteger(amt) || amt <= 0) {
      return { ok: false, status: 400, error: 'Valor inválido em uma das formas de pagamento.' };
    }
    const method = paymentMethodRepository.rawOne(
      "SELECT id, type FROM payment_methods WHERE id = ? AND active = 1 AND deleted_at IS NULL AND type != 'prazo'",
      p?.paymentMethodId,
    ) as { id: number; type: string } | undefined;
    if (!method) return { ok: false, status: 400, error: 'Forma de pagamento inválida.' };
    resolved.push({ method, amountCents: amt });
  }
  const totalPaidCents = resolved.reduce((s, p) => s + p.amountCents, 0);

  let settledAtValue: string | null = null;
  if (input?.settledAt) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(input.settledAt));
    if (!m) return { ok: false, status: 400, error: 'Data do pagamento inválida (use AAAA-MM-DD).' };
    settledAtValue = `${input.settledAt} 12:00:00`;
  }

  const { multaCents, jurosCents } = computeLateCharges(bill.amount_cents, bill.due_date);
  const owedCents = bill.amount_cents + multaCents + jurosCents;

  const hasCash = resolved.some((p) => p.method.type === 'dinheiro');
  const cashCents = resolved.filter((p) => p.method.type === 'dinheiro').reduce((s, p) => s + p.amountCents, 0);
  const reg = currentRegister();
  if (hasCash && !reg) {
    return { ok: false, status: 400, error: 'Abra o caixa antes de liquidar em dinheiro.', code: 'no_register' };
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
  return { ok: true, settledCents: totalPaidCents, rolledOverCents, rolloverTarget, registeredInCash: hasCash };
}

/**
 * Recebe o TOTAL de uma conta a receber pelo tipo da forma de pagamento.
 *
 * O celular manda "pix"/"dinheiro"/"credito" e o desktop resolve para a forma LOCAL daquele
 * tipo: `payment_methods` é configuração por máquina (cada maquininha tem a própria taxa) e
 * não sincroniza de propósito — ver module.manifest.ts. Quitar o total, e não um valor
 * parcial, mantém a operação simples e sem rolagem de saldo pelo celular.
 */
export function receiveReceivableFull(
  req: Request,
  id: string | number,
  input: { paymentMethodType?: string; settledAt?: string },
): SettleBillResult {
  const cfg = RECEIVABLES_CONFIG;
  const bill = getBill(cfg, id) as BillRow | undefined;
  if (!bill) return { ok: false, status: 404, error: 'Conta não encontrada.' };
  if (bill.status !== 'aberta') return { ok: false, status: 400, error: `Conta já está "${bill.status}".` };

  const type = String(input?.paymentMethodType ?? '').trim();
  if (!type || type === 'prazo') {
    return { ok: false, status: 400, error: 'Escolha uma forma de pagamento.' };
  }
  const method = paymentMethodRepository.findByType(type) as { id: number; type: string } | undefined;
  if (!method) {
    return { ok: false, status: 400, error: 'Esta forma de pagamento não está ativa no computador da loja.' };
  }

  const { multaCents, jurosCents } = computeLateCharges(bill.amount_cents, bill.due_date);
  const owedCents = bill.amount_cents + multaCents + jurosCents;
  return settleBill(cfg, req, id, {
    payments: [{ paymentMethodId: method.id, amountCents: owedCents }],
    settledAt: input?.settledAt,
  });
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
                        b.installment_group_id, b.installment_no, b.installment_count${saleIdCol}${categoryCols},
                        b.attachment_file, b.attachment_name, b.attachment_mime, b.attachment_size
                 FROM ${cfg.table} b LEFT JOIN ${cfg.partyTable} p ON p.id = b.${cfg.partyColumn}
                      LEFT JOIN payment_methods spm ON spm.id = b.settle_payment_method_id${categoryJoin}
                 WHERE b.deleted_at IS NULL ${conditions} ORDER BY b.due_date, b.id`;
    const rows = repo.raw(sql, ...params) as { status: string; amount_cents: number; due_date: string }[];
    res.json(rows.map(withLateInfo));
  });

  router.post('/', requirePermission(`${cfg.permPrefix}.create`), validateBody(createBillSchema), (req, res) => {
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

  router.put('/:id', requirePermission(`${cfg.permPrefix}.edit`), validateBody(updateBillSchema), (req, res) => {
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

  router.post('/:id/settle', requirePermission(cfg.settlePermission), validateBody(settleBillSchema), (req: Request, res) => {
    const out = settleBill(cfg, req, String(req.params.id), req.body ?? {});
    if (!out.ok) {
      res.status(out.status).json(out.code ? { error: out.error, code: out.code } : { error: out.error });
      return;
    }
    res.json({
      ok: true,
      settledCents: out.settledCents,
      rolledOverCents: out.rolledOverCents,
      rolloverTarget: out.rolloverTarget,
      registeredInCash: out.registeredInCash,
    });
  });

  // ─── Anexo de documento (boleto, nota, comprovante) ───
  // O arquivo chega em base64 no corpo JSON e é gravado em disco; na conta fica só a
  // referência. Anexar conta como "editar" (ou "criar", para quem acabou de lançar a conta
  // e ainda não tem a permissão de edição).

  router.post('/:id/attachment', requireAnyPermission(`${cfg.permPrefix}.edit`, `${cfg.permPrefix}.create`), (req, res) => {
    const id = String(req.params.id);
    const bill = getBill(cfg, id) as BillRow | undefined;
    if (!bill) {
      res.status(404).json({ error: 'Conta não encontrada.' });
      return;
    }
    const file = typeof req.body?.file === 'string' ? req.body.file : '';
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    if (!file) {
      res.status(400).json({ error: 'Nenhum arquivo enviado.' });
      return;
    }
    const saved = saveBillAttachment(file, name);
    if (!saved.ok) {
      res.status(400).json({ error: saved.error });
      return;
    }
    // Troca de anexo: apaga o arquivo anterior depois de gravar o novo.
    deleteBillAttachmentFile(bill.attachment_file);
    repo.update(id, {
      attachment_file: saved.file,
      attachment_name: saved.name,
      attachment_mime: saved.mime,
      attachment_size: saved.size,
    });
    const after = getBill(cfg, id);
    audit(req, 'anexar', cfg.entity, id, { attachment_name: bill.attachment_name ?? null }, { attachment_name: saved.name, attachment_size: saved.size });
    res.json(after);
  });

  router.delete('/:id/attachment', requireAnyPermission(`${cfg.permPrefix}.edit`, `${cfg.permPrefix}.create`), (req, res) => {
    const id = String(req.params.id);
    const bill = getBill(cfg, id) as BillRow | undefined;
    if (!bill) {
      res.status(404).json({ error: 'Conta não encontrada.' });
      return;
    }
    deleteBillAttachmentFile(bill.attachment_file);
    repo.update(id, { attachment_file: null, attachment_name: null, attachment_mime: null, attachment_size: null });
    const after = getBill(cfg, id);
    audit(req, 'remover_anexo', cfg.entity, id, { attachment_name: bill.attachment_name ?? null }, null);
    res.json(after);
  });

  router.get('/:id/attachment', requirePermission(`${cfg.permPrefix}.view`), (req, res) => {
    const id = String(req.params.id);
    const bill = getBill(cfg, id) as BillRow | undefined;
    if (!bill || !bill.attachment_file) {
      res.status(404).json({ error: 'Esta conta não tem documento anexado.' });
      return;
    }
    const full = path.join(billAttachmentsDir(), path.basename(bill.attachment_file));
    if (!fs.existsSync(full)) {
      res.status(404).json({ error: 'O arquivo do anexo não está disponível neste computador.' });
      return;
    }
    const name = bill.attachment_name || path.basename(full);
    const buf = fs.readFileSync(full);
    res.setHeader('Content-Disposition', contentDisposition(name));
    res.setHeader('Content-Type', bill.attachment_mime || 'application/octet-stream');
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buf);
  });

  return router;
}
