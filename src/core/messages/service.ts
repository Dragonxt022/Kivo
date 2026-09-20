import { randomUUID } from 'node:crypto';
import { getSqlite } from '../database/connection';
import { cloudBaseUrl, cloudAuthHeaders } from '../catalog/submissionQueue';
import { createLogger } from '../logger';

const log = createLogger('mensagens');

/**
 * Central de mensagens — lado da loja.
 *
 * As mensagens são escritas pelo suporte no painel cloud e chegam aqui por PULL
 * (`fetchInbox`), no boot, no ciclo de sync e no evento SSE `message`. O estado de leitura
 * (lida/favorita/excluída/categoria própria/ordem) é POR USUÁRIO e fica só neste aparelho:
 * é escolha de quem lê, não dado da empresa — por isso não sincroniza.
 *
 * A imagem de destaque é baixada sob demanda e guardada em base64 no banco local, para a
 * tela continuar funcionando sem internet depois da primeira abertura.
 */

export interface CloudMessage {
  uuid: string;
  title: string;
  subtitle: string | null;
  category: string;
  bodyHtml: string;
  urgent: boolean;
  hasImage: boolean;
  publishedAt: string | null;
  updatedAt: string | null;
}

export interface CloudMessageWithState extends CloudMessage {
  read: boolean;
  favorite: boolean;
  customCategoryId: number | null;
  sortOrder: number | null;
}

function db() {
  return getSqlite();
}

/**
 * Sanitização do corpo da mensagem. O texto é escrito no painel do suporte (fonte confiável),
 * mas renderizamos com `x-html`; tirar script/iframe/handlers/`javascript:` é defesa em
 * profundidade — a CSP do app já bloqueia execução, mas não custa fechar a porta na origem.
 */
export function sanitizeMessageHtml(html: string): string {
  return String(html ?? '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/(href|src)\s*=\s*"(?:\s*javascript:)[^"]*"/gi, '$1="#"')
    .replace(/(href|src)\s*=\s*'(?:\s*javascript:)[^']*'/gi, "$1='#'")
    .replace(/\sstyle\s*=\s*"[^"]*"/gi, '')
    .replace(/\sstyle\s*=\s*'[^']*'/gi, '');
}

/** Categorias fixas do sistema, na ordem em que aparecem na barra lateral. */
export const CATEGORIAS_FIXAS: { slug: string; label: string }[] = [
  { slug: 'atualizacao', label: 'Atualizações' },
  { slug: 'comunicado', label: 'Comunicados' },
  { slug: 'tutorial', label: 'Tutoriais' },
  { slug: 'dica', label: 'Dicas' },
  { slug: 'novidade', label: 'Novidades' },
  { slug: 'sistema', label: 'Sistema' },
];

/** Puxa a caixa de entrada da nuvem e faz upsert no cache local. Nunca lança. */
export async function fetchInbox(): Promise<number> {
  const base = cloudBaseUrl();
  const auth = cloudAuthHeaders();
  if (!base || !auth) return 0;
  try {
    const r = await fetch(`${base}/api/messages/inbox`, {
      headers: auth,
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return 0;
    const data = (await r.json()) as { messages?: CloudMessage[] };
    // Só mexe no cache quando a resposta trouxe mesmo a lista. Um corpo inesperado não pode
    // apagar mensagens que já estão aqui.
    if (!Array.isArray(data.messages)) return 0;
    const messages = data.messages;
    const upsert = db().prepare(
      `INSERT INTO cloud_messages (uuid, title, subtitle, category, body_html, has_image, is_urgent, published_at, remote_updated_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(uuid) DO UPDATE SET
         title = excluded.title,
         subtitle = excluded.subtitle,
         category = excluded.category,
         body_html = excluded.body_html,
         has_image = excluded.has_image,
         is_urgent = excluded.is_urgent,
         published_at = excluded.published_at,
         image_b64 = CASE WHEN cloud_messages.remote_updated_at = excluded.remote_updated_at THEN cloud_messages.image_b64 ELSE NULL END,
         image_mime = CASE WHEN cloud_messages.remote_updated_at = excluded.remote_updated_at THEN cloud_messages.image_mime ELSE NULL END,
         remote_updated_at = excluded.remote_updated_at,
         fetched_at = datetime('now')`,
    );
    const tx = db().transaction((list: CloudMessage[]) => {
      for (const m of list) {
        upsert.run(
          m.uuid,
          m.title,
          m.subtitle ?? null,
          m.category ?? 'comunicado',
          m.bodyHtml ?? '',
          m.hasImage ? 1 : 0,
          m.urgent ? 1 : 0,
          m.publishedAt ?? null,
          m.updatedAt ?? null,
        );
      }
      // Despublicada/excluída na nuvem some daqui também (o admin pode ter enviado sem
      // querer). O inbox devolve SEMPRE o conjunto completo visível à empresa, então o que
      // não veio saiu do ar.
      if (list.length) {
        const ph = list.map(() => '?').join(',');
        db()
          .prepare(`DELETE FROM cloud_messages WHERE uuid NOT IN (${ph})`)
          .run(...list.map((m) => m.uuid));
      } else {
        db().prepare('DELETE FROM cloud_messages').run();
      }
      // Estado das mensagens que saíram deixa de fazer sentido.
      db().prepare('DELETE FROM cloud_message_state WHERE message_uuid NOT IN (SELECT uuid FROM cloud_messages)').run();
    });
    tx(messages);
    return messages.length;
  } catch (e) {
    // Sem nuvem/offline é o caso comum — o cache local continua valendo.
    log.info(`não deu para buscar mensagens (${(e as Error).message}).`);
    return 0;
  }
}

function ensureState(userId: number, messageUuid: string): void {
  const existing = db()
    .prepare('SELECT id FROM cloud_message_state WHERE message_uuid = ? AND user_id = ?')
    .get(messageUuid, userId);
  if (existing) return;
  db()
    .prepare(
      `INSERT INTO cloud_message_state (uuid, message_uuid, user_id, updated_at)
       VALUES (?, ?, ?, datetime('now'))`,
    )
    .run(randomUUID(), messageUuid, userId);
}

export function listForUser(userId: number): CloudMessageWithState[] {
  const rows = db()
    .prepare(
      `SELECT m.uuid, m.title, m.subtitle, m.category, m.body_html, m.has_image, m.is_urgent,
              m.published_at,
              s.read_at, s.dismissed_at, s.favorite, s.custom_category_id, s.sort_order
         FROM cloud_messages m
         LEFT JOIN cloud_message_state s ON s.message_uuid = m.uuid AND s.user_id = ?
        WHERE s.dismissed_at IS NULL
        ORDER BY (s.sort_order IS NULL), s.sort_order ASC, m.is_urgent DESC, m.published_at DESC`,
    )
    .all(userId) as {
    uuid: string;
    title: string;
    subtitle: string | null;
    category: string;
    body_html: string;
    has_image: number;
    is_urgent: number;
    published_at: string | null;
    read_at: string | null;
    favorite: number | null;
    custom_category_id: number | null;
    sort_order: number | null;
  }[];
  return rows.map((r) => ({
    uuid: r.uuid,
    title: r.title,
    subtitle: r.subtitle,
    category: r.category,
    bodyHtml: sanitizeMessageHtml(r.body_html),
    urgent: !!r.is_urgent,
    hasImage: !!r.has_image,
    publishedAt: r.published_at,
    updatedAt: null,
    read: !!r.read_at,
    favorite: !!r.favorite,
    customCategoryId: r.custom_category_id ?? null,
    sortOrder: r.sort_order ?? null,
  }));
}

export function markRead(userId: number, uuid: string, read: boolean): void {
  ensureState(userId, uuid);
  db()
    .prepare(
      `UPDATE cloud_message_state
          SET read_at = ${read ? "datetime('now')" : 'NULL'}, updated_at = datetime('now')
        WHERE message_uuid = ? AND user_id = ?`,
    )
    .run(uuid, userId);
}

export function setFavorite(userId: number, uuid: string, favorite: boolean): void {
  ensureState(userId, uuid);
  db()
    .prepare('UPDATE cloud_message_state SET favorite = ?, updated_at = datetime(\'now\') WHERE message_uuid = ? AND user_id = ?')
    .run(favorite ? 1 : 0, uuid, userId);
}

export function dismiss(userId: number, uuid: string): void {
  ensureState(userId, uuid);
  db()
    .prepare(
      "UPDATE cloud_message_state SET dismissed_at = datetime('now'), updated_at = datetime('now') WHERE message_uuid = ? AND user_id = ?",
    )
    .run(uuid, userId);
}

export function assignCategory(userId: number, uuid: string, categoryId: number | null): void {
  ensureState(userId, uuid);
  db()
    .prepare('UPDATE cloud_message_state SET custom_category_id = ?, updated_at = datetime(\'now\') WHERE message_uuid = ? AND user_id = ?')
    .run(categoryId, uuid, userId);
}

/** A ordem vem da lista completa (uuid na posição), gravada como sort_order crescente. */
export function reorder(userId: number, orderedUuids: string[]): void {
  const upd = db().prepare(
    "UPDATE cloud_message_state SET sort_order = ?, updated_at = datetime('now') WHERE message_uuid = ? AND user_id = ?",
  );
  db().transaction(() => {
    orderedUuids.forEach((uuid, i) => {
      ensureState(userId, uuid);
      upd.run(i, uuid, userId);
    });
  })();
}

export interface CustomCategory {
  id: number;
  name: string;
  sortOrder: number;
}

export function listCategories(userId: number): CustomCategory[] {
  const rows = db()
    .prepare('SELECT id, name, sort_order FROM cloud_message_categories WHERE user_id = ? ORDER BY sort_order ASC, name ASC')
    .all(userId) as { id: number; name: string; sort_order: number }[];
  return rows.map((r) => ({ id: r.id, name: r.name, sortOrder: r.sort_order }));
}

export function createCategory(userId: number, name: string): CustomCategory | null {
  const clean = name.trim().slice(0, 60);
  if (!clean) return null;
  const exists = db()
    .prepare('SELECT id FROM cloud_message_categories WHERE user_id = ? AND name = ? COLLATE NOCASE')
    .get(userId, clean);
  if (exists) return null;
  const next = db()
    .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM cloud_message_categories WHERE user_id = ?')
    .get(userId) as { n: number };
  const info = db()
    .prepare('INSERT INTO cloud_message_categories (uuid, user_id, name, sort_order) VALUES (?, ?, ?, ?)')
    .run(randomUUID(), userId, clean, next.n);
  return { id: Number(info.lastInsertRowid), name: clean, sortOrder: next.n };
}

export function deleteCategory(userId: number, id: number): void {
  db().transaction(() => {
    db()
      .prepare('UPDATE cloud_message_state SET custom_category_id = NULL WHERE custom_category_id = ? AND user_id = ?')
      .run(id, userId);
    db().prepare('DELETE FROM cloud_message_categories WHERE id = ? AND user_id = ?').run(id, userId);
  })();
}

/** Mensagens urgentes ainda não lidas (para o aviso na tela inicial). */
export function urgentPending(userId: number): CloudMessageWithState[] {
  return listForUser(userId).filter((m) => m.urgent && !m.read);
}

/**
 * Imagem de destaque em base64. Na primeira chamada baixa da nuvem e guarda no banco;
 * depois serve do cache, mesmo offline. Devolve `null` se não houver.
 */
export async function imageFor(uuid: string): Promise<{ mime: string; b64: string } | null> {
  const row = db()
    .prepare('SELECT has_image, image_mime, image_b64 FROM cloud_messages WHERE uuid = ?')
    .get(uuid) as { has_image: number; image_mime: string | null; image_b64: string | null } | undefined;
  if (!row || !row.has_image) return null;
  if (row.image_b64 && row.image_mime) return { mime: row.image_mime, b64: row.image_b64 };

  const base = cloudBaseUrl();
  const auth = cloudAuthHeaders();
  if (!base || !auth) return null;
  try {
    const r = await fetch(`${base}/api/messages/${encodeURIComponent(uuid)}/image`, {
      headers: auth,
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await r.arrayBuffer());
    const b64 = buf.toString('base64');
    db()
      .prepare('UPDATE cloud_messages SET image_mime = ?, image_b64 = ? WHERE uuid = ?')
      .run(mime, b64, uuid);
    return { mime, b64 };
  } catch (e) {
    log.info(`não deu para baixar a imagem de ${uuid} (${(e as Error).message}).`);
    return null;
  }
}
