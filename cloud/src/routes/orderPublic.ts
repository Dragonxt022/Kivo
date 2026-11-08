import { createHash, randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db';
import { canUseQrOrder } from '../plans';
import { createRateLimiter } from '../rateLimit';
import { connectedCount, emitToCompany } from '../events';

/**
 * Página pública do pedido pela mesa via QR e a API que o celular usa.
 *
 * Sem login: o token da mesa é a credencial. O token chega em claro no link e o banco
 * guarda só o sha256. A página mostra o menu publicado pelo app local; o pedido vira uma
 * intenção em `company_commands` e o desktop executa a regra de negócio.
 */

const orderLimiter = createRateLimiter({ windowMs: 10 * 60e3, max: 20, keyPrefix: 'pedido:' });

interface ResolvedTable {
  companyUuid: string;
  companyName: string | null;
  tableUuid: string;
  tableLabel: string;
  machineId: string | null;
}

type TokenResult =
  | { ok: true; table: ResolvedTable }
  | { ok: false; reason: 'invalido' | 'plano' | 'expirado' | 'desativado' };

function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

async function resolveTable(token: string): Promise<TokenResult> {
  if (!/^[a-f0-9]{64}$/i.test(token)) return { ok: false, reason: 'invalido' };
  const [rows] = await getPool().query(
    `SELECT t.company_uuid, t.table_uuid, t.table_label, t.active, t.machine_id,
            c.name AS company_name, c.plan, c.valid_until,
            COALESCE(p.enabled, 0) AS enabled
       FROM menu_table_tokens t
       JOIN companies c ON c.company_uuid = t.company_uuid
       LEFT JOIN menu_publications p ON p.company_uuid = t.company_uuid
      WHERE t.token_hash = ?
      LIMIT 1`,
    [sha256(token.toLowerCase())],
  );
  const row = (rows as {
    company_uuid: string; table_uuid: string; table_label: string; active: number;
    machine_id: string | null; company_name: string | null; plan: string | null;
    valid_until: string | null; enabled: number;
  }[])[0];
  if (!row || !row.active) return { ok: false, reason: 'invalido' };
  if (!canUseQrOrder(row.plan)) return { ok: false, reason: 'plano' };
  if (row.valid_until) {
    const expira = new Date(String(row.valid_until).replace(' ', 'T'));
    if (Number.isFinite(expira.getTime()) && expira.getTime() < Date.now()) {
      return { ok: false, reason: 'expirado' };
    }
  }
  if (!row.enabled) return { ok: false, reason: 'desativado' };
  return {
    ok: true,
    table: {
      companyUuid: row.company_uuid,
      companyName: row.company_name,
      tableUuid: row.table_uuid,
      tableLabel: row.table_label,
      machineId: row.machine_id,
    },
  };
}

interface ComplementOption {
  productUuid: string;
  name: string;
  priceCents: number;
  sortOrder: number;
}

interface ComplementGroup {
  groupUuid: string | null;
  name: string;
  minSelect: number;
  maxSelect: number | null;
  sortOrder: number;
  options: ComplementOption[];
}

interface PublicItem {
  productUuid: string;
  name: string;
  description: string | null;
  priceCents: number;
  categoryUuid: string | null;
  categoryName: string | null;
  imageId: number | null;
  imageUrl: string | null;
  sortOrder: number;
  complements: ComplementGroup[];
}

interface MenuCategory {
  key: string;
  name: string;
  items: PublicItem[];
}

async function loadMenu(companyUuid: string): Promise<{ items: PublicItem[]; categories: MenuCategory[] }> {
  const [rows] = await getPool().query(
    `SELECT mi.product_uuid, mi.name, mi.description, mi.price_cents, mi.category_uuid,
            mi.category_name, mi.complements_json, mi.sort_order,
            COALESCE(
              (SELECT ci.id FROM catalog_images ci
                WHERE ci.id = mi.catalog_image_id AND ci.status <> 'rejeitada' LIMIT 1),
              (SELECT ci.id FROM catalog_images ci
                WHERE ci.company_uuid = mi.company_uuid AND ci.product_name = mi.name
                  AND ci.status <> 'rejeitada'
                ORDER BY (ci.status = 'aprovada') DESC, ci.id DESC LIMIT 1),
              (SELECT ci.id FROM catalog_images ci
                WHERE ci.status = 'aprovada' AND ci.product_name = mi.name
                ORDER BY ci.pick_count DESC, ci.id DESC LIMIT 1)
            ) AS image_id
       FROM menu_items mi
      WHERE mi.company_uuid = ?
      ORDER BY mi.sort_order, mi.name`,
    [companyUuid],
  );

  const items: PublicItem[] = (rows as {
    product_uuid: string; name: string; description: string | null; price_cents: number;
    category_uuid: string | null; category_name: string | null;
    complements_json: string | object | null; sort_order: number; image_id: number | null;
  }[]).map((r) => {
    let complements: ComplementGroup[] = [];
    try {
      const parsed = typeof r.complements_json === 'string'
        ? JSON.parse(r.complements_json)
        : r.complements_json;
      if (Array.isArray(parsed)) complements = parsed as ComplementGroup[];
    } catch {
      complements = [];
    }
    const imageId = r.image_id != null ? Number(r.image_id) : null;
    return {
      productUuid: String(r.product_uuid),
      name: String(r.name),
      description: r.description != null ? String(r.description) : null,
      priceCents: Number(r.price_cents) || 0,
      categoryUuid: r.category_uuid != null ? String(r.category_uuid) : null,
      categoryName: r.category_name != null ? String(r.category_name) : null,
      imageId,
      imageUrl: imageId ? `/cardapio/${encodeURIComponent(companyUuid)}/imagem/${imageId}` : null,
      sortOrder: Number(r.sort_order) || 0,
      complements,
    };
  });

  const byCategory = new Map<string, MenuCategory>();
  for (const item of items) {
    const key = item.categoryUuid ?? '__none__';
    let cat = byCategory.get(key);
    if (!cat) {
      cat = { key, name: item.categoryName || 'Outros', items: [] };
      byCategory.set(key, cat);
    }
    cat.items.push(item);
  }
  const categories = [...byCategory.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return { items, categories };
}

function str(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

function safeJson(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function messageFor(reason: 'invalido' | 'plano' | 'expirado' | 'desativado'): string {
  switch (reason) {
    case 'plano':
      return 'O pedido pelo celular está disponível no plano Diamante ou durante o teste.';
    case 'expirado':
      return 'O período de teste desta loja terminou. Peça ajuda ao atendente.';
    case 'desativado':
      return 'O pedido pelo celular não está disponível nesta loja agora.';
    default:
      return 'QR inválido ou mesa desativada. Peça um novo QR ao atendente.';
  }
}

// ─── Página pública ───────────────────────────────────────────────────────────

export const orderPage = Router();

orderPage.get('/:token', async (req: Request, res: Response) => {
  const resolved = await resolveTable(String(req.params.token));
  if (!resolved.ok) {
    res.status(404).render('pedido', {
      companyName: null, tableLabel: null, token: null, menu: null, menuJson: null,
      desktopOnline: false, error: messageFor(resolved.reason),
    });
    return;
  }
  const menu = await loadMenu(resolved.table.companyUuid);
  res.render('pedido', {
    companyName: resolved.table.companyName,
    tableLabel: resolved.table.tableLabel,
    token: String(req.params.token),
    menu,
    menuJson: safeJson(menu),
    desktopOnline: connectedCount(resolved.table.companyUuid) > 0,
    error: null,
  });
});

// ─── API do celular ───────────────────────────────────────────────────────────

export const orderApi = Router();

orderApi.get('/:token/menu', async (req, res) => {
  const resolved = await resolveTable(String(req.params.token));
  if (!resolved.ok) {
    res.status(404).json({ error: messageFor(resolved.reason) });
    return;
  }
  res.json(await loadMenu(resolved.table.companyUuid));
});

interface OrderItemInput {
  productUuid?: unknown;
  qty?: unknown;
  notes?: unknown;
  takeaway?: unknown;
  complements?: unknown;
}

orderApi.post('/:token/orders', async (req, res) => {
  const token = String(req.params.token);
  if (orderLimiter(`${token}:${req.ip ?? 'sem-ip'}`)) {
    res.status(429).json({ error: 'Muitos pedidos seguidos. Aguarde alguns minutos ou chame o atendente.' });
    return;
  }
  const resolved = await resolveTable(token);
  if (!resolved.ok) {
    res.status(404).json({ error: messageFor(resolved.reason) });
    return;
  }
  const table = resolved.table;

  const clientRequestId = str(req.body?.clientRequestId, 80);
  const note = req.body?.note != null ? str(req.body.note, 500) || null : null;
  const rawItems = req.body?.items;
  if (!clientRequestId || !Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 40) {
    res.status(400).json({ error: 'Pedido inválido: informe clientRequestId e de 1 a 40 itens.' });
    return;
  }

  const menu = await loadMenu(table.companyUuid);
  const byUuid = new Map(menu.items.map((i) => [i.productUuid, i]));

  const normalizedItems: {
    productUuid: string; name: string; qty: number; notes: string | null;
    takeaway: boolean; unitPriceCents: number;
    complements: { productUuid: string; name: string; qty: number; unitPriceCents: number }[];
  }[] = [];
  let totalCents = 0;

  for (const raw of rawItems as OrderItemInput[]) {
    if (!raw || typeof raw !== 'object') {
      res.status(400).json({ error: 'Item de pedido inválido.' });
      return;
    }
    const productUuid = str(raw.productUuid, 36);
    const item = byUuid.get(productUuid);
    if (!item) {
      res.status(409).json({ error: 'Um item do pedido não está mais no menu. Atualize a página e tente de novo.' });
      return;
    }
    const qty = Math.min(20, Math.max(1, Math.round(Number(raw.qty) || 1)));
    const notes = raw.notes != null ? str(raw.notes, 200) || null : null;
    const takeaway = raw.takeaway === true || raw.takeaway === 1;

    const selectedByGroup = new Map<string, Set<string>>();
    const complements: { productUuid: string; name: string; qty: number; unitPriceCents: number }[] = [];
    const compInputs = Array.isArray(raw.complements) ? raw.complements : [];
    if (compInputs.length > 20) {
      res.status(400).json({ error: 'Complementos demais em um item.' });
      return;
    }
    for (const c of compInputs as { productUuid?: unknown; qty?: unknown }[]) {
      const compUuid = str(c?.productUuid, 36);
      const group = item.complements.find((g) => g.options.some((o) => o.productUuid === compUuid));
      const option = group?.options.find((o) => o.productUuid === compUuid);
      if (!group || !option) {
        res.status(409).json({ error: `O adicional de "${item.name}" não está mais disponível. Atualize a página.` });
        return;
      }
      const compQty = Math.min(10, Math.max(1, Math.round(Number(c?.qty) || 1)));
      const gKey = group.groupUuid ?? group.name;
      if (!selectedByGroup.has(gKey)) selectedByGroup.set(gKey, new Set());
      selectedByGroup.get(gKey)!.add(compUuid);
      complements.push({
        productUuid: compUuid,
        name: option.name,
        qty: compQty,
        unitPriceCents: option.priceCents,
      });
      totalCents += option.priceCents * compQty;
    }
    for (const group of item.complements) {
      const selected = selectedByGroup.get(group.groupUuid ?? group.name)?.size ?? 0;
      if (group.minSelect > 0 && selected < group.minSelect) {
        res.status(400).json({ error: `Escolha ao menos ${group.minSelect} opção(ões) em "${group.name}" (${item.name}).` });
        return;
      }
      if (group.maxSelect != null && selected > group.maxSelect) {
        res.status(400).json({ error: `Escolha no máximo ${group.maxSelect} opção(ões) em "${group.name}" (${item.name}).` });
        return;
      }
    }

    totalCents += item.priceCents * qty;
    normalizedItems.push({
      productUuid: item.productUuid,
      name: item.name,
      qty,
      notes,
      takeaway,
      unitPriceCents: item.priceCents,
      complements,
    });
  }

  const pool = getPool();
  const [existingRows] = await pool.query(
    `SELECT order_uuid, status, total_cents FROM public_orders
      WHERE company_uuid = ? AND client_request_id = ? LIMIT 1`,
    [table.companyUuid, clientRequestId],
  );
  const existing = (existingRows as { order_uuid: string; status: string; total_cents: number }[])[0];
  if (existing) {
    res.status(200).json({
      orderUuid: existing.order_uuid,
      status: existing.status,
      totalCents: Number(existing.total_cents),
      desktopOnline: connectedCount(table.companyUuid) > 0,
    });
    return;
  }

  const orderUuid = randomUUID();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [orderRes] = await conn.query(
      `INSERT INTO public_orders
         (order_uuid, client_request_id, company_uuid, table_uuid, table_label,
          items_json, total_cents, note, status)
       VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, 'recebido')`,
      [
        orderUuid, clientRequestId, table.companyUuid, table.tableUuid, table.tableLabel,
        JSON.stringify(normalizedItems), totalCents, note,
      ],
    );
    const orderId = (orderRes as { insertId: number }).insertId;
    const payload = {
      orderUuid,
      tableUuid: table.tableUuid,
      tableLabel: table.tableLabel,
      note,
      items: normalizedItems,
    };
    const [cmdRes] = await conn.query(
      `INSERT INTO company_commands
         (company_uuid, kind, payload, created_by_user_uuid, source, public_order_id, target_machine_id)
       VALUES (?, 'comandas.qr.order', CAST(? AS JSON), NULL, 'public_qr', ?, ?)`,
      [table.companyUuid, JSON.stringify(payload), orderId, table.machineId],
    );
    const commandId = (cmdRes as { insertId: number }).insertId;
    await conn.query('UPDATE public_orders SET command_id = ? WHERE id = ?', [commandId, orderId]);
    await conn.commit();
    emitToCompany(table.companyUuid, 'command', { id: commandId, kind: 'comandas.qr.order' });
    res.status(201).json({
      orderUuid,
      status: 'recebido',
      totalCents,
      desktopOnline: connectedCount(table.companyUuid) > 0,
    });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});

orderApi.get('/:token/orders/:orderUuid', async (req, res) => {
  const resolved = await resolveTable(String(req.params.token));
  if (!resolved.ok) {
    res.status(404).json({ error: messageFor(resolved.reason) });
    return;
  }
  const table = resolved.table;
  const [rows] = await getPool().query(
    `SELECT o.status, o.rejection_reason, o.total_cents, o.created_at,
            c.status AS command_status, c.result AS command_result
       FROM public_orders o
       LEFT JOIN company_commands c ON c.id = o.command_id
      WHERE o.order_uuid = ? AND o.company_uuid = ? AND o.table_uuid = ?
      LIMIT 1`,
    [str(req.params.orderUuid, 36), table.companyUuid, table.tableUuid],
  );
  const row = (rows as {
    status: string; rejection_reason: string | null; total_cents: number; created_at: string;
    command_status: string | null; command_result: string | object | null;
  }[])[0];
  if (!row) {
    res.status(404).json({ error: 'Pedido não encontrado.' });
    return;
  }
  let status = row.status;
  let reason = row.rejection_reason;
  if (row.command_status === 'erro') {
    status = 'erro';
    const result = typeof row.command_result === 'string'
      ? (() => { try { return JSON.parse(row.command_result!); } catch { return {}; } })()
      : (row.command_result ?? {});
    if (!reason && (result as { error?: string }).error) reason = String((result as { error?: string }).error);
  } else if (status === 'recebido' && row.command_status === 'aplicado') {
    status = 'aplicado';
  }
  res.json({ status, reason, totalCents: Number(row.total_cents), createdAt: row.created_at });
});
