/**
 * Zera o banco do Katsu Cloud para o estado de fábrica: apaga todos os dados de
 * negócio (empresas, syncs, cobranças, backups, imagens, dispositivos) e deixa
 * um único admin `admin` / `admin`.
 *
 * Uso: npm run reset -- --yes
 *
 * O que NÃO é tocado:
 *  - o schema (as tabelas continuam lá) e a tabela `_migrations`, senão o migrator
 *    tentaria reaplicar tudo por cima de tabelas que já existem;
 *  - qualquer banco que não seja local, a menos que se passe --force (ver assertLocal).
 *
 * É destrutivo e não tem volta: exige --yes explícito.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getPool, closePool } from './db';
import { hashPassword } from './adminAuth';

const DEFAULT_ADMIN = { username: 'admin', password: 'admin' };

/** Ordem importa: filhas antes das mães, senão as FKs barram o DELETE. */
const DATA_TABLES = [
  'sync_records',
  'cloud_backups',
  'charges',
  'company_devices',
  'menu_items',
  'catalog_images',
  'companies',
  'app_settings',
];

const STORAGE_DIRS = [
  path.resolve(__dirname, '..', 'storage', 'backups'),
  path.resolve(__dirname, '..', 'storage', 'catalog'),
];

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Trava de segurança: a config de banco vem de env, então este mesmo script
 * apontado para a VPS apagaria a produção. Só passa em host local — ou com --force
 * explícito, para quem realmente quer zerar um banco remoto de teste.
 */
function assertLocal(force: boolean): void {
  const host = process.env.CLOUD_DB_HOST ?? '127.0.0.1';
  const database = process.env.CLOUD_DB_NAME ?? 'katsu_cloud';
  if (LOCAL_HOSTS.has(host) || force) return;
  console.error(
    `Recusado: CLOUD_DB_HOST="${host}" não é local (banco "${database}").\n` +
      'Se você realmente quer zerar esse banco, repita com --force.',
  );
  process.exit(1);
}

/** Esvazia as pastas de storage sem remover as pastas em si. */
function clearStorage(): number {
  let removed = 0;
  for (const dir of STORAGE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

export async function resetDatabase(): Promise<Record<string, number>> {
  const pool = getPool();
  const deleted: Record<string, number> = {};
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const table of DATA_TABLES) {
      const [res] = await conn.query(`DELETE FROM \`${table}\``);
      deleted[table] = (res as { affectedRows: number }).affectedRows;
    }
    // Recria o admin padrão junto, na mesma transação: um banco sem nenhum admin
    // tranca o painel para fora.
    await conn.query('DELETE FROM admin_users');
    await conn.query('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)', [
      DEFAULT_ADMIN.username,
      hashPassword(DEFAULT_ADMIN.password),
    ]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return deleted;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');

  if (!args.includes('--yes')) {
    console.error(
      'Isto APAGA todos os dados do banco (empresas, syncs, cobranças, backups, imagens)\n' +
        `e deixa só o admin "${DEFAULT_ADMIN.username}" / "${DEFAULT_ADMIN.password}". Não tem desfazer.\n\n` +
        'Confirme com:  npm run reset -- --yes',
    );
    process.exitCode = 1;
    return;
  }

  assertLocal(force);

  const database = process.env.CLOUD_DB_NAME ?? 'katsu_cloud';
  const host = process.env.CLOUD_DB_HOST ?? '127.0.0.1';
  console.log(`Zerando "${database}" em ${host}…`);

  const deleted = await resetDatabase();
  for (const [table, n] of Object.entries(deleted)) {
    console.log(`  ${String(n).padStart(6)}  ${table}`);
  }

  const files = clearStorage();
  console.log(`  ${String(files).padStart(6)}  arquivos de storage`);
  console.log(`\nPronto. Admin: ${DEFAULT_ADMIN.username} / ${DEFAULT_ADMIN.password}`);
  await closePool();
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error(err);
    await closePool();
    process.exit(1);
  });
}
