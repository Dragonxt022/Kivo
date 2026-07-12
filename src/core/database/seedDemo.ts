import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getSqlite } from './connection';
import { createSale } from '../../modules/store/sales';
import { openRegister, closeRegister } from '../../modules/finance/cash';
import { moveStockRaw } from '../../modules/commercial/stock';

/**
 * Seed de demonstração: popula o banco com ~30 dias de operação simulada de uma loja
 * de materiais de construção (produtos, clientes, fornecedores, categorias de DRE),
 * reaproveitando as mesmas funções de negócio da API (createSale, openRegister/closeRegister,
 * moveStockRaw) para garantir que estoque/caixa/recebíveis fiquem matematicamente
 * consistentes como ficariam via uso real. Rode via `npm run db:seed:demo` (chama
 * resetTestData() antes — todo dado de negócio anterior é substituído).
 */

export interface SeedDemoSummary {
  days: number;
  products: number;
  customers: number;
  suppliers: number;
  sales: number;
  purchases: number;
  payables: number;
  revenueCents: number;
}

function rInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: T[]): T {
  return arr[rInt(0, arr.length - 1)];
}

function sampleUnique<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && copy.length; i++) {
    out.push(copy.splice(rInt(0, copy.length - 1), 1)[0]);
  }
  return out;
}

function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Monta um Request "fake" mínimo com um usuário administrador real (mesmo formato de
 * AuthUser que src/core/auth/service.ts:loadAuthUser produz) — só o suficiente para as
 * funções de negócio (audit, permissões, user_id de referência) funcionarem sem sessão HTTP. */
function fakeAdminRequest(): Request {
  const db = getSqlite();
  const admin = db.prepare(
    `SELECT u.id, u.username, u.name, u.role_id, r.slug AS role_slug
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.slug = 'administrador' AND u.active = 1 AND u.deleted_at IS NULL
     ORDER BY u.id LIMIT 1`,
  ).get() as { id: number; username: string; name: string; role_id: number; role_slug: string } | undefined;
  if (!admin) throw new Error('Nenhum usuário administrador encontrado — rode as migrations/seeds do core primeiro.');
  const perms = db.prepare('SELECT permission_key FROM role_permissions WHERE role_id = ?').all(admin.role_id) as { permission_key: string }[];
  const user = {
    id: admin.id, username: admin.username, name: admin.name,
    roleId: admin.role_id, roleSlug: admin.role_slug,
    permissions: new Set(perms.map((p) => p.permission_key)),
  };
  return { user, ip: '127.0.0.1', headers: {} } as unknown as Request;
}

const CATEGORY_NAMES = ['Materiais de Construção', 'Elétrica', 'Hidráulica', 'Tintas e Acabamento', 'Ferramentas', 'Limpeza'] as const;

const PRODUCTS: { name: string; category: (typeof CATEGORY_NAMES)[number]; priceCents: number; costCents: number; stock: number }[] = [
  { name: 'Argamassa 20kg', category: 'Materiais de Construção', priceCents: 3000, costCents: 1800, stock: 200 },
  { name: 'Cimento CP-II 50kg', category: 'Materiais de Construção', priceCents: 3800, costCents: 2600, stock: 150 },
  { name: 'Areia Média (m³)', category: 'Materiais de Construção', priceCents: 12000, costCents: 8000, stock: 40 },
  { name: 'Tijolo Cerâmico (milheiro)', category: 'Materiais de Construção', priceCents: 65000, costCents: 48000, stock: 20 },
  { name: 'Bloco de Concreto 14x19x39', category: 'Materiais de Construção', priceCents: 350, costCents: 220, stock: 500 },
  { name: 'Cal Hidratada 20kg', category: 'Materiais de Construção', priceCents: 1500, costCents: 900, stock: 100 },
  { name: 'Fio Elétrico 2,5mm (rolo 100m)', category: 'Elétrica', priceCents: 22000, costCents: 15000, stock: 60 },
  { name: 'Disjuntor 20A', category: 'Elétrica', priceCents: 1800, costCents: 1000, stock: 80 },
  { name: 'Tomada 10A', category: 'Elétrica', priceCents: 900, costCents: 450, stock: 150 },
  { name: 'Lâmpada LED 9W', category: 'Elétrica', priceCents: 1200, costCents: 600, stock: 200 },
  { name: 'Fita Isolante', category: 'Elétrica', priceCents: 500, costCents: 200, stock: 300 },
  { name: 'Quadro de Distribuição 12 disj.', category: 'Elétrica', priceCents: 8500, costCents: 5500, stock: 30 },
  { name: 'Tubo PVC 100mm (barra 6m)', category: 'Hidráulica', priceCents: 4500, costCents: 2800, stock: 80 },
  { name: 'Tubo PVC 50mm (barra 6m)', category: 'Hidráulica', priceCents: 2200, costCents: 1300, stock: 100 },
  { name: 'Joelho PVC 100mm', category: 'Hidráulica', priceCents: 800, costCents: 400, stock: 200 },
  { name: 'Registro de Gaveta 3/4', category: 'Hidráulica', priceCents: 3200, costCents: 1900, stock: 60 },
  { name: 'Torneira de Metal', category: 'Hidráulica', priceCents: 4500, costCents: 2600, stock: 50 },
  { name: "Caixa d'Água 500L", category: 'Hidráulica', priceCents: 35000, costCents: 24000, stock: 15 },
  { name: 'Tinta Acrílica 18L Branca', category: 'Tintas e Acabamento', priceCents: 18000, costCents: 11000, stock: 40 },
  { name: 'Tinta Esmalte 3,6L', category: 'Tintas e Acabamento', priceCents: 6500, costCents: 4000, stock: 60 },
  { name: 'Rolo de Pintura', category: 'Tintas e Acabamento', priceCents: 1500, costCents: 800, stock: 100 },
  { name: 'Pincel 2"', category: 'Tintas e Acabamento', priceCents: 900, costCents: 400, stock: 150 },
  { name: 'Piso Cerâmico (m²)', category: 'Tintas e Acabamento', priceCents: 3500, costCents: 2200, stock: 300 },
  { name: 'Rejunte 1kg', category: 'Tintas e Acabamento', priceCents: 1200, costCents: 700, stock: 150 },
  { name: 'Furadeira de Impacto', category: 'Ferramentas', priceCents: 25000, costCents: 16000, stock: 20 },
  { name: 'Martelo Unha', category: 'Ferramentas', priceCents: 3500, costCents: 2000, stock: 40 },
  { name: 'Trena 5m', category: 'Ferramentas', priceCents: 2200, costCents: 1200, stock: 60 },
  { name: 'Nível de Bolha', category: 'Ferramentas', priceCents: 1800, costCents: 900, stock: 50 },
  { name: 'Vassoura', category: 'Limpeza', priceCents: 1200, costCents: 600, stock: 80 },
  { name: 'Pá de Lixo', category: 'Limpeza', priceCents: 900, costCents: 450, stock: 60 },
];

const CUSTOMERS = ['Maria Silva', 'João Pereira', 'Construtora XYZ Ltda', 'Carlos Souza', 'Ana Oliveira', 'Pedro Santos', 'Fernanda Lima', 'Roberto Alves'];

const SUPPLIERS = ['Distribuidora ABC', 'Casa do Construtor Atacado', 'Elétrica Distribuidora Ltda', 'Tintas & Cia Distribuição', 'Hidro Materiais Ltda'];

const DRE_MANUAL_CATEGORIES = ['Aluguel', 'Energia Elétrica', 'Água', 'Internet/Telefone', 'Salários', 'Marketing'];

function seedMasterData(db: ReturnType<typeof getSqlite>) {
  const categoryIds: Record<string, number> = {};
  for (const name of CATEGORY_NAMES) {
    const info = db.prepare('INSERT INTO categories (name, uuid) VALUES (?, ?)').run(name, randomUUID());
    categoryIds[name] = Number(info.lastInsertRowid);
  }

  const products = PRODUCTS.map((p) => {
    const info = db.prepare(
      `INSERT INTO products (name, category_id, price_cents, cost_cents, stock_qty, uuid) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(p.name, categoryIds[p.category], p.priceCents, p.costCents, p.stock, randomUUID());
    return { id: Number(info.lastInsertRowid), ...p };
  });
  // stock_qty inicial não passa pelo ledger (é só o ponto de partida da simulação) — registra
  // uma entrada de ajuste para o histórico de estoque não começar "do nada".
  for (const p of products) {
    db.prepare(
      `INSERT INTO stock_movements (product_id, type, qty, balance_after, reason, uuid) VALUES (?, 'ajuste', ?, ?, 'Estoque inicial (seed demo)', ?)`,
    ).run(p.id, p.stock, p.stock, randomUUID());
  }

  const customerIds = CUSTOMERS.map((name) => {
    const info = db.prepare('INSERT INTO customers (name, uuid) VALUES (?, ?)').run(name, randomUUID());
    return Number(info.lastInsertRowid);
  });

  const supplierIds = SUPPLIERS.map((name) => {
    const info = db.prepare('INSERT INTO suppliers (name, uuid) VALUES (?, ?)').run(name, randomUUID());
    return Number(info.lastInsertRowid);
  });

  const dreCategoryIds: Record<string, number> = {};
  for (const label of DRE_MANUAL_CATEGORIES) {
    const info = db.prepare(
      `INSERT INTO dre_categories (key, label, dre_line, source, adjustment_bps, uuid) VALUES (?, ?, 'despesas_operacionais', 'manual', 0, ?)`,
    ).run(`seed_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, label, randomUUID());
    dreCategoryIds[label] = Number(info.lastInsertRowid);
  }

  const paymentMethods = db.prepare(
    "SELECT id, type FROM payment_methods WHERE active = 1 AND deleted_at IS NULL",
  ).all() as { id: number; type: string }[];
  const methodIdByType: Record<string, number> = {};
  for (const m of paymentMethods) methodIdByType[m.type] = m.id;

  return { products, customerIds, supplierIds, dreCategoryIds, methodIdByType };
}

/** dinheiro/pix/débito/crédito majoritários, ~10% a prazo. */
function weightedPaymentType(): string {
  const r = Math.random() * 100;
  if (r < 30) return 'dinheiro';
  if (r < 55) return 'pix';
  if (r < 75) return 'debito';
  if (r < 90) return 'credito';
  return 'prazo';
}

function backdateSale(db: ReturnType<typeof getSqlite>, saleId: number, ts: string): void {
  db.prepare(`UPDATE sales SET created_at = ?, updated_at = ? WHERE id = ?`).run(ts, ts, saleId);
  db.prepare(`UPDATE cash_movements SET created_at = ? WHERE ref_entity = 'sale' AND ref_id = ?`).run(ts, String(saleId));
  db.prepare(`UPDATE stock_movements SET created_at = ? WHERE ref_entity = 'sale' AND ref_id = ?`).run(ts, String(saleId));
  db.prepare(`UPDATE receivables SET updated_at = ? WHERE sale_id = ?`).run(ts, saleId);
}

/** Repõe só quem está baixo/negativo (venda no PDV pode vender sem estoque — allowNegative
 * — então dias de muita saída deixam saldo negativo). A quantidade é resolvida a partir do
 * saldo ATUAL de cada produto (não um intervalo fixo), garantindo que a entrada sempre chegue
 * a um nível saudável — moveStockRaw rejeita 'entrada' cujo saldo resultante ainda fique
 * negativo, então nunca uso um valor fixo pequeno demais para cobrir déficits grandes. */
function simulateRestockIfNeeded(
  req: Request, db: ReturnType<typeof getSqlite>, dateStr: string,
  supplierIds: number[], products: { id: number; costCents: number }[],
): boolean {
  const LOW_THRESHOLD = 40;
  const stockRows = db.prepare(
    `SELECT id, stock_qty FROM products WHERE id IN (${products.map(() => '?').join(',')})`,
  ).all(...products.map((p) => p.id)) as { id: number; stock_qty: number }[];
  const stockById = new Map(stockRows.map((r) => [r.id, r.stock_qty]));

  const low = products.filter((p) => (stockById.get(p.id) ?? 0) < LOW_THRESHOLD);
  if (!low.length) return false;

  const supplierId = pick(supplierIds);
  const ts = `${dateStr} 09:00:00`;
  let total = 0;
  const items = low.map((p) => {
    const targetLevel = rInt(80, 180);
    const qty = Math.max(10, targetLevel - (stockById.get(p.id) ?? 0));
    const unitCost = Math.round(p.costCents * (0.95 + Math.random() * 0.1));
    total += qty * unitCost;
    return { productId: p.id, qty, unitCost };
  });
  const info = db.prepare(
    `INSERT INTO purchases (supplier_id, status, total_cents, notes, received_at, uuid) VALUES (?, 'recebida', ?, ?, ?, ?)`,
  ).run(supplierId, total, 'Reposição de estoque (seed demo)', ts, randomUUID());
  const purchaseId = Number(info.lastInsertRowid);
  for (const it of items) {
    db.prepare(`INSERT INTO purchase_items (purchase_id, product_id, qty, unit_cost_cents) VALUES (?, ?, ?, ?)`)
      .run(purchaseId, it.productId, it.qty, it.unitCost);
    db.prepare(`UPDATE products SET cost_cents = ?, updated_at = ? WHERE id = ?`).run(it.unitCost, ts, it.productId);
    const move = moveStockRaw(req, it.productId, 'entrada', it.qty, 'compra (seed demo)', 'purchase', purchaseId);
    if (!move.ok) throw new Error(move.error);
  }
  db.prepare(`UPDATE stock_movements SET created_at = ? WHERE ref_entity = 'purchase' AND ref_id = ?`).run(ts, String(purchaseId));
  return true;
}

function seedPayables(db: ReturnType<typeof getSqlite>, windowStart: string, dreCategoryIds: Record<string, number>): number {
  const rows: { desc: string; category: string; day: number; amountCents: number; paid: boolean }[] = [
    { desc: 'Aluguel do galpão', category: 'Aluguel', day: 4, amountCents: 250000, paid: true },
    { desc: 'Internet e telefone', category: 'Internet/Telefone', day: 7, amountCents: 15000, paid: true },
    { desc: 'Conta de energia elétrica', category: 'Energia Elétrica', day: 9, amountCents: 45000, paid: true },
    { desc: 'Conta de água', category: 'Água', day: 11, amountCents: 12000, paid: true },
    { desc: 'Anúncios redes sociais', category: 'Marketing', day: 14, amountCents: 30000, paid: true },
    { desc: 'Panfletagem bairro', category: 'Marketing', day: 24, amountCents: 20000, paid: false },
    { desc: 'Salários e pró-labore', category: 'Salários', day: 29, amountCents: 800000, paid: false },
  ];
  let count = 0;
  for (const r of rows) {
    const dueDate = addDaysStr(windowStart, r.day);
    db.prepare(
      `INSERT INTO payables (description, amount_cents, due_date, status, paid_at, paid_cents, dre_category_id, uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.desc, r.amountCents, dueDate,
      r.paid ? 'paga' : 'aberta',
      r.paid ? `${dueDate} 10:00:00` : null,
      r.paid ? r.amountCents : null,
      dreCategoryIds[r.category], randomUUID(),
    );
    count++;
  }
  return count;
}

export function seedDemoData(): SeedDemoSummary {
  const db = getSqlite();
  const req = fakeAdminRequest();
  const { products, customerIds, supplierIds, dreCategoryIds, methodIdByType } = seedMasterData(db);

  const DAYS = 30;
  const windowStart = isoDaysAgo(DAYS - 1);
  let salesCount = 0;
  let purchasesCount = 0;
  let revenueCents = 0;

  for (let dayIdx = 0; dayIdx < DAYS; dayIdx++) {
    const dateStr = addDaysStr(windowStart, dayIdx);
    const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay(); // 0=domingo, 6=sábado
    const isWeekend = dow === 0 || dow === 6;

    const opened = openRegister(req, 20000);
    if (!opened.ok) throw new Error(`Dia ${dateStr}: ${opened.error}`);
    const registerId = opened.id;

    const saleCount = isWeekend ? rInt(18, 28) : rInt(12, 22);
    for (let i = 0; i < saleCount; i++) {
      const itemCount = rInt(1, 4);
      const items = sampleUnique(products, Math.min(itemCount, products.length)).map((p) => ({
        productId: p.id, qty: rInt(1, 5),
      }));
      const subtotal = items.reduce((sum, it) => {
        const p = products.find((pp) => pp.id === it.productId)!;
        return sum + p.priceCents * it.qty;
      }, 0);

      const methodType = weightedPaymentType();
      const methodId = methodIdByType[methodType];
      if (!methodId) continue; // forma de pagamento não cadastrada/ativa nesta instalação — pula

      let customerId = Math.random() < 0.4 ? undefined : pick(customerIds);
      if (methodType === 'prazo' && !customerId) customerId = pick(customerIds);

      const payment: { methodId: number; amountCents: number; receivedCents?: number; dueDate?: string } = {
        methodId, amountCents: subtotal,
      };
      if (methodType === 'dinheiro') payment.receivedCents = subtotal;
      if (methodType === 'prazo') payment.dueDate = addDaysStr(dateStr, 30);

      const result = createSale(req, { items, payments: [payment], customerId });
      if (!result.ok) throw new Error(`Dia ${dateStr}, venda ${i}: ${result.error}`);
      salesCount++;
      revenueCents += result.totalCents;

      const hour = rInt(8, 18);
      const minute = rInt(0, 59);
      const ts = `${dateStr} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
      backdateSale(db, result.id, ts);
    }

    const variance = Math.random() < 0.7 ? 0 : rInt(-500, 500);
    const registerExpected = db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction='entrada' THEN amount_cents ELSE -amount_cents END), 0) AS v
       FROM cash_movements WHERE register_id = ?`,
    ).get(registerId) as { v: number };
    const counted = Math.max(0, registerExpected.v + variance);
    const closed = closeRegister(req, counted);
    if (!closed.ok) throw new Error(`Dia ${dateStr} (fechamento): ${closed.error}`);

    const openedAt = `${dateStr} 08:00:00`;
    const closedAt = `${dateStr} 19:00:00`;
    db.prepare(`UPDATE cash_registers SET opened_at = ?, closed_at = ?, updated_at = ? WHERE id = ?`)
      .run(openedAt, closedAt, closedAt, registerId);
    db.prepare(`UPDATE cash_movements SET created_at = ? WHERE register_id = ? AND type = 'abertura'`).run(openedAt, registerId);

    const restocked = simulateRestockIfNeeded(req, db, dateStr, supplierIds, products);
    if (restocked) purchasesCount++;
  }

  const payablesCount = seedPayables(db, windowStart, dreCategoryIds);

  return {
    days: DAYS, products: products.length, customers: customerIds.length, suppliers: supplierIds.length,
    sales: salesCount, purchases: purchasesCount, payables: payablesCount, revenueCents,
  };
}
