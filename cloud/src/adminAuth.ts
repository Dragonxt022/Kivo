import { randomBytes, createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Request, Response, NextFunction } from 'express';
import { getPool } from './db';

export const ADMIN_SESSION_COOKIE = 'kivo_admin_session';
const SESSION_TTL_MS = 12 * 3600e3; // 12h

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Sessão do painel persistida no banco (`admin_sessions`) — antes era um `Map` em
 * memória, e todo deploy/restart deslogava o suporte. O cookie carrega o token cru; o
 * banco guarda só o hash. Cookie lido via regex manual em `req.headers.cookie`, mesmo
 * padrão de `src/core/auth/middleware.ts` — sem dependência de cookie-parser.
 */
export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10);
}

export async function hasAnyAdmin(): Promise<boolean> {
  const [rows] = await getPool().query('SELECT COUNT(*) AS total FROM admin_users');
  return (rows as { total: number }[])[0].total > 0;
}

export async function verifyAdminCredentials(username: string, password: string): Promise<boolean> {
  const [rows] = await getPool().query('SELECT password_hash FROM admin_users WHERE username = ?', [username]);
  const row = (rows as { password_hash: string }[])[0];
  if (!row) return false;
  return bcrypt.compareSync(password, row.password_hash);
}

export async function createAdminSession(username: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await getPool().query(
    'INSERT INTO admin_sessions (token_hash, username, expires_at) VALUES (?, ?, ?)',
    [hashToken(token), username, expires],
  );
  return token;
}

export async function destroyAdminSession(token: string | null): Promise<void> {
  if (!token) return;
  try {
    await getPool().query('DELETE FROM admin_sessions WHERE token_hash = ?', [hashToken(token)]);
  } catch {
    // Logout é best-effort: o cookie é limpo de qualquer forma.
  }
}

/** Apaga sessões vencidas. Chamado no boot e a cada 6h — a tabela não precisa crescer. */
export async function purgeExpiredAdminSessions(): Promise<void> {
  try {
    await getPool().query('DELETE FROM admin_sessions WHERE expires_at < NOW()');
  } catch {
    // best-effort
  }
}

function readCookie(req: Request): string | null {
  const cookies = req.headers.cookie ?? '';
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${ADMIN_SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

export interface AdminRequest extends Request {
  adminUsername?: string;
}

interface NotificationItem {
  title: string;
  meta: string;
  link: string;
}

/** Sino do topo: licenças vencidas/a vencer em 7 dias + fila de curadoria do banco de imagens. */
async function loadNotifications(): Promise<{ count: number; items: NotificationItem[] }> {
  try {
    const pool = getPool();
    const [companyRows] = await pool.query(
      `SELECT company_uuid, name, valid_until FROM companies
       WHERE valid_until IS NOT NULL AND valid_until <= DATE_ADD(NOW(), INTERVAL 7 DAY)
       ORDER BY valid_until ASC LIMIT 5`,
    );
    const [pendingRows] = await pool.query("SELECT COUNT(*) AS total FROM catalog_images WHERE status = 'pendente'");
    const pendingTotal = (pendingRows as { total: number }[])[0]?.total ?? 0;
    const [payoutRows] = await pool.query(
      `SELECT p.id, p.amount_cents, a.name FROM affiliate_payouts p
        LEFT JOIN affiliates a ON a.id = p.affiliate_id
       WHERE p.status = 'solicitado' ORDER BY p.id DESC LIMIT 5`,
    );

    const items: NotificationItem[] = (
      companyRows as { company_uuid: string; name: string | null; valid_until: string }[]
    ).map((c) => {
      const expired = new Date(c.valid_until) < new Date();
      const date = String(c.valid_until).slice(0, 10);
      return {
        title: c.name || c.company_uuid,
        meta: expired ? `Licença vencida em ${date}` : `Licença vence em ${date}`,
        link: `/admin/companies/${c.company_uuid}`,
      };
    });
    if (pendingTotal > 0) {
      items.push({
        title: `${pendingTotal} imagem(ns) aguardando curadoria`,
        meta: 'Banco de imagens',
        link: '/admin/catalog',
      });
    }
    for (const p of payoutRows as { id: number; amount_cents: number; name: string | null }[]) {
      items.push({
        title: `Pagamento a ${p.name || 'afiliado'}: R$ ${(Number(p.amount_cents) / 100).toFixed(2)}`,
        meta: 'Pedido de pagamento de afiliado',
        link: '/admin/payouts',
      });
    }
    return { count: items.length, items };
  } catch {
    return { count: 0, items: [] };
  }
}

export async function requireAdminAuth(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  const token = readCookie(req);
  if (!token) {
    res.redirect('/admin/login');
    return;
  }
  const hash = hashToken(token);
  let row: { username: string; expires_at: string } | undefined;
  try {
    const [rows] = await getPool().query(
      'SELECT username, expires_at FROM admin_sessions WHERE token_hash = ?',
      [hash],
    );
    row = (rows as { username: string; expires_at: string }[])[0];
  } catch {
    res.redirect('/admin/login');
    return;
  }
  if (!row || new Date(row.expires_at) < new Date()) {
    if (row) await getPool().query('DELETE FROM admin_sessions WHERE token_hash = ?', [hash]).catch(() => {});
    res.redirect('/admin/login');
    return;
  }
  req.adminUsername = row.username;
  res.locals.adminUsername = row.username;
  res.locals.notifications = await loadNotifications();
  next();
}

export { readCookie as readAdminCookie };
