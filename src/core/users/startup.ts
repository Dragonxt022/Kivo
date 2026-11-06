import type { NextFunction, Request, Response } from 'express';
import { getSqlite } from '../database/connection';
import type { ModuleMenuItem } from '../modules/types';

/**
 * Abertura personalizada por usuário (`user_startup`).
 *
 * A preferência é individual: o operador do tablet de Mesas não muda a tela inicial do
 * dono no escritório. Fica fora de `settings` (empresa) e fora de `syncTables` (viagem
 * entre máquinas) de propósito — é um hábito local de quem usa aquele terminal.
 *
 * O href nunca é executado como veio do banco: ao salvar e de novo ao abrir, ele é
 * conferido contra o menu que o usuário realmente enxerga. Assim, perder uma permissão
 * (ou o módulo sair do plano) só faz o Kivo abrir normal, sem quebrar o login.
 */

export interface StartupPref {
  enabled: boolean;
  moduleHref: string;
  fullscreen: boolean;
}

const DEFAULTS: StartupPref = { enabled: false, moduleHref: '', fullscreen: true };

function getStartupRow(userId: number):
  | { enabled: number; module_href: string; fullscreen: number }
  | undefined {
  return getSqlite()
    .prepare('SELECT enabled, module_href, fullscreen FROM user_startup WHERE user_id = ?')
    .get(userId) as { enabled: number; module_href: string; fullscreen: number } | undefined;
}

export function getStartupPref(userId: number): StartupPref {
  const row = getStartupRow(userId);
  if (!row) return { ...DEFAULTS };
  return {
    enabled: row.enabled === 1,
    moduleHref: row.module_href || '',
    fullscreen: row.fullscreen !== 0,
  };
}

export function saveStartupPref(userId: number, pref: StartupPref): void {
  getSqlite()
    .prepare(
      `INSERT INTO user_startup (user_id, enabled, module_href, fullscreen, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         enabled = excluded.enabled,
         module_href = excluded.module_href,
         fullscreen = excluded.fullscreen,
         updated_at = datetime('now')`,
    )
    .run(userId, pref.enabled ? 1 : 0, pref.moduleHref, pref.fullscreen ? 1 : 0);
}

/**
 * Conjunto de permissões do usuário-alvo, inclusive desativado. Carregar pelo cargo (e
 * não por `loadAuthUser`, que exige `active = 1`) permite deixar a abertura pronta antes
 * de o funcionário começar a usar o sistema.
 */
export function permissionsForUser(userId: number): Set<string> {
  const row = getSqlite()
    .prepare('SELECT role_id FROM users WHERE id = ? AND deleted_at IS NULL')
    .get(userId) as { role_id: number } | undefined;
  return row ? permissionsForRole(row.role_id) : new Set();
}

/** Permissões do cargo — usado também quando a edição troca o cargo na mesma gravação. */
export function permissionsForRole(roleId: number): Set<string> {
  const keys = getSqlite()
    .prepare('SELECT permission_key FROM role_permissions WHERE role_id = ?')
    .all(roleId) as { permission_key: string }[];
  return new Set(keys.map((k) => k.permission_key));
}

/** Itens do menu que o usuário pode abrir (menu já filtrado por plano/capability). */
export function allowedStartupModules(
  menu: ModuleMenuItem[] | undefined,
  permissions: Set<string>,
): ModuleMenuItem[] {
  return (menu ?? []).filter((item) => !item.permission || permissions.has(item.permission));
}

/** Valida o payload vindo da tela antes de gravar. */
export function normalizeStartupInput(
  input: unknown,
  allowed: ModuleMenuItem[],
): { ok: true; value: StartupPref } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Preferência de abertura inválida.' };
  }
  const raw = input as Record<string, unknown>;
  const enabled = raw.enabled === true;
  const fullscreen = raw.fullscreen !== false;
  const moduleHref = typeof raw.moduleHref === 'string' ? raw.moduleHref.trim().slice(0, 200) : '';

  if (enabled && !moduleHref) {
    return { ok: false, error: 'Escolha o módulo que deve abrir.' };
  }
  if (enabled && !allowed.some((item) => item.href === moduleHref)) {
    return { ok: false, error: 'Este usuário não tem acesso ao módulo escolhido.' };
  }
  return { ok: true, value: { enabled, moduleHref, fullscreen } };
}

/**
 * Middleware de toda página: entrega ao `theme-init` a preferência já validada para o
 * usuário da sessão. `null` no login e para quem está desligado, então o script do
 * cliente não faz nada.
 */
export function startupLocals(req: Request, res: Response, next: NextFunction): void {
  res.locals.startup = null;
  if (!req.user || req.path.startsWith('/api/')) {
    next();
    return;
  }
  try {
    const pref = getStartupPref(req.user.id);
    if (!pref.enabled || !pref.moduleHref) {
      next();
      return;
    }
    const allowed = allowedStartupModules(
      res.locals.moduleMenu as ModuleMenuItem[] | undefined,
      req.user.permissions,
    );
    if (allowed.some((item) => item.href === pref.moduleHref)) {
      res.locals.startup = {
        enabled: true,
        href: pref.moduleHref,
        fullscreen: pref.fullscreen,
      };
    }
  } catch {
    // Sem a coluna/tabela (instalação no meio de migration) o Kivo abre normal.
  }
  next();
}
