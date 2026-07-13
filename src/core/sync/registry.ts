import type { RegisteredSyncTable, SyncTableSpec } from './types';

/**
 * Registro central de tabelas sincronizáveis (KATSU_PLANO.md §6).
 * Módulos declaram `syncTables` no manifesto; o loader agrega aqui — o Core nunca
 * precisa conhecer as tabelas de um App específico (mesmo padrão de `permissions`/`menu`).
 */
const tables = new Map<string, RegisteredSyncTable>();

/** Hook de recomputo local (ex.: refazer stock_qty a partir do ledger mesclado). */
type RecomputeHook = (affectedLocalIds: number[]) => void | Promise<void>;
const recomputeHooks = new Map<string, RecomputeHook>();

export function registerSyncTables(moduleId: string, specs?: SyncTableSpec[]): void {
  for (const spec of specs ?? []) {
    const entityType = `${moduleId}.${spec.table}`;
    if (tables.has(entityType)) throw new Error(`Tabela de sync já registrada: ${entityType}`);
    tables.set(entityType, { ...spec, entityType, moduleId });
  }
}

export function getSyncTables(): RegisteredSyncTable[] {
  return [...tables.values()];
}

export function getSyncTableByName(table: string): RegisteredSyncTable | undefined {
  return [...tables.values()].find((t) => t.table === table);
}

/** Registrado no `setup` do módulo dono da tabela (ex.: commercial registra o recompute de stock_movements). */
export function registerRecomputeHook(table: string, hook: RecomputeHook): void {
  recomputeHooks.set(table, hook);
}

export function getRecomputeHook(table: string): RecomputeHook | undefined {
  return recomputeHooks.get(table);
}

/** Uso em testes/reload. */
export function clearSyncRegistry(): void {
  tables.clear();
  recomputeHooks.clear();
}
