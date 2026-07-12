import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getSqlite } from '../../core/database/connection';
import { getService, hasService } from '../../core/services/registry';
import { audit } from '../../core/audit/service';
import type { CommercialPricingService } from '../commercial/setup';
import type { FoodserviceKitchenService } from '../foodservice/setup';
import type { StoreSalesService } from '../store/setup';
import type { SaleInput } from '../store/sales';

interface OpenComandaParams { tableId?: number; customerId?: number; notes?: string }
interface AddItemParams { productId: number; qty: number; notes?: string; lineGroupUuid?: string }

export function openComanda(req: Request, params: OpenComandaParams): { ok: true; id: number } | { ok: false; error: string } {
  const db = getSqlite();
  if (params.tableId) {
    const table = db.prepare("SELECT id, status FROM store_tables WHERE id = ? AND deleted_at IS NULL").get(params.tableId) as { id: number; status: string } | undefined;
    if (!table) return { ok: false, error: 'Mesa nao encontrada.' };
    if (table.status !== 'livre') return { ok: false, error: 'Mesa ja esta ocupada.' };
  }
  const id = db.prepare(
    `INSERT INTO comandas (table_id, customer_id, opened_by, notes, uuid, origin_machine)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    params.tableId ?? null, params.customerId ?? null, req.user!.id, params.notes ?? null,
    randomUUID(), req.headers['x-machine'] ?? null,
  ).lastInsertRowid;
  if (params.tableId) {
    db.prepare("UPDATE store_tables SET status = 'ocupada', updated_at = datetime('now') WHERE id = ?").run(params.tableId);
  }
  audit(req, 'abrir_comanda', 'comanda', Number(id), null, { tableId: params.tableId, customerId: params.customerId });
  return { ok: true, id: Number(id) };
}

export function addItem(req: Request, comandaId: number, params: AddItemParams): { ok: true; id: number } | { ok: false; error: string } {
  const db = getSqlite();
  const comanda = db.prepare("SELECT id, status, table_id FROM comandas WHERE id = ? AND deleted_at IS NULL").get(comandaId) as { id: number; status: string; table_id: number | null } | undefined;
  if (!comanda) return { ok: false, error: 'Comanda nao encontrada.' };
  if (comanda.status !== 'aberta') return { ok: false, error: 'Comanda nao esta aberta.' };
  const product = db.prepare("SELECT id, name, price_cents, deleted_at FROM products WHERE id = ? AND deleted_at IS NULL").get(params.productId) as { id: number; name: string; price_cents: number; deleted_at: string | null } | undefined;
  if (!product) return { ok: false, error: 'Produto nao encontrado.' };
  // Congelar preco via resolvePrice (mesmo servico que createSale usa)
  const pricing = getService<CommercialPricingService>('commercial.pricing');
  const priceResult = pricing.resolvePrice({ productId: product.id, qty: params.qty, customerId: comanda.customer_id ?? undefined });
  const unitPriceCents = priceResult?.unitCents ?? product.price_cents;
  const itemId = db.prepare(
    `INSERT INTO comanda_items (comanda_id, product_id, product_name, qty, unit_price_cents, notes, line_group_uuid, added_by, uuid, origin_machine)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    comandaId, product.id, product.name, params.qty, unitPriceCents,
    params.notes ?? null, params.lineGroupUuid ?? null, req.user!.id,
    randomUUID(), req.headers['x-machine'] ?? null,
  ).lastInsertRowid;
  audit(req, 'adicionar_item_comanda', 'comanda_item', Number(itemId), null, { comandaId, productId: product.id, qty: params.qty, unitPriceCents });
  // Notificar cozinha best-effort
  if (hasService('foodservice.kitchen')) {
    try {
      const tableLabel = comanda.table_id
        ? (db.prepare("SELECT label FROM store_tables WHERE id = ?").get(comanda.table_id) as { label: string } | undefined)?.label
        : undefined;
      getService<FoodserviceKitchenService>('foodservice.kitchen').notifyOrder(req, {
        sourceType: 'comanda', sourceId: comandaId,
        tableLabel,
        items: [{ productId: product.id, name: product.name, qty: params.qty, notes: params.notes }],
      });
    } catch { /* best-effort */ }
  }
  return { ok: true, id: Number(itemId) };
}

export function voidItem(req: Request, comandaId: number, itemId: number): { ok: true } | { ok: false; error: string } {
  const db = getSqlite();
  const item = db.prepare("SELECT id, voided_at FROM comanda_items WHERE id = ? AND comanda_id = ? AND deleted_at IS NULL").get(itemId, comandaId) as { id: number; voided_at: string | null } | undefined;
  if (!item) return { ok: false, error: 'Item nao encontrado.' };
  if (item.voided_at) return { ok: false, error: 'Item ja foi anulado.' };
  db.prepare("UPDATE comanda_items SET voided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(itemId);
  audit(req, 'anular_item_comanda', 'comanda_item', itemId);
  return { ok: true };
}

export function transfer(req: Request, comandaId: number, targetTableId: number): { ok: true } | { ok: false; error: string } {
  const db = getSqlite();
  const comanda = db.prepare("SELECT id, table_id, status FROM comandas WHERE id = ? AND deleted_at IS NULL").get(comandaId) as { id: number; table_id: number | null; status: string } | undefined;
  if (!comanda) return { ok: false, error: 'Comanda nao encontrada.' };
  if (comanda.status !== 'aberta') return { ok: false, error: 'Comanda nao esta aberta.' };
  const target = db.prepare("SELECT id, status FROM store_tables WHERE id = ? AND deleted_at IS NULL").get(targetTableId) as { id: number; status: string } | undefined;
  if (!target) return { ok: false, error: 'Mesa destino nao encontrada.' };
  if (target.status !== 'livre') return { ok: false, error: 'Mesa destino esta ocupada.' };
  db.transaction(() => {
    if (comanda.table_id) db.prepare("UPDATE store_tables SET status = 'livre', updated_at = datetime('now') WHERE id = ?").run(comanda.table_id);
    db.prepare("UPDATE store_tables SET status = 'ocupada', updated_at = datetime('now') WHERE id = ?").run(targetTableId);
    db.prepare("UPDATE comandas SET table_id = ?, updated_at = datetime('now') WHERE id = ?").run(targetTableId, comandaId);
  })();
  audit(req, 'transferir_comanda', 'comanda', comandaId, { tableIdAntes: comanda.table_id }, { tableIdDepois: targetTableId });
  return { ok: true };
}

export function split(req: Request, comandaId: number, itemIds: number[]): { ok: true; newComandaId: number } | { ok: false; error: string } {
  const db = getSqlite();
  if (!itemIds?.length) return { ok: false, error: 'Nenhum item informado para dividir.' };
  const comanda = db.prepare("SELECT id, table_id, customer_id, status, notes FROM comandas WHERE id = ? AND deleted_at IS NULL").get(comandaId) as any;
  if (!comanda || comanda.status !== 'aberta') return { ok: false, error: 'Comanda nao encontrada ou nao esta aberta.' };
  // Validar que todos os itens pertencem a esta comanda e nao estao anulados
  const items = db.prepare(
    "SELECT id FROM comanda_items WHERE id IN (" + itemIds.map(() => '?').join(',') + ") AND comanda_id = ? AND deleted_at IS NULL AND voided_at IS NULL",
  ).all(...itemIds, comandaId) as { id: number }[];
  if (items.length !== itemIds.length) return { ok: false, error: 'Um ou mais itens nao encontrados ou ja anulados.' };
  let newComandaId: number;
  db.transaction(() => {
    const r = db.prepare(
      "INSERT INTO comandas (table_id, customer_id, opened_by, notes, uuid, origin_machine) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(null, comanda.customer_id, req.user!.id, comanda.notes, randomUUID(), req.headers['x-machine'] ?? null);
    newComandaId = Number(r.lastInsertRowid);
    // Mover itens para a nova comanda
    const ph = itemIds.map(() => '?').join(',');
    db.prepare(`UPDATE comanda_items SET comanda_id = ?, updated_at = datetime('now') WHERE id IN (${ph})`).run(newComandaId, ...itemIds);
    audit(req, 'dividir_comanda', 'comanda', comandaId, null, { origem: comandaId, destino: newComandaId, itens: itemIds });
  })();
  return { ok: true, newComandaId: newComandaId! };
}

export function merge(req: Request, targetComandaId: number, sourceComandaId: number): { ok: true } | { ok: false; error: string } {
  const db = getSqlite();
  if (targetComandaId === sourceComandaId) return { ok: false, error: 'Nao e possivel unir uma comanda com ela mesma.' };
  const target = db.prepare("SELECT id, status FROM comandas WHERE id = ? AND deleted_at IS NULL").get(targetComandaId) as any;
  if (!target || target.status !== 'aberta') return { ok: false, error: 'Comanda destino nao encontrada ou nao esta aberta.' };
  const source = db.prepare("SELECT id, status, table_id FROM comandas WHERE id = ? AND deleted_at IS NULL").get(sourceComandaId) as any;
  if (!source || source.status !== 'aberta') return { ok: false, error: 'Comanda origem nao encontrada ou nao esta aberta.' };
  db.transaction(() => {
    db.prepare("UPDATE comanda_items SET comanda_id = ?, updated_at = datetime('now') WHERE comanda_id = ? AND deleted_at IS NULL AND voided_at IS NULL").run(targetComandaId, sourceComandaId);
    // Cancelar comanda origem
    db.prepare("UPDATE comandas SET status = 'cancelada', updated_at = datetime('now') WHERE id = ?").run(sourceComandaId);
    if (source.table_id) db.prepare("UPDATE store_tables SET status = 'livre', updated_at = datetime('now') WHERE id = ?").run(source.table_id);
    audit(req, 'unir_comandas', 'comanda', sourceComandaId, null, { origem: sourceComandaId, destino: targetComandaId });
  })();
  return { ok: true };
}

export function closeComanda(
  req: Request, comandaId: number,
  input: { payments: any[]; discountCents?: number; surchargeCents?: number; customerId?: number },
): { ok: true; saleId: number } | { ok: false; error: string } {
  const db = getSqlite();
  const comanda = db.prepare("SELECT * FROM comandas WHERE id = ? AND deleted_at IS NULL").get(comandaId) as any;
  if (!comanda) return { ok: false, error: 'Comanda nao encontrada.' };
  if (comanda.status !== 'aberta') return { ok: false, error: 'Comanda nao esta aberta.' };
  // Montar SaleInput a partir dos comanda_items
  const items = db.prepare(
    "SELECT product_id AS productId, qty, notes, line_group_uuid AS lineGroupUuid, unit_price_cents FROM comanda_items WHERE comanda_id = ? AND deleted_at IS NULL AND voided_at IS NULL ORDER BY id",
  ).all(comandaId) as any[];
  if (!items.length) return { ok: false, error: 'Comanda sem itens para fechar.' };
  const saleInput: SaleInput = {
    items: items.map((i: any) => ({
      productId: i.productId,
      qty: i.qty,
      notes: i.notes ?? undefined,
      lineGroupUuid: i.lineGroupUuid ?? undefined,
      unitPriceCents: i.unit_price_cents,
    })),
    payments: input.payments,
    discountCents: input.discountCents,
    surchargeCents: input.surchargeCents,
    customerId: input.customerId ?? comanda.customer_id ?? undefined,
  };
  const storeSales = getService<StoreSalesService>('store.sales');
  const saleResult = storeSales.createSale(req, saleInput, { allowPriceOverride: true });
  if (!saleResult.ok) return { ok: false, error: saleResult.error };
  // Marcar comanda como fechada
  db.transaction(() => {
    db.prepare("UPDATE comandas SET status = 'fechada', sale_id = ?, closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(saleResult.id, comandaId);
    if (comanda.table_id) db.prepare("UPDATE store_tables SET status = 'livre', updated_at = datetime('now') WHERE id = ?").run(comanda.table_id);
  })();
  audit(req, 'fechar_comanda', 'comanda', comandaId, null, { saleId: saleResult.id });
  return { ok: true, saleId: saleResult.id };
}

export function cancelComanda(req: Request, comandaId: number): { ok: true } | { ok: false; error: string } {
  const db = getSqlite();
  const comanda = db.prepare("SELECT id, table_id, status FROM comandas WHERE id = ? AND deleted_at IS NULL").get(comandaId) as any;
  if (!comanda) return { ok: false, error: 'Comanda nao encontrada.' };
  if (comanda.status !== 'aberta') return { ok: false, error: 'Comanda nao esta aberta.' };
  db.transaction(() => {
    db.prepare("UPDATE comandas SET status = 'cancelada', updated_at = datetime('now') WHERE id = ?").run(comandaId);
    if (comanda.table_id) db.prepare("UPDATE store_tables SET status = 'livre', updated_at = datetime('now') WHERE id = ?").run(comanda.table_id);
  })();
  audit(req, 'cancelar_comanda', 'comanda', comandaId);
  return { ok: true };
}
