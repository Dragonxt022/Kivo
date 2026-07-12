import type { Request, Response, NextFunction } from 'express';
import { audit } from '../audit/service';
import { hasCapability } from './service';

export function requireCapability(key: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!hasCapability(key)) {
      audit(req, 'acesso_negado', 'capability', key);
      res.status(403).json({ error: `Recurso desativado: ${key}` });
      return;
    }
    next();
  };
}
