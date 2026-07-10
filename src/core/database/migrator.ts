import fs from 'node:fs';
import path from 'node:path';
import { getSqlite } from './connection';

/**
 * Migrator do Katsu.
 * Fontes de migrations (contrato de módulo, KATSU_PLANO.md §4):
 *   1. drizzle/migrations/NNNN_nome/            → Core
 *   2. src/modules/<id>/migrations/NNNN_nome/   → módulos (Apps)
 * Cada migration é uma pasta com up.sql e down.sql, ordenada globalmente pelo nome.
 * Regra do projeto: toda tabela criada deve ter uma coluna `comment`
 * (TEXT NOT NULL) com DEFAULT descrevendo o objetivo da tabela.
 *
 * Caminhos relativos a __dirname (não a process.cwd()): funcionam tanto em dev
 * (tsx rodando de src/core/database/) quanto no app empacotado (rodando de
 * dist/core/database/ — dist/ espelha a mesma estrutura, ver scripts/copy-build-assets.js).
 */
const CORE_MIGRATIONS = path.resolve(__dirname, '..', '..', '..', 'drizzle', 'migrations');
const MODULES_DIR = path.resolve(__dirname, '..', '..', 'modules');

function ensureMetaTable(): void {
  getSqlite().exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      comment TEXT NOT NULL DEFAULT 'Controle interno do migrator: registra quais migrations já foram aplicadas neste banco.'
    );
  `);
}

/** name → pasta da migration, em todas as fontes. */
function discoverMigrations(): Map<string, string> {
  const found = new Map<string, string>();
  const scan = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      if (found.has(d.name)) throw new Error(`Migration duplicada: ${d.name}`);
      found.set(d.name, path.join(dir, d.name));
    }
  };
  scan(CORE_MIGRATIONS);
  if (fs.existsSync(MODULES_DIR)) {
    for (const m of fs.readdirSync(MODULES_DIR, { withFileTypes: true })) {
      if (m.isDirectory()) scan(path.join(MODULES_DIR, m.name, 'migrations'));
    }
  }
  return new Map([...found.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function appliedNames(): Set<string> {
  ensureMetaTable();
  const rows = getSqlite().prepare('SELECT name FROM _migrations ORDER BY name').all() as {
    name: string;
  }[];
  return new Set(rows.map((r) => r.name));
}

export function migrateUp(): string[] {
  const db = getSqlite();
  const applied = appliedNames();
  const executed: string[] = [];
  for (const [name, dir] of discoverMigrations()) {
    if (applied.has(name)) continue;
    const sql = fs.readFileSync(path.join(dir, 'up.sql'), 'utf8');
    // FK enforcement fica fora da transação de cada migration: rebuilds de tabela
    // (DROP + CREATE + RENAME, necessários pra alterar CHECK constraints no SQLite)
    // são bloqueados pelo FK check implícito do DROP TABLE quando já existem linhas
    // em outra tabela referenciando a que está sendo reconstruída. `foreign_keys` só
    // pode ser alternado fora de uma transação — por isso os pragmas ficam do lado
    // de fora do db.transaction(), não dentro do up.sql.
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
    })();
    db.pragma('foreign_keys = ON');
    executed.push(name);
  }
  return executed;
}

/** Reverte a última migration aplicada. */
export function migrateDown(): string | null {
  const db = getSqlite();
  ensureMetaTable();
  const last = db.prepare('SELECT name FROM _migrations ORDER BY name DESC LIMIT 1').get() as
    | { name: string }
    | undefined;
  if (!last) return null;
  const dir = discoverMigrations().get(last.name);
  if (!dir) throw new Error(`Pasta da migration não encontrada: ${last.name}`);
  const sql = fs.readFileSync(path.join(dir, 'down.sql'), 'utf8');
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(sql);
    db.prepare('DELETE FROM _migrations WHERE name = ?').run(last.name);
  })();
  db.pragma('foreign_keys = ON');
  return last.name;
}

export function migrationStatus(): { name: string; applied: boolean }[] {
  const applied = appliedNames();
  return [...discoverMigrations().keys()].map((name) => ({ name, applied: applied.has(name) }));
}
