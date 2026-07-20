import type { Request, Response, NextFunction } from 'express';
import { userFromToken, type AuthUser } from './service';

export const SESSION_COOKIE = 'kivo_session';

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

function tokenFromRequest(req: Request): string | null {
  const cookies = req.headers.cookie ?? '';
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

/** Anexa req.user se houver sessão válida (não bloqueia). */
export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const token = tokenFromRequest(req);
  if (token) {
    const user = userFromToken(token);
    if (user) req.user = user;
  }
  next();
}

/** Bloqueia se não autenticado: 401 na API, redirect na UI. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.user) return next();
  if (req.originalUrl.startsWith('/api/')) {
    res.status(401).json({ error: 'Não autenticado.' });
  } else {
    res.redirect('/?login=1');
  }
}
