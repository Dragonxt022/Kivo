import type { Request, Response, NextFunction } from 'express';

export function sendSuccess(res: Response, data?: unknown, status = 200): void {
  res.status(status).json({ success: true, data: data ?? null });
}

export function sendError(res: Response, error: string, status = 400): void {
  res.status(status).json({ success: false, error });
}

export function responseEnvelope(_req: Request, res: Response, next: NextFunction): void {
  const originalJson = res.json.bind(res);
  res.json = function (body: unknown) {
    if (body && typeof body === 'object' && !Array.isArray(body) && 'success' in (body as Record<string, unknown>)) {
      return originalJson(body);
    }
    if (res.statusCode >= 400) {
      const msg = body && typeof body === 'object'
        ? ((body as Record<string, unknown>).error as string ?? (body as Record<string, unknown>).message as string ?? 'Erro')
        : String(body ?? 'Erro');
      return originalJson({ success: false, error: msg });
    }
    if (body === undefined || body === null) {
      return originalJson({ success: true });
    }
    if (Array.isArray(body)) {
      return originalJson({ success: true, data: body });
    }
    const obj = body as Record<string, unknown>;
    if ('error' in obj) {
      return originalJson({ success: false, error: obj.error ?? 'Erro', ...obj });
    }
    if ('ok' in obj && obj.ok === true) {
      const { ok, ...rest } = obj;
      const keys = Object.keys(rest);
      if (keys.length === 0) return originalJson({ success: true });
      return originalJson({ success: true, data: keys.length === 1 ? rest[keys[0]] : rest });
    }
    return originalJson({ success: true, data: body });
  };
  next();
}
