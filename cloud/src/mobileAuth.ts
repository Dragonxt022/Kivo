import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { getPool } from './db';
import { canUseWebApp } from './plans';

export const MOBILE_COOKIE = 'kivo_m';
/** 30 dias: o dono não quer reparear o celular toda semana. Revogar é imediato mesmo assim. */
const COOKIE_MAX_AGE_MS = 30 * 24 * 3600e3;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface MobileGrant {
  companyUuid: string;
  userUuid: string;
  username: string;
  name: string;
  roleSlug: string | null;
  permissions: string[];
  companyName: string | null;
}

export interface MobileRequest extends Request {
  grant?: MobileGrant;
}

/**
 * Sessão do Kivo Web SEM tabela de sessão: o cookie guarda o próprio token do link/QR e cada
 * requisição revalida o hash contra `company_mobile_grants`.
 *
 * A alternativa (token de sessão separado, como no painel admin) exigiria invalidar sessões
 * ao revogar um acesso. Assim, `revoked_at` na linha do grant já derruba o celular na
 * requisição seguinte — que é o comportamento que o lojista espera de um botão "Revogar".
 *
 * Custo: uma consulta indexada por requisição. Aceitável — é um índice único em CHAR(64).
 */
export async function loadGrantByToken(token: string): Promise<MobileGrant | null> {
  const [rows] = await getPool().query(
    `SELECT g.company_uuid, g.user_uuid, g.username, g.name, g.role_slug, g.permissions,
            c.name AS company_name, c.plan
       FROM company_mobile_grants g
       JOIN companies c ON c.company_uuid = g.company_uuid
      WHERE g.token_hash = ? AND g.revoked_at IS NULL`,
    [hashToken(token)],
  );
  const row = (
    rows as {
      company_uuid: string; user_uuid: string; username: string; name: string;
      role_slug: string | null; permissions: string | string[]; company_name: string | null; plan: string | null;
    }[]
  )[0];
  if (!row) return null;
  // O plano pode ter caído depois do acesso concedido — checar a cada requisição, e não só
  // na concessão, é o que faz o downgrade valer sem passo manual.
  if (!canUseWebApp(row.plan)) return null;
  return {
    companyUuid: row.company_uuid,
    userUuid: row.user_uuid,
    username: row.username,
    name: row.name,
    roleSlug: row.role_slug,
    permissions: typeof row.permissions === 'string' ? JSON.parse(row.permissions) : row.permissions,
    companyName: row.company_name,
  };
}

export function readMobileCookie(req: Request): string | null {
  const cookies = req.headers.cookie ?? '';
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${MOBILE_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

export function setMobileCookie(res: Response, token: string): void {
  res.cookie(MOBILE_COOKIE, token, {
    httpOnly: true,
    // Em desenvolvimento (http://localhost) um cookie `secure` nunca seria guardado.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/',
  });
}

export function clearMobileCookie(res: Response): void {
  res.clearCookie(MOBILE_COOKIE, { path: '/' });
}

export async function touchGrant(companyUuid: string, userUuid: string): Promise<void> {
  try {
    await getPool().query(
      'UPDATE company_mobile_grants SET last_used_at = NOW() WHERE company_uuid = ? AND user_uuid = ?',
      [companyUuid, userUuid],
    );
  } catch {
    // Registro de uso é informativo (aparece na lista de acessos do desktop) — nunca deve
    // impedir o lojista de usar o painel.
  }
}

export async function requireMobileAuth(req: MobileRequest, res: Response, next: NextFunction): Promise<void> {
  const token = readMobileCookie(req);
  const grant = token ? await loadGrantByToken(token) : null;
  if (!grant) {
    clearMobileCookie(res);
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'Acesso expirado ou revogado.' });
      return;
    }
    res.redirect('/m/entrar');
    return;
  }
  req.grant = grant;
  res.locals.grant = grant;
  // `can` nas views, mesmas chaves de permissão do desktop — nada de inventar nomes novos.
  res.locals.can = (key: string) => grant.permissions.includes(key);
  next();
}
