import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Request, Response, NextFunction } from 'express';
import { getPool } from './db';

export const ADMIN_SESSION_COOKIE = 'katsu_admin_session';
const SESSION_TTL_MS = 12 * 3600e3; // 12h

interface AdminSession {
  username: string;
  expiresAt: number;
}

/**
 * Sessão do painel em memória — decisão de escopo da Fase 6d: o painel reinicia
 * raramente e um logout forçado num restart é aceitável (evita mais uma tabela só
 * para sessão). Cookie lido via regex manual em `req.headers.cookie`, mesmo padrão de
 * `src/core/auth/middleware.ts` no app principal — sem dependência de cookie-parser.
 */
const sessions = new Map<string, AdminSession>();

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10);
}

export async function verifyAdminCredentials(username: string, password: string): Promise<boolean> {
  const [rows] = await getPool().query('SELECT password_hash FROM admin_users WHERE username = ?', [username]);
  const row = (rows as { password_hash: string }[])[0];
  if (!row) return false;
  return bcrypt.compareSync(password, row.password_hash);
}

export function createAdminSession(username: string): string {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

export function destroyAdminSession(token: string | null): void {
  if (token) sessions.delete(token);
}

function readCookie(req: Request): string | null {
  const cookies = req.headers.cookie ?? '';
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${ADMIN_SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

export interface AdminRequest extends Request {
  adminUsername?: string;
}

export function requireAdminAuth(req: AdminRequest, res: Response, next: NextFunction): void {
  const token = readCookie(req);
  const session = token ? sessions.get(token) : undefined;
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    res.redirect('/admin/login');
    return;
  }
  req.adminUsername = session.username;
  res.locals.adminUsername = session.username;
  next();
}

export { readCookie as readAdminCookie };
