import { getSqlite } from '../database/connection';

export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  pk: boolean;
  hasDefault: boolean;
}

interface PragmaRow {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: unknown;
}

/**
 * Introspecção genérica via `PRAGMA table_info`: um único caminho de código para as
 * tabelas de módulo (SQL cru) sem precisar tipar tudo em Drizzle. Nomes de tabela vêm
 * só de `SyncTableSpec` declarado em manifestos (config interna de confiança, nunca
 * de input do usuário) — interpolação direta é segura, mesmo padrão de `crud.ts`.
 */
const columnCache = new Map<string, ColumnInfo[]>();

export function tableColumns(table: string): ColumnInfo[] {
  if (columnCache.has(table)) return columnCache.get(table)!;
  const rows = getSqlite().prepare(`PRAGMA table_info(${table})`).all() as PragmaRow[];
  if (!rows.length) throw new Error(`Tabela não encontrada: ${table}`);
  const result = rows.map((r) => ({
    name: r.name,
    type: r.type,
    notNull: !!r.notnull,
    pk: !!r.pk,
    hasDefault: r.dflt_value != null,
  }));
  columnCache.set(table, result);
  return result;
}

export function getRowByUuid(table: string, uuid: string): Record<string, unknown> | undefined {
  return getSqlite().prepare(`SELECT * FROM ${table} WHERE uuid = ?`).get(uuid) as
    | Record<string, unknown>
    | undefined;
}

export function getRowById(table: string, id: number): Record<string, unknown> | undefined {
  return getSqlite().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

export function getUuidById(table: string, id: number | null): string | null {
  if (id == null) return null;
  const row = getSqlite().prepare(`SELECT uuid FROM ${table} WHERE id = ?`).get(id) as
    | { uuid: string }
    | undefined;
  return row?.uuid ?? null;
}

export function getIdByUuid(table: string, uuid: string | null): number | null {
  if (uuid == null) return null;
  const row = getSqlite().prepare(`SELECT id FROM ${table} WHERE uuid = ?`).get(uuid) as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

interface ForeignKeyListRow {
  from: string;
  table: string;
}

const fkCache = new Map<string, Map<string, string>>();

/** coluna -> tabela referenciada, via `PRAGMA foreign_key_list` (inclui FKs não declaradas no SyncTableSpec, ex.: `users`). */
export function foreignKeyTargets(table: string): Map<string, string> {
  if (fkCache.has(table)) return fkCache.get(table)!;
  const rows = getSqlite().prepare(`PRAGMA foreign_key_list(${table})`).all() as ForeignKeyListRow[];
  const result = new Map(rows.map((r) => [r.from, r.table]));
  fkCache.set(table, result);
  return result;
}

/** Qualquer id existente na tabela — usado só como placeholder de FK NOT NULL não sincronizada (ex.: cash_registers.opened_by). */
export function anyExistingId(table: string): number | null {
  const row = getSqlite().prepare(`SELECT id FROM ${table} LIMIT 1`).get() as { id: number } | undefined;
  return row?.id ?? null;
}
