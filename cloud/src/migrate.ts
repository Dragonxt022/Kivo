import fs from 'node:fs';
import path from 'node:path';
import { getPool, closePool } from './db';

/**
 * Migrator do cloud/ — mesmo contrato do Kivo local (pasta NNNN_nome com up.sql/down.sql,
 * tabela `_migrations` como controle), adaptado para MySQL/async.
 */
const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');

async function ensureMetaTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB;
  `);
}

function discoverMigrations(): Map<string, string> {
  const found = new Map<string, string>();
  if (!fs.existsSync(MIGRATIONS_DIR)) return found;
  for (const d of fs.readdirSync(MIGRATIONS_DIR, { withFileTypes: true })) {
    if (d.isDirectory()) found.set(d.name, path.join(MIGRATIONS_DIR, d.name));
  }
  return new Map([...found.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function appliedNames(): Promise<Set<string>> {
  await ensureMetaTable();
  const [rows] = await getPool().query('SELECT name FROM _migrations ORDER BY name');
  return new Set((rows as { name: string }[]).map((r) => r.name));
}

function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function migrateUp(): Promise<string[]> {
  const applied = await appliedNames();
  const executed: string[] = [];
  for (const [name, dir] of discoverMigrations()) {
    if (applied.has(name)) continue;
    const sql = fs.readFileSync(path.join(dir, 'up.sql'), 'utf8');
    const conn = await getPool().getConnection();
    try {
      await conn.beginTransaction();
      for (const stmt of splitStatements(sql)) await conn.query(stmt);
      await conn.query('INSERT INTO _migrations (name) VALUES (?)', [name]);
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    executed.push(name);
  }
  return executed;
}

export async function migrateDown(): Promise<string | null> {
  await ensureMetaTable();
  const [rows] = await getPool().query('SELECT name FROM _migrations ORDER BY name DESC LIMIT 1');
  const last = (rows as { name: string }[])[0];
  if (!last) return null;
  const dir = discoverMigrations().get(last.name);
  if (!dir) throw new Error(`Pasta da migration não encontrada: ${last.name}`);
  const sql = fs.readFileSync(path.join(dir, 'down.sql'), 'utf8');
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    for (const stmt of splitStatements(sql)) await conn.query(stmt);
    await conn.query('DELETE FROM _migrations WHERE name = ?', [last.name]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return last.name;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'up') {
    const executed = await migrateUp();
    console.log(executed.length ? `Migrations aplicadas: ${executed.join(', ')}` : 'Nada a aplicar.');
  } else if (cmd === 'down') {
    const reverted = await migrateDown();
    console.log(reverted ? `Revertida: ${reverted}` : 'Nada a reverter.');
  } else {
    console.error('Uso: tsx src/migrate.ts <up|down>');
    process.exitCode = 1;
  }
  await closePool();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
