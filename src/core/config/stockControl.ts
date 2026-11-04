import type { NextFunction, Request, Response } from 'express';
import { settingsRepository } from '../repositories/SettingsRepository';

/**
 * Chave geral do controle de quantidade.
 *
 * Nasce LIGADA (`'1'`). Com `'0'`, o Kivo trata todos os produtos como "não controla
 * estoque" — sem baixar/entrar saldo, sem alerta de mínimo e sem movimentação manual —
 * sem precisar desmarcar produto por produto no cadastro. O `track_stock` de cada
 * produto continua gravado: religar a chave devolve o comportamento anterior.
 */
export const STOCK_CONTROL_KEY = 'estoque.controlar_quantidade';

export function stockControlEnabled(): boolean {
  return settingsRepository.get(STOCK_CONTROL_KEY) !== '0';
}

/** Publica a chave em `res.locals` para as views (e para o `theme-init`). */
export function stockControlLocals(_req: Request, res: Response, next: NextFunction): void {
  try {
    res.locals.estoqueAtivo = stockControlEnabled();
  } catch {
    // Banco indisponível no boot: assume ligado, que é o padrão de fábrica.
    res.locals.estoqueAtivo = true;
  }
  next();
}
