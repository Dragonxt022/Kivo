import type { Request, Response, NextFunction } from 'express';
import { audit } from '../audit/service';

/**
 * RBAC: exige uma permissão específica (ex.: requirePermission('users.delete')).
 * Toda negação de acesso também vai para a auditoria.
 */
export function requirePermission(key: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Não autenticado.' });
      return;
    }
    if (!req.user.permissions.has(key)) {
      audit(req, 'acesso_negado', 'permission', key);
      res.status(403).json({ error: `Permissão negada: ${key}` });
      return;
    }
    next();
  };
}

/**
 * RBAC: libera se o usuário tiver QUALQUER uma das permissões informadas (ex.: uma
 * tela administrativa completa e uma permissão mais restrita de "só buscar" cobrindo
 * o mesmo endpoint).
 */
export function requireAnyPermission(...keys: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Não autenticado.' });
      return;
    }
    if (!keys.some((key) => req.user!.permissions.has(key))) {
      audit(req, 'acesso_negado', 'permission', keys.join('|'));
      res.status(403).json({ error: `Permissão negada: ${keys.join(' ou ')}` });
      return;
    }
    next();
  };
}
