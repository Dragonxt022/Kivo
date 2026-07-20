import mysql from 'mysql2/promise';

let pool: mysql.Pool | null = null;

/** Pool MySQL do cloud/ (serviço deployável separado do Electron app). */
export function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.CLOUD_DB_HOST ?? '127.0.0.1',
      port: Number(process.env.CLOUD_DB_PORT ?? 3307),
      user: process.env.CLOUD_DB_USER ?? 'root',
      password: process.env.CLOUD_DB_PASSWORD ?? 'kivo',
      database: process.env.CLOUD_DB_NAME ?? 'kivo_cloud',
      waitForConnections: true,
      connectionLimit: 10,
      // Colunas DATETIME/TIMESTAMP como string "YYYY-MM-DD HH:MM:SS[.mmm]", não Date —
      // precisa bater exatamente com o formato de `datetime('now')` do SQLite no cliente.
      dateStrings: true,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = null;
}
