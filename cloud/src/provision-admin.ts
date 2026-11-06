/**
 * Cria/atualiza um usuário do painel administrativo (Fase 6d).
 * Uso: tsx src/provision-admin.ts <username> <password>
 */
import { getPool, closePool } from './db';
import { hashPassword } from './adminAuth';

async function main(): Promise<void> {
  const [username, password] = process.argv.slice(2);
  if (!username || !password) {
    console.error('Uso: tsx src/provision-admin.ts <username> <password>');
    process.exitCode = 1;
    return;
  }
  await getPool().query(
    `INSERT INTO admin_users (username, password_hash) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
    [username, hashPassword(password)],
  );
  // Coloca o usuário no grupo Administrador quando a migration de grupos já rodou.
  await getPool()
    .query(
      `UPDATE admin_users
          SET role_id = COALESCE(role_id, (SELECT id FROM admin_roles WHERE slug = 'administrador'))
        WHERE username = ?`,
      [username],
    )
    .catch(() => {});
  console.log(`Admin provisionado: ${username}`);
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
