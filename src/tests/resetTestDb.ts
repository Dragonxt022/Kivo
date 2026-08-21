/**
 * Garante isolamento entre execuções de testes in-process:
 * 1. Fecha a conexão singleton e apaga o arquivo SQLite (incl. WAL/SHM).
 * 2. (Chamar migrateUp + runSeeds separadamente.)
 * 3. Marca activated_at para desbloquear o gate requireActivation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { closeDb, getSqlite } from '../core/database/connection';
import { hashPassword } from '../core/auth/service';

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

/**
 * Tira a instalação do estado de PRIMEIRO ACESSO, sem trocar a credencial de fábrica.
 *
 * `isFirstRunSetupPending()` (core/auth/service.ts) é verdadeiro enquanto o banco tiver
 * exatamente UM usuário e ele for o `admin/admin` de fábrica — que é justo o estado que
 * `runSeeds()` deixa. Na home isso esconde o formulário de login e mostra o assistente de
 * primeiro acesso no lugar: os testes de navegador ficavam esperando para sempre por
 * `#login-user`, um elemento que nem chega a ser renderizado.
 *
 * Basta um segundo usuário para a condição cair, e `admin/admin` continua valendo — que é
 * o que os testes usam para entrar. Também é mais fiel à realidade: quando alguém está
 * cadastrando produto, a loja já passou do primeiro acesso há muito tempo.
 */
export function exitFirstRunState(): void {
  const db = getSqlite();
  const jaExiste = db
    .prepare(`SELECT id FROM users WHERE username = 'segundo_usuario_teste'`)
    .get() as { id: number } | undefined;
  if (jaExiste) return;
  const cargo = db.prepare(`SELECT id FROM roles WHERE name = 'Operador'`).get() as
    | { id: number }
    | undefined;
  if (!cargo) throw new Error('Cargo "Operador" não encontrado — runSeeds() rodou?');
  // `active = 0` e senha aleatória: este usuário existe só para o CONTADOR, ninguém entra
  // com ele. Quem autentica nos testes continua sendo o admin.
  db.prepare(
    `INSERT INTO users (username, name, password_hash, role_id, active, uuid)
     VALUES ('segundo_usuario_teste', 'Segundo Usuário (teste)', ?, ?, 0, ?)`,
  ).run(hashPassword(randomUUID()), cargo.id, randomUUID());
}
