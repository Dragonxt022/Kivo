import { Router } from 'express';
import { getPool } from '../db';
import { requireCompanyAuth, requireCloudSavePlan, type AuthedRequest } from '../auth';

const router = Router();

interface IncomingBatchItem {
  entityType: string;
  uuid: string;
  payload: Record<string, unknown>;
  updatedAt: string;
  deletedAt: string | null;
  originMachine: string;
}

interface SyncRecordRow {
  id: number;
  entity_type: string;
  uuid: string;
  payload: string | Record<string, unknown>;
  updated_at: string;
  deleted_at: string | null;
  origin_machine: string;
  server_received_at: string;
}

function encodeCursor(serverReceivedAt: string, id: number): string {
  return Buffer.from(JSON.stringify({ serverReceivedAt, id })).toString('base64url');
}

function decodeCursor(cursor: string): { serverReceivedAt: string; id: number } {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
}

/**
 * Projeta produtos sincronizados na tabela pública `menu_items` (Fase 6 — cardápio
 * online) quando o lojista marcou `visivel_cardapio` no app local. Só o subconjunto
 * seguro (nome/descrição/preço/categoria) é copiado aqui — nunca custo/estoque, que
 * ficam só em `sync_records` (autenticado). Best-effort: uma falha aqui nunca derruba
 * o push do lote principal, mesmo padrão de `foodservice.kitchen.notifyOrder` no app local.
 */
async function projectMenuItem(
  conn: import('mysql2/promise').PoolConnection,
  companyUuid: string,
  item: IncomingBatchItem,
): Promise<void> {
  if (item.entityType !== 'commercial.products') return;
  try {
    const p = item.payload;
    const visible = !item.deletedAt && Number(p.active) === 1 && Number(p.visivel_cardapio) === 1;
    if (visible) {
      await conn.query(
        `INSERT INTO menu_items (company_uuid, product_uuid, name, description, price_cents, category_uuid)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description),
           price_cents = VALUES(price_cents), category_uuid = VALUES(category_uuid)`,
        [companyUuid, item.uuid, String(p.name ?? ''), (p.description as string | null) ?? null, Number(p.price_cents ?? 0), (p.category_id as string | null) ?? null],
      );
    } else {
      await conn.query('DELETE FROM menu_items WHERE company_uuid = ? AND product_uuid = ?', [companyUuid, item.uuid]);
    }
  } catch {
    // best-effort: o cardápio online é um extra opcional, o push do lote principal não pode falhar por causa dele.
  }
}

router.post('/push', requireCompanyAuth, requireCloudSavePlan, async (req: AuthedRequest, res) => {
  const body = req.body as { machineId?: string; batch?: IncomingBatchItem[] };
  if (!Array.isArray(body.batch)) {
    res.status(400).json({ error: 'batch deve ser um array.' });
    return;
  }
  const pool = getPool();
  const rejected: { uuid: string; reason: string }[] = [];
  let accepted = 0;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const item of body.batch) {
      try {
        await conn.query(
          `INSERT INTO sync_records (company_uuid, entity_type, uuid, payload, updated_at, deleted_at, origin_machine)
           VALUES (?, ?, ?, CAST(? AS JSON), ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             payload = IF(VALUES(updated_at) > updated_at, VALUES(payload), payload),
             updated_at = IF(VALUES(updated_at) > updated_at, VALUES(updated_at), updated_at),
             deleted_at = IF(VALUES(updated_at) > updated_at, VALUES(deleted_at), deleted_at),
             origin_machine = IF(VALUES(updated_at) > updated_at, VALUES(origin_machine), origin_machine)`,
          [
            req.companyUuid,
            item.entityType,
            item.uuid,
            JSON.stringify(item.payload),
            item.updatedAt,
            item.deletedAt,
            item.originMachine,
          ],
        );
        await projectMenuItem(conn, req.companyUuid!, item);
        accepted++;
      } catch (e) {
        rejected.push({ uuid: item.uuid, reason: (e as Error).message });
      }
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  res.json({ accepted, rejected });
});

router.get('/pull', requireCompanyAuth, requireCloudSavePlan, async (req: AuthedRequest, res) => {
  const limit = Math.min(Number(req.query.limit ?? 500) || 500, 1000);
  const cursor = req.query.cursor ? decodeCursor(String(req.query.cursor)) : null;

  const params: unknown[] = [req.companyUuid];
  let where = 'company_uuid = ?';
  if (cursor) {
    where += ' AND (server_received_at > ? OR (server_received_at = ? AND id > ?))';
    params.push(cursor.serverReceivedAt, cursor.serverReceivedAt, cursor.id);
  }

  const [rows] = await getPool().query(
    `SELECT id, entity_type, uuid, payload,
            DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at,
            CASE WHEN deleted_at IS NULL THEN NULL ELSE DATE_FORMAT(deleted_at, '%Y-%m-%d %H:%i:%s') END AS deleted_at,
            origin_machine, server_received_at
     FROM sync_records WHERE ${where} ORDER BY server_received_at, id LIMIT ?`,
    [...params, limit],
  );
  const list = rows as SyncRecordRow[];
  const records = list.map((r) => ({
    entityType: r.entity_type,
    uuid: r.uuid,
    payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    originMachine: r.origin_machine,
  }));
  const nextCursor =
    list.length === limit ? encodeCursor(list[list.length - 1].server_received_at, list[list.length - 1].id) : null;
  res.json({ records, nextCursor });
});

export default router;
