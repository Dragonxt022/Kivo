/**
 * Compatibilidade de transição Kivo → Kuruk nos cabeçalhos das rotas da API.
 *
 * O desktop novo manda `X-Kuruk-*` e também os antigos `X-Kivo-*`; instalações
 * antigas do desktop mandam só `X-Kivo-*`. Copiar o legado para o nome novo
 * antes das rotas evita ter dois caminhos de leitura em cada controller.
 *
 * Pode ser removido quando não houver mais cliente antigo em campo.
 */
import type { NextFunction, Request, Response } from 'express';

export function legacyHeaderAliases(req: Request, _res: Response, next: NextFunction): void {
  for (const [key, value] of Object.entries(req.headers)) {
    if (!key.startsWith('x-kivo-') || Array.isArray(value)) continue;
    const current = `x-kuruk-${key.slice('x-kivo-'.length)}`;
    if (req.headers[current] === undefined) req.headers[current] = value;
  }
  next();
}
