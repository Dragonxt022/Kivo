import { Router } from 'express';
import { getPool } from '../db';
import { requireCompanyAuth, type AuthedRequest } from '../auth';

/**
 * Chat de suporte (tickets) — API consumida pelo Katsu desktop, autenticada pelo
 * par company_uuid + license_key (mesma auth do sync). Disponível em todos os
 * planos: suporte não é recurso premium.
 *
 * Toda a conversa fica registrada com autor, papel e data — serve de trilha de
 * auditoria do atendimento. O painel admin responde em /admin/support.
 */
const router = Router();

router.use(requireCompanyAuth);

export const TICKET_CATEGORIES = ['suporte', 'sugestao', 'outro'] as const;
export const TICKET_STATUSES = ['aberto', 'fechado', 'arquivado'] as const;

interface TicketRow {
  id: number;
  company_uuid: string;
  subject: string;
  category: string;
  status: string;
  created_by: string | null;
  client_unread: number;
  admin_unread: number;
  last_message_at: string;
  created_at: string;
}

async function findOwnTicket(companyUuid: string, id: number): Promise<TicketRow | undefined> {
  const [rows] = await getPool().query(
    'SELECT * FROM support_tickets WHERE id = ? AND company_uuid = ?',
    [id, companyUuid],
  );
  return (rows as TicketRow[])[0];
}

/** Lista os tickets da empresa (mais recentes primeiro). */
router.get('/tickets', async (req: AuthedRequest, res) => {
  const [rows] = await getPool().query(
    `SELECT id, subject, category, status, created_by, client_unread, last_message_at, created_at
       FROM support_tickets WHERE company_uuid = ? ORDER BY last_message_at DESC`,
    [req.companyUuid],
  );
  res.json({ tickets: rows });
});

/** Abre um ticket novo com a primeira mensagem. */
router.post('/tickets', async (req: AuthedRequest, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const subject = String(b.subject ?? '').trim().slice(0, 160);
  const message = String(b.message ?? '').trim();
  const userName = String(b.userName ?? '').trim().slice(0, 120) || null;
  const category = (TICKET_CATEGORIES as readonly string[]).includes(String(b.category))
    ? String(b.category)
    : 'suporte';

  if (!subject) return res.status(400).json({ error: 'Informe o assunto.' });
  if (!message || message.length > 4000) return res.status(400).json({ error: 'Mensagem vazia ou longa demais.' });

  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [info] = await conn.query(
      'INSERT INTO support_tickets (company_uuid, subject, category, created_by) VALUES (?, ?, ?, ?)',
      [req.companyUuid, subject, category, userName],
    );
    const ticketId = (info as { insertId: number }).insertId;
    await conn.query(
      'INSERT INTO support_messages (ticket_id, sender, sender_name, body) VALUES (?, ?, ?, ?)',
      [ticketId, 'cliente', userName, message],
    );
    await conn.commit();
    res.status(201).json({ id: ticketId });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});

/** Mensagens do ticket; abrir a conversa zera o não-lido do cliente. */
router.get('/tickets/:id/messages', async (req: AuthedRequest, res) => {
  const ticket = await findOwnTicket(req.companyUuid!, Number(req.params.id));
  if (!ticket) return res.status(404).json({ error: 'Ticket não encontrado.' });
  const [messages] = await getPool().query(
    'SELECT id, sender, sender_name, body, created_at FROM support_messages WHERE ticket_id = ? ORDER BY id',
    [ticket.id],
  );
  if (ticket.client_unread > 0) {
    await getPool().query('UPDATE support_tickets SET client_unread = 0 WHERE id = ?', [ticket.id]);
  }
  res.json({ ticket: { id: ticket.id, subject: ticket.subject, category: ticket.category, status: ticket.status }, messages });
});

/** Nova mensagem do cliente. Ticket fechado/arquivado não recebe mensagem. */
router.post('/tickets/:id/messages', async (req: AuthedRequest, res) => {
  const ticket = await findOwnTicket(req.companyUuid!, Number(req.params.id));
  if (!ticket) return res.status(404).json({ error: 'Ticket não encontrado.' });
  if (ticket.status !== 'aberto') {
    return res.status(409).json({ error: 'Este ticket está encerrado — abra um novo para continuar o atendimento.' });
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const body = String(b.body ?? '').trim();
  const userName = String(b.userName ?? '').trim().slice(0, 120) || null;
  if (!body || body.length > 4000) return res.status(400).json({ error: 'Mensagem vazia ou longa demais.' });

  await getPool().query(
    'INSERT INTO support_messages (ticket_id, sender, sender_name, body) VALUES (?, ?, ?, ?)',
    [ticket.id, 'cliente', userName, body],
  );
  await getPool().query(
    'UPDATE support_tickets SET admin_unread = admin_unread + 1, last_message_at = NOW(3) WHERE id = ?',
    [ticket.id],
  );
  res.status(201).json({ ok: true });
});

/** Cliente encerra o próprio ticket. */
router.post('/tickets/:id/close', async (req: AuthedRequest, res) => {
  const ticket = await findOwnTicket(req.companyUuid!, Number(req.params.id));
  if (!ticket) return res.status(404).json({ error: 'Ticket não encontrado.' });
  if (ticket.status === 'arquivado') return res.status(409).json({ error: 'Ticket arquivado não pode ser alterado.' });
  await getPool().query("UPDATE support_tickets SET status = 'fechado' WHERE id = ?", [ticket.id]);
  res.json({ ok: true });
});

export default router;
