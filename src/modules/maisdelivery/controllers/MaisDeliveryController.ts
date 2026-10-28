import type { Request, Response } from 'express';
import type { z } from 'zod';
import type {
  maisDeliveryOrderIdsSchema,
  maisDeliveryOrderStatusSchema,
  maisDeliverySettingsSchema,
} from '../../../shared/schemas';
import { audit } from '../../../core/audit/service';
import {
  changeOrderStatus,
  fetchEstablishment,
  fetchOrder,
  fetchOrders,
  fetchOrdersDetails,
  fetchPaymentMethods,
  fetchStatuses,
  MaisDeliveryError,
} from '../client';
import {
  getMaisDeliveryConfig,
  saveMaisDeliveryConfig,
  type MaisDeliveryConfigInput,
} from '../settings';

function wrap(handler: (req: Request, res: Response) => Promise<void> | void) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof MaisDeliveryError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(502).json({ error: message });
    }
  };
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function localYmd(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseYmd(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  // Rejeita datas que "rolam" (ex.: 2026-02-30 viraria 02/03).
  return localYmd(date) === value ? value : null;
}

/**
 * Janela padrão: últimos 7 dias (incluindo hoje). O limite de 92 dias evita que um
 * filtro acidental traga meses de pedidos e trave a tela — o usuário pode ajustar
 * depois se a operação precisar de um período maior.
 */
function parseRange(req: Request): { from: string; to: string } {
  const today = new Date();
  const defaultStart = new Date(today);
  defaultStart.setDate(defaultStart.getDate() - 6);
  const from = parseYmd(req.query.from) ?? localYmd(defaultStart);
  const to = parseYmd(req.query.to) ?? localYmd(today);
  if (from > to) {
    throw new MaisDeliveryError('A data inicial não pode ser maior que a data final.', 400);
  }
  const days = (Date.parse(`${to}T12:00:00`) - Date.parse(`${from}T12:00:00`)) / 86400000;
  if (days > 92) {
    throw new MaisDeliveryError('O período máximo para listagem é de 92 dias.', 400);
  }
  return { from, to };
}

function parseStatusIds(value: unknown): number[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  const ids = value
    .split(',')
    .map((part) => positiveInt(part.trim()))
    .filter((id): id is number => id !== null);
  return [...new Set(ids)].slice(0, 30);
}

export const maisDeliveryController = {
  getSettings: wrap((_req, res) => {
    res.json(getMaisDeliveryConfig());
  }),

  saveSettings: wrap((req, res) => {
    const body = req.body as z.infer<typeof maisDeliverySettingsSchema>;
    const before = getMaisDeliveryConfig();
    const after = saveMaisDeliveryConfig(body as MaisDeliveryConfigInput);
    // O before/after contém apenas ids e flags "tem segredo?" — nunca o token em si.
    audit(req, 'editar', 'setting', 'maisdelivery', before, after);
    res.json(after);
  }),

  testConnection: wrap(async (_req, res) => {
    const result = await fetchEstablishment();
    res.json({ ok: true, establishment: result.establishment, raw: result.raw });
  }),

  listOrders: wrap(async (req, res) => {
    const range = parseRange(req);
    const statusIds = parseStatusIds(req.query.status);
    const result = await fetchOrders({ ...range, statusIds });
    // Cada item carrega o registro original da API para diagnóstico; na listagem isso
    // multiplicaria o payload sem uso. O detalhe do pedido é que expõe a resposta bruta.
    const orders = result.orders.map(({ raw: _raw, ...order }) => order);
    const payload: Record<string, unknown> = { orders, range };
    // Diagnóstico opt-in: a tela normal não precisa carregar a resposta bruta duas vezes.
    if (req.query.debug === '1') payload.raw = result.raw;
    res.json(payload);
  }),

  getOrder: wrap(async (req, res) => {
    const orderId = positiveInt(req.params.id);
    if (!orderId) {
      res.status(400).json({ error: 'Pedido inválido.' });
      return;
    }
    const result = await fetchOrder(orderId, { fresh: req.query.fresh === '1' });
    res.json({ order: result.order, raw: result.raw });
  }),

  /**
   * A listagem da API traz apenas os IDs. A tela busca os detalhes em lotes pequenos,
   * com concorrência limitada no cliente, para preencher os cartões e o resumo sem
   * disparar dezenas de chamadas simultâneas no marketplace.
   */
  getOrdersDetails: wrap(async (req, res) => {
    const body = req.body as z.infer<typeof maisDeliveryOrderIdsSchema>;
    const result = await fetchOrdersDetails(body.ids, {
      concurrency: 4,
      fresh: req.query.fresh === '1',
    });
    res.json({
      // O detalhe individual é quem expõe `raw`; em lote ele multiplicaria o payload.
      orders: result.orders.map(({ raw: _raw, ...order }) => order),
      failed: result.failed,
    });
  }),

  listStatuses: wrap(async (_req, res) => {
    const result = await fetchStatuses();
    res.json({ statuses: result.statuses });
  }),

  listPaymentMethods: wrap(async (_req, res) => {
    const result = await fetchPaymentMethods();
    res.json({ methods: result.methods });
  }),

  updateStatus: wrap(async (req, res) => {
    const orderId = positiveInt(req.params.id);
    if (!orderId) {
      res.status(400).json({ error: 'Pedido inválido.' });
      return;
    }
    const body = req.body as z.infer<typeof maisDeliveryOrderStatusSchema>;
    await changeOrderStatus(orderId, body.statusId, body.reason ?? '');
    audit(req, 'editar', 'maisdelivery_order', orderId, null, {
      statusId: body.statusId,
      reason: body.reason ?? '',
    });
    res.json({ changed: true });
  }),
};
