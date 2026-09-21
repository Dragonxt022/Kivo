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

// --- Recuperação de senha por e-mail ---

/** Validade do link de redefinição. Curto o bastante para um link vazado não servir por muito. */
const RESET_TTL_MS = 60 * 60e3; // 1h

export interface AdminIdentity {
  username: string;
  email: string | null;
}

/** Perfil básico do admin (usado no /admin/profile e na recuperação). */
export async function getAdminProfile(username: string): Promise<AdminIdentity | null> {
  const [rows] = await getPool().query('SELECT username, email FROM admin_users WHERE username = ?', [username]);
  return (rows as AdminIdentity[])[0] ?? null;
}

/** Localiza o admin por usuário OU e-mail (o "esqueci minha senha" aceita os dois). */
export async function findAdminByIdentity(identity: string): Promise<AdminIdentity | null> {
  const [rows] = await getPool().query(
    'SELECT username, email FROM admin_users WHERE username = ? OR email = ? LIMIT 1',
    [identity, identity],
  );
  return (rows as AdminIdentity[])[0] ?? null;
}

export async function setAdminEmail(username: string, email: string | null): Promise<void> {
  await getPool().query('UPDATE admin_users SET email = ? WHERE username = ?', [email, username]);
}

export async function setAdminPassword(username: string, plain: string): Promise<void> {
  await getPool().query('UPDATE admin_users SET password_hash = ? WHERE username = ?', [hashPassword(plain), username]);
}

/** Derruba todas as sessões de um usuário (usado após trocar a senha). */
export async function destroyAdminSessionsFor(username: string): Promise<void> {
  await getPool().query('DELETE FROM admin_sessions WHERE username = ?', [username]);
}

/**
 * Cria um token de redefinição e devolve o valor CRU (o banco guarda só o hash, como nas
 * sessões). Pedidos anteriores ainda não usados do mesmo usuário são invalidados — só o
 * link mais recente vale.
 */
export async function createPasswordReset(username: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + RESET_TTL_MS);
  await getPool().query('DELETE FROM admin_password_resets WHERE username = ? AND used_at IS NULL', [username]);
  await getPool().query('INSERT INTO admin_password_resets (token_hash, username, expires_at) VALUES (?, ?, ?)', [
    hashToken(token),
    username,
    expires,
  ]);
  return token;
}

/** Confere se o token existe, não expirou e não foi usado (sem consumi-lo). */
export async function validatePasswordReset(token: string): Promise<boolean> {
  if (!token) return false;
  const [rows] = await getPool().query(
    'SELECT expires_at, used_at FROM admin_password_resets WHERE token_hash = ?',
    [hashToken(token)],
  );
  const row = (rows as { expires_at: string; used_at: string | null }[])[0];
  return Boolean(row && !row.used_at && new Date(row.expires_at) >= new Date());
}

/** Consome o token (marca como usado) e devolve o usuário, ou null se inválido/expirado. */
export async function consumePasswordReset(token: string): Promise<string | null> {
  if (!token) return null;
  const hash = hashToken(token);
  const [rows] = await getPool().query(
    'SELECT username, expires_at, used_at FROM admin_password_resets WHERE token_hash = ?',
    [hash],
  );
  const row = (rows as { username: string; expires_at: string; used_at: string | null }[])[0];
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) return null;
  await getPool().query('UPDATE admin_password_resets SET used_at = NOW(3) WHERE token_hash = ?', [hash]);
  return row.username;
}

/** Limpa tokens vencidos/já usados. Chamado no boot junto com a limpeza das sessões. */
export async function purgeExpiredPasswordResets(): Promise<void> {
  try {
    await getPool().query('DELETE FROM admin_password_resets WHERE expires_at < NOW() OR used_at IS NOT NULL');
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
