import type { Request } from 'express';
import type { AuthUser } from '../core/auth/service';

export function assertAuth(req: Request): asserts req is Request & { user: AuthUser } {
  if (!req.user) throw new Error('Não autenticado.');
}
