import Database from 'better-sqlite3';
import { getSqlite } from './connection';

export type Row = Record<string, unknown>;
export type Scalar = string | number | boolean | null;

export interface Pagination {
  offset?: number;
  limit?: number;
}

export interface FindOptions extends Pagination {
  orderBy?: string;
  orderDir?: 'ASC' | 'DESC';
}

export class BaseRepository<T extends Row = Row> {
  protected readonly table: string;

  constructor(table: string) {
    this.table = table;
  }

  protected get db(): Database.Database {
    return getSqlite();
  }

  protected cols(prefix?: string): string {
    return prefix ? `${prefix}.*` : '*';
  }

  protected notDeleted(alias?: string): string {
    const a = alias ? `${alias}.` : '';
    return `${a}deleted_at IS NULL`;
  }

  findById(id: number | string): T | undefined {
    return this.db
      .prepare(`SELECT ${this.cols()} FROM ${this.table} WHERE id = ? AND ${this.notDeleted()}`)
      .get(id) as T | undefined;
  }

  findByIdWithColumns(id: number | string, columns: string): T | undefined {
    return this.db
      .prepare(`SELECT ${columns} FROM ${this.table} WHERE id = ? AND ${this.notDeleted()}`)
      .get(id) as T | undefined;
  }

  findAll(opts: FindOptions = {}): T[] {
    const { orderBy = 'id', orderDir = 'ASC', offset, limit } = opts;
    let sql = `SELECT ${this.cols()} FROM ${this.table} WHERE ${this.notDeleted()} ORDER BY ${orderBy} ${orderDir}`;
    if (limit != null) sql += ` LIMIT ?`;
    if (offset != null) sql += ` OFFSET ?`;
    const params: unknown[] = [];
    if (limit != null) params.push(limit);
    if (offset != null) params.push(offset);
    return this.db.prepare(sql).all(...params) as T[];
  }

  findWhere(conditions: Record<string, Scalar>, opts: FindOptions = {}): T[] {
    const { orderBy = 'id', orderDir = 'ASC', offset, limit } = opts;
    const keys = Object.keys(conditions);
    const where = keys.map((k) => `${k} = ?`).join(' AND ');
    let sql = `SELECT ${this.cols()} FROM ${this.table} WHERE ${where} AND ${this.notDeleted()} ORDER BY ${orderBy} ${orderDir}`;
    const params: unknown[] = keys.map((k) => conditions[k]);
    if (limit != null) { sql += ` LIMIT ?`; params.push(limit); }
    if (offset != null) { sql += ` OFFSET ?`; params.push(offset); }
    return this.db.prepare(sql).all(...params) as T[];
  }

  findOneWhere(conditions: Record<string, Scalar>): T | undefined {
    const keys = Object.keys(conditions);
    const where = keys.map((k) => `${k} = ?`).join(' AND ');
    return this.db
      .prepare(`SELECT ${this.cols()} FROM ${this.table} WHERE ${where} AND ${this.notDeleted()} LIMIT 1`)
      .get(...keys.map((k) => conditions[k])) as T | undefined;
  }

  findIn(column: string, values: (string | number)[]): T[] {
    if (!values.length) return [];
    const ph = values.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT ${this.cols()} FROM ${this.table} WHERE ${column} IN (${ph}) AND ${this.notDeleted()}`)
      .all(...values) as T[];
  }

  searchLike(column: string, query: string, opts: FindOptions = {}): T[] {
    const { orderBy = column, orderDir = 'ASC', limit } = opts;
    let sql = `SELECT ${this.cols()} FROM ${this.table} WHERE ${column} LIKE ? AND ${this.notDeleted()} ORDER BY ${orderBy} ${orderDir}`;
    const params: unknown[] = [`%${query}%`];
    if (limit != null) { sql += ` LIMIT ?`; params.push(limit); }
    return this.db.prepare(sql).all(...params) as T[];
  }

  create(data: Partial<T> & Record<string, unknown>): number {
    const keys = Object.keys(data);
    const ph = keys.map(() => '?').join(', ');
    const info = this.db
      .prepare(`INSERT INTO ${this.table} (${keys.join(', ')}) VALUES (${ph})`)
      .run(...keys.map((k) => data[k] ?? null));
    return Number(info.lastInsertRowid);
  }

  update(id: number | string, data: Partial<T> & Record<string, unknown>): void {
    const keys = Object.keys(data);
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    this.db
      .prepare(`UPDATE ${this.table} SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
      .run(...keys.map((k) => data[k] ?? null), id);
  }

  updateWhere(conditions: Record<string, Scalar>, data: Partial<T> & Record<string, unknown>): void {
    const keys = Object.keys(conditions);
    const where = keys.map((k) => `${k} = ?`).join(' AND ');
    const dataKeys = Object.keys(data);
    const sets = dataKeys.map((k) => `${k} = ?`).join(', ');
    this.db
      .prepare(`UPDATE ${this.table} SET ${sets}, updated_at = datetime('now') WHERE ${where}`)
      .run(...dataKeys.map((k) => data[k] ?? null), ...keys.map((k) => conditions[k]));
  }

  softDelete(id: number | string): void {
    this.db
      .prepare(`UPDATE ${this.table} SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
      .run(id);
  }

  softDeleteWhere(conditions: Record<string, Scalar>): void {
    const keys = Object.keys(conditions);
    const where = keys.map((k) => `${k} = ?`).join(' AND ');
    this.db
      .prepare(`UPDATE ${this.table} SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE ${where}`)
      .run(...keys.map((k) => conditions[k]));
  }

  count(conditions?: Record<string, Scalar>): number {
    let sql = `SELECT COUNT(*) AS cnt FROM ${this.table} WHERE ${this.notDeleted()}`;
    const params: unknown[] = [];
    if (conditions) {
      const keys = Object.keys(conditions);
      sql += ` AND ${keys.map((k) => `${k} = ?`).join(' AND ')}`;
      params.push(...keys.map((k) => conditions[k]));
    }
    const row = this.db.prepare(sql).get(...params) as { cnt: number };
    return row.cnt;
  }

  exists(conditions: Record<string, Scalar>): boolean {
    return this.count(conditions) > 0;
  }

  transaction<TResult>(fn: () => TResult): TResult {
    return this.db.transaction(fn)();
  }

  raw(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  rawOne(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  rawRun(sql: string, ...params: unknown[]): Database.RunResult {
    return this.db.prepare(sql).run(...params);
  }
}
