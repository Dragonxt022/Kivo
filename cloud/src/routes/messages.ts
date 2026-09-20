import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { getPool } from '../db';
import { requireCompanyAuth, type AuthedRequest } from '../auth';

/**
 * Central de mensagens — lado do desktop.
 *
 * Quem chama estas rotas é o SERVIDOR LOCAL da loja (com as credenciais de licença), nunca o
 * navegador: a CSP do app só deixa `'self'`. O contrato é simples: a caixa de entrada com as
 * mensagens publicadas para aquela empresa e a imagem de destaque de cada uma.
 *
 * O estado do usuário (lido/favorito/excluído/categoria própria/ordem) NÃO mora aqui — é
 * escolha de quem lê, guardada no aparelho (ver o app local).
 */

export const MESSAGES_STORAGE_DIR = path.resolve(__dirname, '..', '..', 'storage', 'messages');

const router = Router();

/** Mensagem publicada e visível para a empresa: para todas OU com alvo explícito. */
const VISIVEL_SQL = `
  m.status = 'publicada'
  AND (m.target_all = 1
       OR EXISTS (SELECT 1 FROM message_targets t WHERE t.message_id = m.id AND t.company_uuid = ?))`;

router.get('/inbox', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const [rows] = await getPool().query(
    `SELECT m.uuid, m.title, m.subtitle, m.category, m.body_html, m.is_urgent,
            m.published_at, m.updated_at, (m.image_path IS NOT NULL) AS has_image
       FROM messages m
      WHERE ${VISIVEL_SQL}
      ORDER BY m.is_urgent DESC, m.published_at DESC`,
    [req.companyUuid],
  );
  res.json({
    messages: (
      rows as {
        uuid: string;
        title: string;
        subtitle: string | null;
        category: string;
        body_html: string;
        is_urgent: number;
        published_at: Date | null;
        updated_at: Date | null;
        has_image: number;
      }[]
    ).map((m) => ({
      uuid: m.uuid,
      title: m.title,
      subtitle: m.subtitle,
      category: m.category,
      bodyHtml: m.body_html,
      urgent: !!m.is_urgent,
      hasImage: !!m.has_image,
      publishedAt: m.published_at ? new Date(m.published_at).toISOString() : null,
      updatedAt: m.updated_at ? new Date(m.updated_at).toISOString() : null,
    })),
  });
});

router.get('/:uuid/image', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const [rows] = await getPool().query(
    `SELECT m.image_path, m.image_mime FROM messages m WHERE m.uuid = ? AND ${VISIVEL_SQL}`,
    [req.params.uuid, req.companyUuid],
  );
  const row = (rows as { image_path: string | null; image_mime: string | null }[])[0];
  // `basename` barra qualquer caminho vindo do banco.
  const filePath = row?.image_path ? path.join(MESSAGES_STORAGE_DIR, path.basename(row.image_path)) : null;
  if (!filePath || !fs.existsSync(filePath)) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', row!.image_mime || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(fs.readFileSync(filePath));
});

export default router;
