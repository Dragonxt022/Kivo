import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import * as schema from './schema';

const DB_DIR = path.resolve(process.cwd(), 'database');
const DB_PATH = process.env.KIVO_DB_PATH ?? path.join(DB_DIR, 'kivo.db');

let sqlite: Database.Database | null = null;

/** Conexão única (singleton) com o SQLite local. */
export function getSqlite(): Database.Database {
  if (!sqlite) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    sqlite = new Database(DB_PATH);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
  }
  return sqlite;
}

/** Instância Drizzle tipada sobre a conexão local. */
export function getDb() {
  return drizzle(getSqlite(), { schema });
}

export function closeDb(): void {
  sqlite?.close();
  sqlite = null;
}
