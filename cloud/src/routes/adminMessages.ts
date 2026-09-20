import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { getPool } from '../db';
import { requireAdminAuth, type AdminRequest } from '../adminAuth';
import { emitToAll, emitToCompany } from '../events';
import { MESSAGES_STORAGE_DIR } from './messages';

/**
 * Painel do suporte para escrever mensagens às empresas (central de mensagens).
 *
 * Montado em /admin/messages. O corpo do editor vai em JSON (não multipart): a imagem de
 * destaque viaja como data URL base64, mesmo padrão da capa dos temas — sem biblioteca de
 * upload nem de zip. O desktop busca depois pelo endpoint público /api/messages/inbox.
 */

const router = Router();

const CATEGORIES = ['comunicado', 'atualizacao', 'tutorial', 'dica', 'novidade', 'sistema'] as const;

const EXT_POR_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function textOrNull(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, 300) : null;
}

/** Grava a imagem (data URL) e devolve o nome do arquivo + mime. `null` quando inválida. */
function saveImage(dataUrl: unknown): { file: string; mime: string } | null {
  const m = String(dataUrl ?? '').match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > 3 * 1024 * 1024) return null;
  const file = `${randomUUID()}.${EXT_POR_MIME[m[1]] ?? 'jpg'}`;
  fs.mkdirSync(MESSAGES_STORAGE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MESSAGES_STORAGE_DIR, file), buf);
  return { file, mime: m[1] };
}

function deleteImageFile(file: string | null): void {
  if (!file) return;
  try {
    fs.unlinkSync(path.join(MESSAGES_STORAGE_DIR, path.basename(file)));
  } catch {
    // já não existe — nada a fazer
  }
}

function normalizarTargets(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))];
}

router.get('/', requireAdminAuth, async (req, res) => {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT id, uuid, title, subtitle, category, is_urgent, target_all, status, published_at, created_at
       FROM messages ORDER BY created_at DESC`,
  );
  const [targetRows] = await pool.query(
    `SELECT t.message_id, t.company_uuid, c.name AS company_name
       FROM message_targets t LEFT JOIN companies c ON c.company_uuid = t.company_uuid`,
  );
  const targets = new Map<number, { company_uuid: string; company_name: string | null }[]>();
  for (const t of targetRows as { message_id: number; company_uuid: string; company_name: string | null }[]) {
    const list = targets.get(Number(t.message_id)) ?? [];
    list.push({ company_uuid: t.company_uuid, company_name: t.company_name });
    targets.set(Number(t.message_id), list);
  }
  res.render('messages', {
    messages: rows,
    targets,
    active: 'messages',
    error: typeof req.query.error === 'string' ? req.query.error : null,
    ok: typeof req.query.ok === 'string' ? req.query.ok : null,
  });
});

router.get('/new', requireAdminAuth, async (_req, res) => {
  const [companyRows] = await getPool().query('SELECT company_uuid, name FROM companies ORDER BY name');
  res.render('messages-form', {
    msg: null,
    companies: companyRows,
    categories: CATEGORIES,
    active: 'messages',
  });
});

router.get('/:uuid/edit', requireAdminAuth, async (req, res) => {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT id, uuid, title, subtitle, category, body_html, is_urgent, target_all, status,
            (image_path IS NOT NULL) AS has_image
       FROM messages WHERE uuid = ?`,
    [req.params.uuid],
  );
  const msg = (rows as Record<string, unknown>[])[0];
  if (!msg) {
    res.redirect('/admin/messages?error=Mensagem%20não%20encontrada');
    return;
  }
  const [targetRows] = await pool.query('SELECT company_uuid FROM message_targets WHERE message_id = ?', [msg.id]);
  const [companyRows] = await pool.query('SELECT company_uuid, name FROM companies ORDER BY name');
  res.render('messages-form', {
    msg: { ...msg, targets: (targetRows as { company_uuid: string }[]).map((t) => t.company_uuid) },
    companies: companyRows,
    categories: CATEGORIES,
    active: 'messages',
  });
});

/** Cria ou atualiza. `uuid` ausente = nova mensagem. */
router.post('/save', requireAdminAuth, async (req: AdminRequest, res) => {
  const body = (req.body ?? {}) as {
    uuid?: unknown;
    title?: unknown;
    subtitle?: unknown;
    category?: unknown;
    bodyHtml?: unknown;
    urgent?: unknown;
    targetAll?: unknown;
    targets?: unknown;
    imageBase64?: unknown;
    removeImage?: unknown;
  };
  const title = String(body.title ?? '').trim();
  if (title.length < 2) {
    res.status(400).json({ error: 'Informe o título da mensagem.' });
    return;
  }
  const category = (CATEGORIES as readonly string[]).includes(String(body.category))
    ? String(body.category)
    : 'comunicado';
  const bodyHtml = String(body.bodyHtml ?? '').slice(0, 200_000);
  const targetAll = body.targetAll === true || body.targetAll === '1' || body.targetAll === 'true';
  const targets = targetAll ? [] : normalizarTargets(body.targets);
  if (!targetAll && !targets.length) {
    res.status(400).json({ error: 'Escolha ao menos uma empresa ou marque "todas".' });
    return;
  }
  const urgent = body.urgent === true || body.urgent === '1' || body.urgent === 'true';

  const pool = getPool();
  const uuid = String(body.uuid ?? '').trim();
  let messageId: number;
  let previousImage: string | null = null;

  if (uuid) {
    const [rows] = await pool.query('SELECT id, image_path FROM messages WHERE uuid = ?', [uuid]);
    const atual = (rows as { id: number; image_path: string | null }[])[0];
    if (!atual) {
      res.status(404).json({ error: 'Mensagem não encontrada.' });
      return;
    }
    messageId = Number(atual.id);
    previousImage = atual.image_path;
    const nova = saveImage(body.imageBase64);
    const remover = body.removeImage === true || body.removeImage === 'true';
    const sets = [
      'title = ?',
      'subtitle = ?',
      'category = ?',
      'body_html = ?',
      'is_urgent = ?',
      'target_all = ?',
    ];
    const params: unknown[] = [title, textOrNull(body.subtitle), category, bodyHtml, urgent ? 1 : 0, targetAll ? 1 : 0];
    if (nova) {
      sets.push('image_path = ?', 'image_mime = ?');
      params.push(nova.file, nova.mime);
    } else if (remover) {
      sets.push('image_path = NULL', 'image_mime = NULL');
    }
    params.push(messageId);
    await pool.query(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`, params);
    if ((nova || remover) && previousImage && previousImage !== nova?.file) deleteImageFile(previousImage);
  } else {
    const nova = saveImage(body.imageBase64);
    const [result] = await pool.query(
      `INSERT INTO messages (uuid, title, subtitle, category, body_html, image_path, image_mime, is_urgent, target_all, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'rascunho', ?)`,
      [
        randomUUID(),
        title,
        textOrNull(body.subtitle),
        category,
        bodyHtml,
        nova?.file ?? null,
        nova?.mime ?? null,
        urgent ? 1 : 0,
        targetAll ? 1 : 0,
        req.adminUsername ?? null,
      ],
    );
    messageId = Number((result as { insertId: number }).insertId);
  }

  await pool.query('DELETE FROM message_targets WHERE message_id = ?', [messageId]);
  for (const company of targets) {
    await pool.query('INSERT IGNORE INTO message_targets (message_id, company_uuid) VALUES (?, ?)', [messageId, company]);
  }

  res.json({ ok: true, messageId });
});

router.post('/:uuid/publish', requireAdminAuth, async (req, res) => {
  const pool = getPool();
  const [rows] = await pool.query('SELECT id, target_all FROM messages WHERE uuid = ?', [req.params.uuid]);
  const msg = (rows as { id: number; target_all: number }[])[0];
  if (!msg) {
    res.redirect('/admin/messages?error=Mensagem%20não%20encontrada');
    return;
  }
  await pool.query("UPDATE messages SET status = 'publicada', published_at = NOW(3) WHERE id = ?", [msg.id]);
  // Empurra o aviso na hora para quem estiver conectado; o ciclo de sync cobre o resto.
  if (msg.target_all) {
    emitToAll('message', { uuid: req.params.uuid });
  } else {
    const [targets] = await pool.query('SELECT company_uuid FROM message_targets WHERE message_id = ?', [msg.id]);
    for (const t of targets as { company_uuid: string }[]) emitToCompany(t.company_uuid, 'message', { uuid: req.params.uuid });
  }
  res.redirect('/admin/messages?ok=publicada');
});

router.post('/:uuid/unpublish', requireAdminAuth, async (req, res) => {
  await getPool().query("UPDATE messages SET status = 'rascunho' WHERE uuid = ?", [req.params.uuid]);
  res.redirect('/admin/messages?ok=despublicada');
});

router.post('/:uuid/delete', requireAdminAuth, async (req, res) => {
  const pool = getPool();
  const [rows] = await pool.query('SELECT id, image_path FROM messages WHERE uuid = ?', [req.params.uuid]);
  const msg = (rows as { id: number; image_path: string | null }[])[0];
  if (msg) {
    await pool.query('DELETE FROM message_targets WHERE message_id = ?', [msg.id]);
    await pool.query('DELETE FROM messages WHERE id = ?', [msg.id]);
    deleteImageFile(msg.image_path);
  }
  res.redirect('/admin/messages?ok=excluida');
});

/** Prévia da imagem na listagem do painel. */
router.get('/:uuid/image', requireAdminAuth, async (req, res) => {
  const [rows] = await getPool().query('SELECT image_path, image_mime FROM messages WHERE uuid = ?', [req.params.uuid]);
  const row = (rows as { image_path: string | null; image_mime: string | null }[])[0];
  const filePath = row?.image_path ? path.join(MESSAGES_STORAGE_DIR, path.basename(row.image_path)) : null;
  if (!filePath || !fs.existsSync(filePath)) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', row!.image_mime || 'image/jpeg');
  res.send(fs.readFileSync(filePath));
});

export default router;
