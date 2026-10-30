import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { audit } from '../../../core/audit/service';
import { getService, hasService } from '../../../core/services/registry';
import type { FoodserviceKitchenService } from '../../foodservice/setup';
import { openComanda, addItem, updateItemNotes, updateItemQty, sendToKitchen, voidItem, transfer, split, merge, closeComanda, cancelComanda, setReadyForPayment } from '../comandas';
import { storeTableRepository } from '../repositories/StoreTableRepository';
import { comandaRepository, comandaItemRepository } from '../repositories/ComandaRepository';
import { notifyTableEvents, subscribeTableEvents } from '../tableEvents';
import { generateTables, listTableHistory } from '../tables';

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
    // A grade não pode ser servida de cache: um 304 logo depois do SSE faria a tela
    // continuar mostrando a mesa livre/ocupada antiga.
    res.setHeader('Cache-Control', 'no-store');
    const tables = storeTableRepository.raw(
      `SELECT t.*, MAX(c.id) AS comanda_id, c.ready_for_payment_at
         FROM store_tables t
         LEFT JOIN comandas c
           ON c.table_id = t.id AND c.status = 'aberta' AND c.deleted_at IS NULL
        WHERE t.deleted_at IS NULL
        GROUP BY t.id
        ORDER BY t.sort_order`,
    ) as Record<string, unknown>[];

    // Tickets 'pronto' da cozinha por comanda aberta: a mesa ganha o selo "Pedido
    // pronto" quando existe algo aguardando o garçom levar. Melhor via serviço do
    // foodservice (regra de cross-module) — sem módulo, campo fica 0.
    const readyByComanda = new Map<number, number>();
    if (hasService('foodservice.kitchen')) {
      const comandaIds = tables
        .map((t) => Number(t.comanda_id))
        .filter((id) => Number.isFinite(id) && id > 0);
      for (const row of getService<FoodserviceKitchenService>('foodservice.kitchen').readyTicketCountByComanda(comandaIds)) {
        readyByComanda.set(row.comandaId, row.readyCount);
      }
    }

    res.json(tables.map((t) => {
      const comandaId = Number(t.comanda_id);
      return { ...t, kitchen_ready_count: Number.isFinite(comandaId) && comandaId > 0 ? (readyByComanda.get(comandaId) ?? 0) : 0 };
    }));
  },

  /**
   * SSE da grade: avisa todas as telas abertas assim que algo muda em mesa/comanda.
   * O `EventSource` reconecta sozinho se a conexão cair; o poll da tela é a reserva.
   */
  tableEvents(_req: Request, res: Response) {
    subscribeTableEvents(res);
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
    notifyTableEvents();
    res.status(201).json({ id });
  },

  /** Geração em lote pela engrenagem: numera em sequência e pula o que já existe. */
  generateTablesAction(req: Request, res: Response) {
    const { base, start, count, pad } = req.body ?? {};
    const result = generateTables(req, { base, start, count, pad });
    notifyTableEvents();
    res.status(201).json(result);
  },

  /**
   * Histórico de ocupação: sessões de comanda (inclusive as já fechadas ou
   * canceladas) com itens vendidos/anulados e a trilha de quem abriu/fechou.
   */
  tableHistory(req: Request, res: Response) {
    const tableId = req.query.tableId != null && req.query.tableId !== ''
      ? Number(req.query.tableId)
      : undefined;
    if (tableId != null && (!Number.isInteger(tableId) || tableId <= 0)) {
      res.status(400).json({ error: 'tableId invalido.' }); return;
    }
    const limit = req.query.limit != null && req.query.limit !== ''
      ? Number(req.query.limit)
      : undefined;
    if (limit != null && (!Number.isInteger(limit) || limit <= 0 || limit > 200)) {
      res.status(400).json({ error: 'limit deve ficar entre 1 e 200.' }); return;
    }
    // Como a grade, o histórico não pode vir de cache: logo depois de fechar uma
    // mesa o log precisa mostrar o fechamento.
    res.setHeader('Cache-Control', 'no-store');
    res.json(listTableHistory({ tableId, limit }));
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
    notifyTableEvents();
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
    notifyTableEvents();
    res.json({ ok: true });
  },

  readyForPaymentAction(req: Request, res: Response) {
    const pronta = req.body?.pronta !== false;
    const result = setReadyForPayment(req, Number(req.params.id), pronta);
    if (!result.ok) { res.status(400).json(result); return; }
    notifyTableEvents();
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
      `SELECT ci.*, p.image_url, p.sku, p.unit, p.product_type
         FROM comanda_items ci
         LEFT JOIN products p ON p.id = ci.product_id
        WHERE ci.comanda_id = ? AND ci.deleted_at IS NULL AND ci.voided_at IS NULL
        ORDER BY ci.id`,
      id,
    ) as Record<string, unknown>[];

    // A tela precisa distinguir três estados por item: não é de cozinha, ainda falta
    // enviar e já foi enviado. O vínculo real mora em kitchen_ticket_items; consultamos
    // pelo serviço do foodservice para o módulo continuar opcional.
    const routedProducts = new Set<number>();
    const kitchenStatusByItem = new Map<number, string>();
    if (hasService('foodservice.kitchen')) {
      try {
        const kitchen = getService<FoodserviceKitchenService>('foodservice.kitchen');
        const productIds = items
          .map((item) => Number(item.product_id))
          .filter((productId) => Number.isInteger(productId) && productId > 0);
        const comandaItemIds = items
          .map((item) => Number(item.id))
          .filter((itemId) => Number.isInteger(itemId) && itemId > 0);
        for (const productId of kitchen.findRoutedProductIds(productIds)) routedProducts.add(productId);
        for (const row of kitchen.findStatusByComandaItemIds(comandaItemIds)) {
          if (!kitchenStatusByItem.has(row.comandaItemId)) kitchenStatusByItem.set(row.comandaItemId, row.status);
        }
      } catch { /* sem a cozinha, a comanda continua abrindo normalmente */ }
    }

    const kitchenItems = items.map((item) => {
      const kitchenStatus = kitchenStatusByItem.get(Number(item.id)) ?? null;
      return {
        ...item,
        // Produto fora do roteamento atual mas já enviado continua sinalizado como cozinha:
        // o ticket é a prova de que a produção existe.
        goes_to_kitchen: routedProducts.has(Number(item.product_id)) || kitchenStatus != null,
        kitchen_sent: kitchenStatus != null,
        kitchen_status: kitchenStatus,
      };
    });
    res.json({ ...comanda, items: kitchenItems });
  },

  openComandaAction(req: Request, res: Response) {
    const { tableId, customerId, notes } = req.body ?? {};
    const result = openComanda(req, { tableId, customerId, notes });
    if (!result.ok) { res.status(400).json(result); return; }
    notifyTableEvents();
    res.status(201).json({ id: result.id });
  },

  addItemAction(req: Request, res: Response) {
    const comandaId = Number(req.params.id);
    const { productId, qty, notes, lineGroupUuid } = req.body ?? {};
    if (!productId || !qty) { res.status(400).json({ error: 'productId e qty obrigatorios.' }); return; }
    const result = addItem(req, comandaId, { productId, qty, notes, lineGroupUuid });
    if (!result.ok) { res.status(400).json(result); return; }
    // Item novo desmarca o "Quer pagar": a grade precisa perder o aviso na hora.
    notifyTableEvents();
    res.status(201).json({ id: result.id });
  },

  voidItemAction(req: Request, res: Response) {
    const comandaId = Number(req.params.id);
    const itemId = Number(req.params.itemId);
    const result = voidItem(req, comandaId, itemId);
    if (!result.ok) { res.status(400).json(result); return; }
    // Pode ter removido o último item que estava pronto na cozinha (selo da mesa).
    notifyTableEvents();
    res.json({ ok: true });
  },

  updateItemNotesAction(req: Request, res: Response) {
    const { notes } = req.body ?? {};
    const result = updateItemNotes(req, Number(req.params.id), Number(req.params.itemId), typeof notes === 'string' ? notes : null);
    if (!result.ok) { res.status(400).json(result); return; }
    res.json({ ok: true });
  },

  updateItemQtyAction(req: Request, res: Response) {
    const { qty } = req.body ?? {};
    const result = updateItemQty(req, Number(req.params.id), Number(req.params.itemId), Number(qty));
    if (!result.ok) { res.status(400).json(result); return; }
    // A alteração de quantidade também desmarca o "Quer pagar".
    notifyTableEvents();
    res.json({ ok: true });
  },

  enviarCozinhaAction(req: Request, res: Response) {
    const result = sendToKitchen(req, Number(req.params.id));
    if (!result.ok) { res.status(400).json(result); return; }
    // Sem a chave 'ok': o envelope de resposta colapsaria {ok,...} num escalar
    // solto; assim chega como data.{sent,estimatedMinutes}, forma estável.
    res.json({ sent: result.sent, estimatedMinutes: result.estimatedMinutes });
  },

  transferAction(req: Request, res: Response) {
    const comandaId = Number(req.params.id);
    const { tableId } = req.body ?? {};
    if (!tableId) { res.status(400).json({ error: 'tableId obrigatorio.' }); return; }
    const result = transfer(req, comandaId, tableId);
    if (!result.ok) { res.status(400).json(result); return; }
    notifyTableEvents();
    res.json({ ok: true });
  },

  splitAction(req: Request, res: Response) {
    const comandaId = Number(req.params.id);
    const { itemIds } = req.body ?? {};
    if (!itemIds?.length) { res.status(400).json({ error: 'itemIds obrigatorio.' }); return; }
    const result = split(req, comandaId, itemIds);
    if (!result.ok) { res.status(400).json(result); return; }
    notifyTableEvents();
    res.json({ newComandaId: result.newComandaId });
  },

  mergeAction(req: Request, res: Response) {
    const comandaId = Number(req.params.id);
    const { sourceComandaId } = req.body ?? {};
    if (!sourceComandaId) { res.status(400).json({ error: 'sourceComandaId obrigatorio.' }); return; }
    const result = merge(req, comandaId, sourceComandaId);
    if (!result.ok) { res.status(400).json(result); return; }
    notifyTableEvents();
    res.json({ ok: true });
  },

  closeComandaAction(req: Request, res: Response) {
    const comandaId = Number(req.params.id);
    const { payments, discountCents, surchargeCents, customerId, customerName, items, clientRequestId } = req.body ?? {};
    if (!payments?.length) { res.status(400).json({ error: 'payments obrigatorio.' }); return; }
    const result = closeComanda(req, comandaId, { payments, discountCents, surchargeCents, customerId, customerName, items, clientRequestId });
    if (!result.ok) { res.status(400).json(result); return; }
    // A mesa volta a ficar livre: avisa a grade antes mesmo de responder.
    notifyTableEvents();
    res.json({ saleId: result.saleId });
  },

  cancelComandaAction(req: Request, res: Response) {
    const comandaId = Number(req.params.id);
    const result = cancelComanda(req, comandaId);
    if (!result.ok) { res.status(400).json(result); return; }
    notifyTableEvents();
    res.json({ ok: true });
  },
};
