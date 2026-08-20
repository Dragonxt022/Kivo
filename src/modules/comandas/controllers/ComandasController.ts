import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { audit } from '../../../core/audit/service';
import { openComanda, addItem, voidItem, transfer, split, merge, closeComanda, cancelComanda, setReadyForPayment } from '../comandas';
import { storeTableRepository } from '../repositories/StoreTableRepository';
import { comandaRepository, comandaItemRepository } from '../repositories/ComandaRepository';

export const comandasController = {
  listTables(_req: Request, res: Response) {
    res.json(storeTableRepository.findAll({ orderBy: 'sort_order' }));
  },

  /**
   * Grade de mesas: além do status, leva a comanda aberta de cada uma e o aviso
   * "quer pagar" que o garçom manda do celular — é assim que o caixa descobre qual
   * mesa chamou sem precisar passar de mesa em mesa.
   *
   * O GROUP BY é rede de proteção: `openComanda` só abre comanda em mesa livre, então
   * o normal é no máximo uma por mesa. Se por algum motivo houver duas, sem ele a
   * mesa apareceria duplicada na grade. Com MAX(c.id), o SQLite traz as demais colunas
   * de `c` da própria linha do máximo — a comanda mais recente.
   */
  listTableStatus(_req: Request, res: Response) {
    res.json(storeTableRepository.raw(
      `SELECT t.*, MAX(c.id) AS comanda_id, c.ready_for_payment_at
         FROM store_tables t
         LEFT JOIN comandas c
           ON c.table_id = t.id AND c.status = 'aberta' AND c.deleted_at IS NULL
        WHERE t.deleted_at IS NULL
        GROUP BY t.id
        ORDER BY t.sort_order`,
    ));
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

  readyForPaymentAction(req: Request, res: Response) {
    const pronta = req.body?.pronta !== false;
    const result = setReadyForPayment(req, Number(req.params.id), pronta);
    if (!result.ok) { res.status(400).json(result); return; }
    res.json({ ok: true, pronta });
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
    // A foto e o SKU vêm do produto (o item só congela nome e preço): é o PDV que
    // precisa deles ao reabrir a comanda para fechar a conta — sem o JOIN, o carrinho
    // aparecia com o quadradinho cinza de "sem imagem" mesmo em produto fotografado.
    // LEFT JOIN porque o produto pode ter sido excluído depois do lançamento.
    const items = comandaItemRepository.raw(
      `SELECT ci.*, p.image_url, p.sku
         FROM comanda_items ci
         LEFT JOIN products p ON p.id = ci.product_id
        WHERE ci.comanda_id = ? AND ci.deleted_at IS NULL AND ci.voided_at IS NULL
        ORDER BY ci.id`,
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
    const { payments, discountCents, surchargeCents, customerId, customerName, items, clientRequestId } = req.body ?? {};
    if (!payments?.length) { res.status(400).json({ error: 'payments obrigatorio.' }); return; }
    const result = closeComanda(req, comandaId, { payments, discountCents, surchargeCents, customerId, customerName, items, clientRequestId });
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
