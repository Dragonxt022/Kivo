import { Router } from 'express';
import { getPool } from '../db';
import { requireCompanyAuth, type AuthedRequest } from '../auth';
import { canUseQrOrder } from '../plans';

/**
 * Publicação do menu público do QR e tokens das mesas.
 *
 * O app local é a fonte da verdade (produto, preço, complemento, imagem). Ele envia um
 * snapshot compacto para cá; o Cloud nunca lê o banco do lojista. A rota é liberada para
 * Diamante e Trial — o trial não tem sync geral, mas precisa deste recurso.
 */

export const router = Router();

const MAX_ITEMS = 2000;
const MAX_COMPLEMENT_GROUPS = 20;
const MAX_COMPLEMENT_OPTIONS = 100;

function str(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

function int(v: unknown, min: number, max: number, fallback = 0): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

interface PublishItem {
  productUuid?: unknown;
  name?: unknown;
  description?: unknown;
  priceCents?: unknown;
  categoryUuid?: unknown;
  categoryName?: unknown;
  imageId?: unknown;
  sortOrder?: unknown;
  complements?: unknown;
}

interface PublishComplementGroup {
  groupUuid?: unknown;
  name?: unknown;
  minSelect?: unknown;
  maxSelect?: unknown;
  sortOrder?: unknown;
  options?: unknown;
}

router.use(requireCompanyAuth);

/** Trial e Diamante têm o pedido por QR; os outros planos recebem uma recusa clara. */
router.use((req: AuthedRequest, res, next) => {
  if (!canUseQrOrder(req.companyPlan)) {
    res.status(403).json({
      error: 'Pedido pela mesa via QR está disponível no plano Diamante ou durante o teste.',
      code: 'qr_order_plan',
    });
    return;
  }
  next();
});

function normalizeComplements(raw: unknown): { groups: unknown[]; ok: boolean } {
  if (!Array.isArray(raw)) return { groups: [], ok: true };
  if (raw.length > MAX_COMPLEMENT_GROUPS) return { groups: [], ok: false };
  const groups = [];
  for (const g of raw as PublishComplementGroup[]) {
    if (!g || typeof g !== 'object') return { groups: [], ok: false };
    const optionsRaw = Array.isArray(g.options) ? g.options : [];
    if (optionsRaw.length > MAX_COMPLEMENT_OPTIONS) return { groups: [], ok: false };
    const options = [];
    for (const o of optionsRaw as Record<string, unknown>[]) {
      const productUuid = str(o.productUuid, 36);
      const name = str(o.name, 255);
      if (!productUuid || !name) return { groups: [], ok: false };
      options.push({
        productUuid,
        name,
        priceCents: int(o.priceCents, 0, 100_000_000),
        sortOrder: int(o.sortOrder, 0, 100_000),
      });
    }
    groups.push({
      groupUuid: str(g.groupUuid, 36) || null,
      name: str(g.name, 120) || 'Adicionais',
      minSelect: int(g.minSelect, 0, 20),
      maxSelect: g.maxSelect == null ? null : int(g.maxSelect, 0, 20),
      sortOrder: int(g.sortOrder, 0, 100_000),
      options,
    });
  }
  return { groups, ok: true };
}

router.post('/publish', async (req: AuthedRequest, res) => {
  const body = (req.body ?? {}) as { enabled?: unknown; hash?: unknown; items?: unknown };
  if (!Array.isArray(body.items) || body.items.length > MAX_ITEMS) {
    res.status(400).json({ error: `items deve ser uma lista de até ${MAX_ITEMS}.` });
    return;
  }
  const enabled = body.enabled === true || body.enabled === 1;
  const hash = str(body.hash, 64) || null;

  const rows: {
    productUuid: string; name: string; description: string | null; priceCents: number;
    categoryUuid: string | null; categoryName: string | null; imageId: number | null;
    sortOrder: number; complementsJson: string;
  }[] = [];

  for (const raw of body.items as PublishItem[]) {
    if (!raw || typeof raw !== 'object') {
      res.status(400).json({ error: 'Item de menu inválido.' });
      return;
    }
    const productUuid = str(raw.productUuid, 36);
    const name = str(raw.name, 255);
    if (!productUuid || !name) {
      res.status(400).json({ error: 'Cada item precisa de productUuid e name.' });
      return;
    }
    const comp = normalizeComplements(raw.complements);
    if (!comp.ok) {
      res.status(400).json({ error: `Complementos inválidos em "${name}".` });
      return;
    }
    const imageId = Number(raw.imageId);
    rows.push({
      productUuid,
      name,
      description: raw.description == null ? null : str(raw.description, 2000),
      priceCents: int(raw.priceCents, 0, 100_000_000),
      categoryUuid: str(raw.categoryUuid, 36) || null,
      categoryName: str(raw.categoryName, 120) || null,
      imageId: Number.isInteger(imageId) && imageId > 0 ? imageId : null,
      sortOrder: int(raw.sortOrder, 0, 1_000_000),
      complementsJson: JSON.stringify(comp.groups),
    });
  }

  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO menu_publications (company_uuid, enabled, payload_hash, published_at)
       VALUES (?, ?, ?, NOW(3))
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), payload_hash = VALUES(payload_hash),
         published_at = NOW(3)`,
      [req.companyUuid, enabled ? 1 : 0, hash],
    );

    // A publicação é um snapshot completo: substitui o menu da empresa para refletir
    // remoções/renomeações/despublicações. Mesmo desligado, mantém os itens para a
    // reativação ser instantânea — a página pública confere `enabled` antes de abrir.
    if (enabled) {
      await conn.query('DELETE FROM menu_items WHERE company_uuid = ?', [req.companyUuid]);
      if (rows.length) {
        const values: unknown[] = [];
        const placeholders = rows.map((r) => {
          values.push(
            req.companyUuid, r.productUuid, r.name, r.description, r.priceCents,
            r.complementsJson, r.sortOrder, r.categoryUuid, r.categoryName, r.imageId,
          );
          return '(?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?)';
        });
        await conn.query(
          `INSERT INTO menu_items
             (company_uuid, product_uuid, name, description, price_cents, complements_json,
              sort_order, category_uuid, category_name, catalog_image_id)
           VALUES ${placeholders.join(', ')}`,
          values,
        );
      }
    }

    await conn.commit();
    res.json({ ok: true, enabled, items: rows.length });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});

/** Registra/rotaciona o token do QR de uma mesa. O Cloud guarda só o sha256. */
router.post('/table-tokens', async (req: AuthedRequest, res) => {
  const body = (req.body ?? {}) as { tableUuid?: unknown; label?: unknown; tokenHash?: unknown; machineId?: unknown };
  const tableUuid = str(body.tableUuid, 36);
  const label = str(body.label, 120) || 'Mesa';
  const tokenHash = str(body.tokenHash, 64).toLowerCase();
  const machineId = str(body.machineId, 64) || null;
  if (!tableUuid || !/^[a-f0-9]{64}$/.test(tokenHash)) {
    res.status(400).json({ error: 'tableUuid e tokenHash (sha256) são obrigatórios.' });
    return;
  }
  try {
    await getPool().query(
      `INSERT INTO menu_table_tokens
         (company_uuid, table_uuid, table_label, token_hash, machine_id, active, rotated_at)
       VALUES (?, ?, ?, ?, ?, 1, NOW(3))
       ON DUPLICATE KEY UPDATE table_label = VALUES(table_label), token_hash = VALUES(token_hash),
         machine_id = VALUES(machine_id), active = 1, rotated_at = NOW(3)`,
      [req.companyUuid, tableUuid, label, tokenHash, machineId],
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: 'Token já usado por outra mesa. Gere novamente.' });
      return;
    }
    throw e;
  }
});

router.delete('/table-tokens/:tableUuid', async (req: AuthedRequest, res) => {
  await getPool().query(
    'UPDATE menu_table_tokens SET active = 0, rotated_at = NOW(3) WHERE company_uuid = ? AND table_uuid = ?',
    [req.companyUuid, str(req.params.tableUuid, 36)],
  );
  res.json({ ok: true });
});

/**
 * Desfecho do garçom para o celular do cliente: confirmado (foi para a cozinha) ou
 * recusado (com motivo). Chamado pelo desktop depois da confirmação na tela de Mesas.
 */
router.post('/orders/:orderUuid/status', async (req: AuthedRequest, res) => {
  const orderUuid = str(req.params.orderUuid, 36);
  const status = String(req.body?.status ?? '');
  const reason = req.body?.reason != null ? str(req.body.reason, 255) : null;
  if (!orderUuid || (status !== 'confirmado' && status !== 'recusado')) {
    res.status(400).json({ error: "status deve ser 'confirmado' ou 'recusado'." });
    return;
  }
  const [r] = await getPool().query(
    `UPDATE public_orders
        SET status = ?, rejection_reason = ?, updated_at = NOW(3)
      WHERE order_uuid = ? AND company_uuid = ?`,
    [status, status === 'recusado' ? reason : null, orderUuid, req.companyUuid],
  );
  const affected = (r as { affectedRows?: number }).affectedRows ?? 0;
  if (!affected) {
    res.status(404).json({ error: 'Pedido não encontrado.' });
    return;
  }
  res.json({ ok: true });
});
