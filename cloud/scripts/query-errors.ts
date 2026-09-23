/**
 * Diagnóstico: imprime os erros de cliente mais recentes (message + stack) do cloud.
 * Uso: npm --prefix cloud exec tsx -r dotenv/config scripts/query-errors.ts
 */
import { getPool, closePool } from '../src/db';

async function main(): Promise<void> {
  const [rows] = await getPool().query(
    `SELECT scope, message, stack, occurrences, first_seen_at, last_seen_at, app_version, os
       FROM client_error_reports ORDER BY last_seen_at DESC LIMIT 25`,
  );
  for (const r of rows as Record<string, unknown>[]) {
    console.log('================================================================');
    console.log(`scope=${r.scope} | occ=${r.occurrences} | last=${r.last_seen_at} | ver=${r.app_version} | os=${r.os}`);
    console.log(`MSG: ${r.message}`);
    if (r.stack) console.log(`STACK:\n${r.stack}`);
    console.log('');
  }
  await closePool();
}

main().catch((e) => { console.error(e); process.exit(1); });
