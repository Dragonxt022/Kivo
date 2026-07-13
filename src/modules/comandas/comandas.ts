import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getService, hasService } from '../../core/services/registry';
import { audit } from '../../core/audit/service';
import type { CommercialPricingService } from '../commercial/setup';
import type { FoodserviceKitchenService } from '../foodservice/setup';
import type { StoreSalesService } from '../store/setup';
import type { SaleInput } from '../store/sales';
import { assertAuth } from '../../shared/auth';
import { comandaRepository, comandaItemRepository } from './repositories/ComandaRepository';
import { storeTableRepository } from './repositories/StoreTableRepository';

interface OpenComandaParams { tableId?: number; customerId?: number; notes?: string }
interface AddItemParams { productId: number; qty: number; notes?: string; lineGroupUuid?: string }

interface ComandaRow {
  id: number; table_id: number | null; status: string; notes: string | null;
  customer_id: number | null; opened_by: number; sale_id?: number | null;
  closed_at?: string | null;
}

interface ComandaItemRow { id: number; productId: number; qty: number; notes: string | null; lineGroupUuid: string | null; unit_price_cents: number }

export function openComanda(req: Request, params: OpenComandaParams): { ok: true; id: number } | { ok: false; error: string } {
  assertAuth(req);
  if (params.tableId) {
    const table = storeTableRepository.rawOne(
      "SELECT id, status FROM store_tables WHERE id = ? AND deleted_at IS NULL",
      params.tableId,
    ) as { id: number; status: string } | undefined;
    if (!table) return { ok: false, error: 'Mesa nao encontrada.' };
    if (table.status !== 'livre') return { ok: false, error: 'Mesa ja esta ocupada.' };
  }
  const id = comandaRepository.create({
    table_id: params.tableId ?? null,
    customer_id: params.customerId ?? null,
    opened_by: req.user.id,
    notes: params.notes ?? null,
    uuid: randomUUID(),
    origin_machine: req.headers['x-machine'] ?? null,
  });
  if (params.tableId) {
    storeTableRepository.occupy(params.tableId);
  }
  audit(req, 'abrir_comanda', 'comanda', id, null, { tableId: params.tableId, customerId: params.customerId });
  return { ok: true, id };
}

export function addItem(req: Request, comandaId: number, params: AddItemParams): { ok: true; id: number } | { ok: false; error: string } {
  assertAuth(req);
  const comanda = comandaRepository.findOpen(comandaId) as ComandaRow | undefined;
  if (!comanda) return { ok: false, error: 'Comanda nao encontrada.' };
  if (comanda.status !== 'aberta') return { ok: false, error: 'Comanda nao esta aberta.' };
  const product = comandaRepository.rawOne(
    "SELECT id, name, price_cents, deleted_at FROM products WHERE id = ? AND deleted_at IS NULL",
    params.productId,
  ) as { id: number; name: string; price_cents: number; deleted_at: string | null } | undefined;
  if (!product) return { ok: false, error: 'Produto nao encontrado.' };
  const pricing = getService<CommercialPricingService>('commercial.pricing');
  const unitPriceCents = pricing.resolvePrice(product.id, params.qty, comanda.customer_id).unitCents;
  const itemId = comandaItemRepository.create({
    comanda_id: comandaId,
    product_id: product.id,
    product_name: product.name,
    qty: params.qty,
    unit_price_cents: unitPriceCents,
    notes: params.notes ?? null,
    line_group_uuid: params.lineGroupUuid ?? null,
    added_by: req.user.id,
    uuid: randomUUID(),
    origin_machine: req.headers['x-machine'] ?? null,
  });
  audit(req, 'adicionar_item_comanda', 'comanda_item', itemId, null, { comandaId, productId: product.id, qty: params.qty, unitPriceCents });
  if (hasService('foodservice.kitchen')) {
    try {
      const tableLabel = comanda.table_id
        ? (storeTableRepository.findByComandaTableId(comanda.table_id) as { label: string } | undefined)?.label
        : undefined;
      getService<FoodserviceKitchenService>('foodservice.kitchen').notifyOrder(req, {
        sourceType: 'comanda', sourceId: comandaId,
        tableLabel,
        items: [{ productId: product.id, name: product.name, qty: params.qty, notes: params.notes }],
      });
    } catch { /* best-effort */ }
  }
  return { ok: true, id: itemId };
}

export function voidItem(req: Request, comandaId: number, itemId: number): { ok: true } | { ok: false; error: string } {
  const item = comandaItemRepository.findInComanda(itemId, comandaId) as { id: number; voided_at: string | null } | undefined;
  if (!item) return { ok: false, error: 'Item nao encontrado.' };
  if (item.voided_at) return { ok: false, error: 'Item ja foi anulado.' };
  comandaItemRepository.void(itemId);
  audit(req, 'anular_item_comanda', 'comanda_item', itemId);
  return { ok: true };
}

export function transfer(req: Request, comandaId: number, targetTableId: number): { ok: true } | { ok: false; error: string } {
  const comanda = comandaRepository.rawOne(
    "SELECT id, table_id, status FROM comandas WHERE id = ? AND deleted_at IS NULL",
    comandaId,
  ) as { id: number; table_id: number | null; status: string } | undefined;
  if (!comanda) return { ok: false, error: 'Comanda nao encontrada.' };
  if (comanda.status !== 'aberta') return { ok: false, error: 'Comanda nao esta aberta.' };
  const target = storeTableRepository.rawOne(
    "SELECT id, status FROM store_tables WHERE id = ? AND deleted_at IS NULL",
    targetTableId,
  ) as { id: number; status: string } | undefined;
  if (!target) return { ok: false, error: 'Mesa destino nao encontrada.' };
  if (target.status !== 'livre') return { ok: false, error: 'Mesa destino esta ocupada.' };
  comandaRepository.transaction(() => {
    if (comanda.table_id) storeTableRepository.free(comanda.table_id);
    storeTableRepository.occupy(targetTableId);
    comandaRepository.transferTable(comandaId, targetTableId);
  });
  audit(req, 'transferir_comanda', 'comanda', comandaId, { tableIdAntes: comanda.table_id }, { tableIdDepois: targetTableId });
  return { ok: true };
}

export function split(req: Request, comandaId: number, itemIds: number[]): { ok: true; newComandaId: number } | { ok: false; error: string } {
  assertAuth(req);
  if (!itemIds?.length) return { ok: false, error: 'Nenhum item informado para dividir.' };
  const comanda = comandaRepository.findOpen(comandaId) as ComandaRow | undefined;
  if (!comanda || comanda.status !== 'aberta') return { ok: false, error: 'Comanda nao encontrada ou nao esta aberta.' };
  const validCount = comandaItemRepository.validateBelongToComanda(itemIds, comandaId);
  if (validCount !== itemIds.length) return { ok: false, error: 'Um ou mais itens nao encontrados ou ja anulados.' };
  let newComandaId: number;
  comandaRepository.transaction(() => {
    newComandaId = comandaRepository.create({
      table_id: null,
      customer_id: comanda.customer_id,
      opened_by: req.user.id,
      notes: comanda.notes,
      uuid: randomUUID(),
      origin_machine: req.headers['x-machine'] ?? null,
    });
    comandaItemRepository.moveToComanda(itemIds, newComandaId);
    audit(req, 'dividir_comanda', 'comanda', comandaId, null, { origem: comandaId, destino: newComandaId, itens: itemIds });
  });
  return { ok: true, newComandaId: newComandaId! };
}

export function merge(req: Request, targetComandaId: number, sourceComandaId: number): { ok: true } | { ok: false; error: string } {
  if (targetComandaId === sourceComandaId) return { ok: false, error: 'Nao e possivel unir uma comanda com ela mesma.' };
  const target = comandaRepository.findOpen(targetComandaId) as ComandaRow | undefined;
  if (!target || target.status !== 'aberta') return { ok: false, error: 'Comanda destino nao encontrada ou nao esta aberta.' };
  const source = comandaRepository.findOpen(sourceComandaId) as ComandaRow | undefined;
  if (!source || source.status !== 'aberta') return { ok: false, error: 'Comanda origem nao encontrada ou nao esta aberta.' };
  comandaRepository.transaction(() => {
    comandaItemRepository.mergeIntoComanda(sourceComandaId, targetComandaId);
    comandaRepository.cancel(sourceComandaId);
    if (source.table_id) storeTableRepository.free(source.table_id);
    audit(req, 'unir_comandas', 'comanda', sourceComandaId, null, { origem: sourceComandaId, destino: targetComandaId });
  });
  return { ok: true };
}

export function closeComanda(
  req: Request, comandaId: number,
  input: { payments: any[]; discountCents?: number; surchargeCents?: number; customerId?: number },
): { ok: true; saleId: number } | { ok: false; error: string } {
  const comanda = comandaRepository.findOpen(comandaId) as ComandaRow | undefined;
  if (!comanda) return { ok: false, error: 'Comanda nao encontrada.' };
  if (comanda.status !== 'aberta') return { ok: false, error: 'Comanda nao esta aberta.' };
  const items = comandaItemRepository.listActiveByComanda(comandaId) as unknown as ComandaItemRow[];
  if (!items.length) return { ok: false, error: 'Comanda sem itens para fechar.' };
  const saleInput: SaleInput = {
    items: items.map((i) => ({
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
  comandaRepository.close(comandaId, saleResult.id);
  if (comanda.table_id) storeTableRepository.free(comanda.table_id);
  audit(req, 'fechar_comanda', 'comanda', comandaId, null, { saleId: saleResult.id });
  return { ok: true, saleId: saleResult.id };
}

export function cancelComanda(req: Request, comandaId: number): { ok: true } | { ok: false; error: string } {
  const comanda = comandaRepository.findOpen(comandaId) as ComandaRow | undefined;
  if (!comanda) return { ok: false, error: 'Comanda nao encontrada.' };
  if (comanda.status !== 'aberta') return { ok: false, error: 'Comanda nao esta aberta.' };
  comandaRepository.transaction(() => {
    comandaRepository.cancel(comandaId);
    if (comanda.table_id) storeTableRepository.free(comanda.table_id);
  });
  audit(req, 'cancelar_comanda', 'comanda', comandaId);
  return { ok: true };
}
