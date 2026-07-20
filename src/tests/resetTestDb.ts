/**
 * Garante isolamento entre execuções de testes in-process:
 * 1. Fecha a conexão singleton e apaga o arquivo SQLite (incl. WAL/SHM).
 * 2. (Chamar migrateUp + runSeeds separadamente.)
 * 3. Marca activated_at para desbloquear o gate requireActivation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { closeDb, getSqlite } from '../core/database/connection';

const DB_DIR = path.resolve(process.cwd(), 'database');

function unlinkWithRetry(fp: string, retries = 20): void {
  for (let i = 0; i < retries; i++) {
    try {
      fs.unlinkSync(fp);
      return;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'EBUSY' && i < retries - 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
        continue;
      }
      throw e;
    }
  }
}

/** Apaga o arquivo DB para que migrateUp() recrie tudo do zero. */
export function resetTestDb(): void {
  closeDb();
  const dbPath = process.env.KIVO_DB_PATH ?? path.join(DB_DIR, 'kivo.db');
  for (const ext of ['', '-wal', '-shm']) {
    const fp = dbPath + ext;
    if (fs.existsSync(fp)) unlinkWithRetry(fp);
  }
}

/**
 * Garante que a licença existe E está ativada, desbloqueando todas as
 * rotas da API (requireActivation no server.ts).
 * Chamar DEPOIS de migrateUp() + runSeeds().
 */
export function activateTestLicense(): void {
  const db = getSqlite();
  const row = db.prepare('SELECT id FROM license LIMIT 1').get() as { id: number } | undefined;
  if (!row) {
    db.prepare(`INSERT INTO license (machine_id, machine_id_version, activated_at) VALUES ('test', 1, datetime('now'))`).run();
  } else {
    db.prepare(`UPDATE license SET activated_at = datetime('now') WHERE activated_at IS NULL`).run();
  }
}
