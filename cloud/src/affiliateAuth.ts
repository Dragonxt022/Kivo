import { randomBytes, createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Request, Response, NextFunction } from 'express';
import { getPool } from './db';

/**
 * Autenticação do PORTAL DO AFILIADO — separada da do painel admin.
 *
 * O afiliado é um representante externo: ele enxerga apenas as empresas que indicou, os
 * créditos de comissão e os pedidos de pagamento dele. O cookie é próprio
 * (`kivo_affiliate_session`) e a sessão vive no banco (`affiliate_sessions`), mesmo padrão
 * de `adminAuth.ts` — assim um deploy/restart não desloga ninguém.
 */
export const AFFILIATE_SESSION_COOKIE = 'kivo_affiliate_session';
const SESSION_TTL_MS = 12 * 3600e3; // 12h

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function hashAffiliatePassword(plain: string): string {
  return bcrypt.hashSync(plain, 10);
}

export interface AffiliateIdentity {
  id: number;
  name: string;
}

/** Confere usuário/senha de um afiliado ATIVO e com acesso ao portal configurado. */
export async function verifyAffiliateCredentials(
  username: string,
  password: string,
): Promise<AffiliateIdentity | null> {
  const [rows] = await getPool().query(
    'SELECT id, name, password_hash FROM affiliates WHERE username = ? AND active = 1',
    [username],
  );
  const row = (rows as { id: number; name: string; password_hash: string | null }[])[0];
  if (!row || !row.password_hash) return null;
  if (!bcrypt.compareSync(password, row.password_hash)) return null;
  return { id: Number(row.id), name: row.name };
}

export async function createAffiliateSession(affiliateId: number): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await getPool().query(
    'INSERT INTO affiliate_sessions (token_hash, affiliate_id, expires_at) VALUES (?, ?, ?)',
    [hashToken(token), affiliateId, expires],
  );
  return token;
}

export async function destroyAffiliateSession(token: string | null): Promise<void> {
  if (!token) return;
  try {
    await getPool().query('DELETE FROM affiliate_sessions WHERE token_hash = ?', [hashToken(token)]);
  } catch {
    // Logout é best-effort: o cookie é limpo de qualquer forma.
  }
}

/** Apaga sessões vencidas. Chamado no boot e a cada 6h. */
export async function purgeExpiredAffiliateSessions(): Promise<void> {
  try {
    await getPool().query('DELETE FROM affiliate_sessions WHERE expires_at < NOW()');
  } catch {
    // best-effort
  }
}

function readCookie(req: Request): string | null {
  const cookies = req.headers.cookie ?? '';
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${AFFILIATE_SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

export interface AffiliateRequest extends Request {
  affiliateId?: number;
  affiliateName?: string;
}

export async function requireAffiliateAuth(
  req: AffiliateRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = readCookie(req);
  if (!token) {
    res.redirect('/afiliado/login');
    return;
  }
  const hash = hashToken(token);
  let row: { affiliate_id: number; expires_at: string; name: string; active: number } | undefined;
  try {
    const [rows] = await getPool().query(
      `SELECT s.affiliate_id, s.expires_at, a.name, a.active
         FROM affiliate_sessions s JOIN affiliates a ON a.id = s.affiliate_id
        WHERE s.token_hash = ?`,
      [hash],
    );
    row = (rows as { affiliate_id: number; expires_at: string; name: string; active: number }[])[0];
  } catch {
    res.redirect('/afiliado/login');
    return;
  }
  if (!row || new Date(row.expires_at) < new Date() || !row.active) {
    if (row) await getPool().query('DELETE FROM affiliate_sessions WHERE token_hash = ?', [hash]).catch(() => {});
    res.redirect('/afiliado/login');
    return;
  }
  req.affiliateId = Number(row.affiliate_id);
  req.affiliateName = row.name;
  res.locals.affiliateId = Number(row.affiliate_id);
  res.locals.affiliateName = row.name;
  next();
}

export { readCookie as readAffiliateCookie };
