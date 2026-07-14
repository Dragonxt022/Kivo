import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { audit } from '../../../core/audit/service';
import { openComanda, addItem, voidItem, transfer, split, merge, closeComanda, cancelComanda } from '../comandas';
import { storeTableRepository } from '../repositories/StoreTableRepository';
import { comandaRepository, comandaItemRepository } from '../repositories/ComandaRepository';

export const comandasController = {
  listTables(_req: Request, res: Response) {
    res.json(storeTableRepository.findAll({ orderBy: 'sort_order' }));
  },

  listTableStatus(_req: Request, res: Response) {
    res.json(storeTableRepository.findAll({ orderBy: 'sort_order' }));
  },

  createTable(req: Request, res: Response) {
    const { label, sortOrder } = req.body ?? {};
    if (!label) { res.status(400).json({ error: 'label obrigatorio.' }); return; }
    const id = storeTableRepository.create({
      label: String(label).trim(),
      sort_order: sortOrder ?? 0,
      uuid: randomUUID(),
      origin_machine: req.headers['x-machine'] ?? null,
    });
    audit(req, 'criar_mesa', 'table', id);
    res.status(201).json({ id });
  },

  updateTable(req: Request, res: Response) {
    const id = Number(req.params.id);
    const existing = storeTableRepository.rawOne('SELECT id FROM store_tables WHERE id = ? AND deleted_at IS NULL', id);
    if (!existing) { res.status(404).json({ error: 'Mesa nao encontrada.' }); return; }
    const { label, sortOrder } = req.body ?? {};
    const data: Record<string, unknown> = {};
    if (label !== undefined) data.label = label;
    if (sortOrder !== undefined) data.sort_order = sortOrder;
    if (Object.keys(data).length) storeTableRepository.update(id, data);
    audit(req, 'editar_mesa', 'table', id);
    res.json({ ok: true });
  },

  deleteTable(req: Request, res: Response) {
    const id = Number(req.params.id);
    const existing = storeTableRepository.rawOne(
      "SELECT id, status FROM store_tables WHERE id = ? AND deleted_at IS NULL", id,
    ) as { id: number; status: string } | undefined;
    if (!existing) { res.status(404).json({ error: 'Mesa nao encontrada.' }); return; }
    if (existing.status !== 'livre') { res.status(400).json({ error: 'Mesa ocupada nao pode ser removida.' }); return; }
    storeTableRepository.softDelete(id);
    audit(req, 'remover_mesa', 'table', id);
    res.json({ ok: true });
  },

  listComandas(req: Request, res: Response) {
    const status = req.query.status ? String(req.query.status) : undefined;
    let sql = `SELECT c.*, t.label AS table_label
      FROM comandas c
      LEFT JOIN store_tables t ON t.id = c.table_id
      WHERE c.deleted_at IS NULL`;
    const params: unknown[] = [];
    if (status) { sql += ' AND c.status = ?'; params.push(status); }
    sql += ' ORDER BY c.id DESC';
    res.json(comandaRepository.raw(sql, ...params));
  },

  getComanda(req: Request, res: Response) {
    const id = Number(req.params.id);
    const comanda = comandaRepository.rawOne(
      `SELECT c.*, t.label AS table_label
       FROM comandas c
       LEFT JOIN store_tables t ON t.id = c.table_id
       WHERE c.id = ? AND c.deleted_at IS NULL`,
      id,
    );
    if (!comanda) { res.status(404).json({ error: 'Comanda nao encontrada.' }); return; }
    const items = comandaItemRepository.raw(
      "SELECT * FROM comanda_items WHERE comanda_id = ? AND deleted_at IS NULL AND voided_at IS NULL ORDER BY id",
      id,
    );
    res.json({ ...comanda, items });
  },

  openComandaAction(req: Request, res: Response) {
    const { tableId, customerId, notes } = req.body ?? {};
    const result = openComanda(req, { tableId, customerId, notes });
    if (!result.ok) { res.status(400).json(result); return; }
    res.status(201).json({ id: result.id });
  },

  addItemAction(req: Request, res: Response) {
    const comandaId = Number(req.params.id);
    const { productId, qty, notes, lineGroupUuid } = req.body ?? {};
    if (!productId || !qty) { res.status(400).json({ error: 'productId e qty obrigatorios.' }); return; }
    const result = addItem(req, comandaId, { productId, qty, notes, lineGroupUuid });
    if (!result.ok) { res.status(400).json(result); return; }
    res.status(201).json({ id: result.id });
  },

  voidItemAction(req: Request, res: Response) {
    const comandaId = Number(req.params.id);
    const itemId = Number(req.params.itemId);
    const result = voidItem(req, comandaId, itemId);
    if (!result.ok) { res.status(400).json(result); return; }
    res.json({ ok: true });
  },

  transferAction(req: Request, res: Response) {
    const comandaId = Number(req.params.id);
    const { tableId } = req.body ?? {};
    if (!tableId) { res.status(400).json({ error: 'tableId obrigatorio.' }); return; }
    const result = transfer(req, comandaId, tableId);
    if (!result.ok) { res.status(400).json(result); return; }
    res.json({ ok: true });
  },

  splitAction(req: Request, res: Response) {
    const comandaId = Number(req.params.id);
    const { itemIds } = req.body ?? {};
    if (!itemIds?.length) { res.status(400).json({ error: 'itemIds obrigatorio.' }); return; }
    const result = split(req, comandaId, itemIds);
    if (!result.ok) { res.status(400).json(result); return; }
    res.json({ newComandaId: result.newComandaId });
  },

  mergeAction(req: Request, res: Response) {
    const comandaId = Number(req.params.id);
    const { sourceComandaId } = req.body ?? {};
    if (!sourceComandaId) { res.status(400).json({ error: 'sourceComandaId obrigatorio.' }); return; }
    const result = merge(req, comandaId, sourceComandaId);
    if (!result.ok) { res.status(400).json(result); return; }
    res.json({ ok: true });
  },

  closeComandaAction(req: Request, res: Response) {
    const comandaId = Number(req.params.id);
    const { payments, discountCents, surchargeCents, customerId } = req.body ?? {};
    if (!payments?.length) { res.status(400).json({ error: 'payments obrigatorio.' }); return; }
    const result = closeComanda(req, comandaId, { payments, discountCents, surchargeCents, customerId });
    if (!result.ok) { res.status(400).json(result); return; }
    res.json({ saleId: result.saleId });
  },

  cancelComandaAction(req: Request, res: Response) {
    const comandaId = Number(req.params.id);
    const result = cancelComanda(req, comandaId);
    if (!result.ok) { res.status(400).json(result); return; }
    res.json({ ok: true });
  },
};
