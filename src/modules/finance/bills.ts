import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { getSqlite } from '../../core/database/connection';
import { requirePermission } from '../../core/permissions/middleware';
import { audit } from '../../core/audit/service';
import { currentRegister, addMovement } from './cash';
import { computeLateCharges } from './lateFees';

/**
 * Fábrica de contas (a pagar / a receber) — mesma mecânica, direções opostas.
 * Liquidar com caixa aberto gera movimento na gaveta (pagamento=saída, recebimento=entrada) —
 * só quando a forma de pagamento usada é literalmente "dinheiro" (ver POST /:id/settle).
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

/** YYYY-MM-DD + N dias — mesma aritmética (sem depender de fuso) já usada em store/sales.ts
 * pro parcelamento de venda a prazo. */
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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
  // receivables vindas de venda a prazo se agrupam por sale_id (parcelamento já existente em
  // store/sales.ts) — payables não tem essa coluna, nunca existiu venda lá.
  const saleIdCol = cfg.table === 'receivables' ? ', b.sale_id' : '';

  const get = (id: string | number) =>
    db().prepare(
      `SELECT b.id, b.description, b.${cfg.partyColumn} AS party_id, p.name AS party,
              b.amount_cents, b.issue_date, b.due_date, b.status, b.${cfg.settleDateCol} AS settled_at,
              b.${cfg.settleCentsCol} AS settled_cents, b.notes, b.updated_at,
              b.settle_payment_method_id, spm.name AS settle_method_name,
              b.installment_group_id, b.installment_no, b.installment_count${saleIdCol}${categoryCols}
       FROM ${cfg.table} b LEFT JOIN ${cfg.partyTable} p ON p.id = b.${cfg.partyColumn}
            LEFT JOIN payment_methods spm ON spm.id = b.settle_payment_method_id${categoryJoin}
       WHERE b.id = ? AND b.deleted_at IS NULL`,
    ).get(id) as (BillRow & Record<string, unknown>) | undefined;

  /** Contas em aberto ganham a sugestão de valor com multa/juros (Configurações → Financeiro),
   * calculada sempre no servidor — nunca a partir de um valor "atualizado" vindo do cliente. */
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
    const rows = db().prepare(sql).all(...params) as { status: string; amount_cents: number; due_date: string }[];
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
    // Emissão é opcional na API (compatibilidade), mas a UI sempre manda — se omitida, assume hoje.
    const issueDateValue = issueDate || new Date().toISOString().slice(0, 10);
    let categoryId: number | null = null;
    if (cfg.categoryField) {
      const validated = validateDreCategory(db, dreCategoryId);
      if (validated === 'invalid') {
        res.status(400).json({ error: 'Categoria do DRE inválida.' });
        return;
      }
      categoryId = validated ?? defaultCategoryId(db);
    }

    const database = db();
    const groupId = count > 1 ? randomUUID() : null;
    // Mesmo split de store/sales.ts: resto da divisão inteira vai pra primeira parcela.
    const base = Math.floor(amountCents / count);
    const remainder = amountCents - base * count;
    const cols = ['description', cfg.partyColumn, 'amount_cents', 'issue_date', 'due_date', 'notes',
      'installment_group_id', 'installment_no', 'installment_count', 'uuid'];
    if (cfg.categoryField) cols.push('dre_category_id');
    const insertStmt = database.prepare(`INSERT INTO ${cfg.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);

    let firstId = 0;
    database.transaction(() => {
      for (let n = 0; n < count; n++) {
        const amt = n === 0 ? base + remainder : base;
        const due = addDays(dueDate, 30 * n);
        const values: unknown[] = [description, partyId ?? null, amt, issueDateValue, due, notes ?? null,
          groupId, count > 1 ? n + 1 : null, count > 1 ? count : null, randomUUID()];
        if (cfg.categoryField) values.push(categoryId);
        const info = insertStmt.run(...values);
        if (n === 0) firstId = Number(info.lastInsertRowid);
      }
    })();
    const created = withLateInfo(get(firstId) as BillRow & { status: string; amount_cents: number; due_date: string });
    audit(req, 'criar', cfg.entity, firstId, null, { ...created, installments: count });
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
    const { description, amountCents, issueDate, dueDate, partyId, notes, status, dreCategoryId } = req.body ?? {};
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
         issue_date = COALESCE(?, issue_date), due_date = COALESCE(?, due_date), ${cfg.partyColumn} = COALESCE(?, ${cfg.partyColumn}),
         notes = COALESCE(?, notes), status = COALESCE(?, status),
         ${cfg.categoryField ? 'dre_category_id = COALESCE(?, dre_category_id),' : ''} updated_at = datetime('now')
       WHERE id = ?`,
    ).run(...[description ?? null, amountCents ?? null, issueDate ?? null, dueDate ?? null, partyId ?? null, notes ?? null, status ?? null,
      ...(cfg.categoryField ? [categoryId ?? null] : []), id]);
    const after = get(id);
    audit(req, status === 'cancelada' ? 'cancelar' : 'editar', cfg.entity, id, before, after);
    res.json(after);
  });

  router.post('/:id/settle', requirePermission(cfg.settlePermission), (req: Request, res) => {
    const id = String(req.params.id);
    const bill = get(id) as BillRow | undefined;
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
      const method = db().prepare(
        "SELECT id, type FROM payment_methods WHERE id = ? AND active = 1 AND deleted_at IS NULL AND type != 'prazo'",
      ).get(p?.paymentMethodId) as { id: number; type: string } | undefined;
      if (!method) {
        res.status(400).json({ error: 'Forma de pagamento inválida.' });
        return;
      }
      resolved.push({ method, amountCents: amt });
    }
    const totalPaidCents = resolved.reduce((s, p) => s + p.amountCents, 0);

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

    // Multa/juros recalculados no servidor (nunca a partir do que o cliente mandar) — definem
    // o valor "de verdade" devido hoje, usado só pra decidir se sobrou diferença a ratear.
    const { multaCents, jurosCents } = computeLateCharges(bill.amount_cents, bill.due_date);
    const owedCents = bill.amount_cents + multaCents + jurosCents;

    // Só forma de pagamento "dinheiro" mexe na gaveta — e só nesse caso exigimos caixa
    // aberto, mesma regra já usada no PDV (store/sales.ts) pra venda em dinheiro. Checado
    // ANTES de qualquer escrita: nada é marcado como liquidado se o caixa precisa estar
    // aberto e não está.
    const hasCash = resolved.some((p) => p.method.type === 'dinheiro');
    const cashCents = resolved.filter((p) => p.method.type === 'dinheiro').reduce((s, p) => s + p.amountCents, 0);
    const reg = currentRegister();
    if (hasCash && !reg) {
      res.status(400).json({ error: 'Abra o caixa antes de liquidar em dinheiro.', code: 'no_register' });
      return;
    }

    const database = db();
    let rolledOverCents = 0;
    let rolloverTarget: 'existing' | 'new' | null = null;

    database.transaction(() => {
      const soleMethodId = resolved.length === 1 ? resolved[0].method.id : null;
      database.prepare(
        `UPDATE ${cfg.table} SET status = ?, ${cfg.settleDateCol} = COALESCE(?, datetime('now')),
           ${cfg.settleCentsCol} = ?, amount_cents = ?, settle_payment_method_id = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(cfg.settleStatus, settledAtValue, totalPaidCents, totalPaidCents, soleMethodId, id);

      const insertSettlePay = database.prepare(
        `INSERT INTO bill_settlement_payments (entity, bill_id, payment_method_id, amount_cents) VALUES (?, ?, ?, ?)`,
      );
      for (const p of resolved) insertSettlePay.run(cfg.entity, id, p.method.id, p.amountCents);

      if (hasCash && reg && cashCents > 0) {
        addMovement(req, reg.id, cfg.movementDirection, cfg.movementType, cashCents, bill.description, cfg.entity, id);
      }

      // Rateio automático: se pagou menos que o devido (com multa/juros), a diferença vai
      // pra próxima parcela em aberto do mesmo grupo — ou vira uma parcela nova (empurra o
      // grupo pra frente) se não houver uma.
      const shortfall = owedCents - totalPaidCents;
      if (shortfall > 0) {
        rolledOverCents = shortfall;
        const currentNo = bill.installment_no ?? 1;
        let next: { id: number } | undefined;
        if (bill.installment_group_id) {
          next = database.prepare(
            `SELECT id FROM ${cfg.table} WHERE installment_group_id = ? AND installment_no = ? AND status = 'aberta'`,
          ).get(bill.installment_group_id, currentNo + 1) as { id: number } | undefined;
        } else if (cfg.table === 'receivables' && bill.sale_id) {
          next = database.prepare(
            `SELECT id FROM receivables WHERE sale_id = ? AND installment_no = ? AND status = 'aberta'`,
          ).get(bill.sale_id, currentNo + 1) as { id: number } | undefined;
        }

        if (next) {
          database.prepare(`UPDATE ${cfg.table} SET amount_cents = amount_cents + ?, updated_at = datetime('now') WHERE id = ?`)
            .run(shortfall, next.id);
          rolloverTarget = 'existing';
        } else {
          const groupId = bill.installment_group_id ?? randomUUID();
          if (!bill.installment_group_id) {
            // Conta que não era parcelada — vira o início de um grupo de 2 a partir de agora.
            database.prepare(`UPDATE ${cfg.table} SET installment_group_id = ?, installment_no = 1 WHERE id = ?`).run(groupId, id);
          }
          const newDue = addDays(bill.due_date, 30);
          const newNo = currentNo + 1;
          const cols = ['description', cfg.partyColumn, 'amount_cents', 'issue_date', 'due_date', 'notes',
            'installment_group_id', 'installment_no', 'installment_count', 'uuid'];
          if (cfg.categoryField) cols.push('dre_category_id');
          const values: unknown[] = [bill.description, bill.party_id, shortfall, new Date().toISOString().slice(0, 10),
            newDue, bill.notes, groupId, newNo, null, randomUUID()];
          if (cfg.categoryField) values.push((bill as unknown as { dre_category_id: number | null }).dre_category_id ?? defaultCategoryId(db));
          database.prepare(`INSERT INTO ${cfg.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...values);
          rolloverTarget = 'new';
          // Resincroniza o "X/Y" em todas as parcelas do grupo de uma vez — mais simples e
          // robusto que ir incrementando installment_count manualmente linha por linha.
          database.prepare(
            `UPDATE ${cfg.table} SET installment_count = (SELECT COUNT(*) FROM ${cfg.table} WHERE installment_group_id = ? AND deleted_at IS NULL)
             WHERE installment_group_id = ?`,
          ).run(groupId, groupId);
        }
      }
    })();

    audit(req, cfg.settleAction, cfg.entity, id, bill, {
      totalPaidCents, methods: resolved.map((p) => ({ id: p.method.id, amountCents: p.amountCents })),
      rolledOverCents, rolloverTarget, caixa: hasCash ? reg?.id : null,
    });
    res.json({ ok: true, settledCents: totalPaidCents, rolledOverCents, rolloverTarget, registeredInCash: hasCash });
  });

  return router;
}
