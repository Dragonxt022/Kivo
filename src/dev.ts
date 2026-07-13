/**
 * Boot sem Electron (dev/teste): roda migrations e sobe a API local.
 * Com --smoke: sobe, testa /api/health e /api/hello, e encerra.
 */
import { migrateUp } from './core/database/migrator';
import { runSeeds } from './core/database/seeds';
import { createServer } from './core/server';
import { closeDb } from './core/database/connection';
import { refreshLicenseFromCloud } from './core/license/service';

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

const PORT = Number(process.env.KATSU_PORT ?? 3123);
const smoke = process.argv.includes('--smoke');

async function main() {
  const applied = migrateUp();
  if (applied.length) console.log(`[db] migrations aplicadas: ${applied.join(', ')}`);
  runSeeds();
  await refreshLicenseFromCloud();

  const { app, modules } = await createServer();
  const server = app.listen(PORT, () => {
    console.log(`[katsu] API local em http://localhost:${PORT} — módulos: ${modules.length}`);
  });

  if (smoke) {
    const base = `http://localhost:${PORT}`;
    const health = await fetch(`${base}/api/health`).then((r) => r.json());
    console.log('[smoke] health:', JSON.stringify(health));
    const helloAnon = await fetch(`${base}/api/hello`);
    console.log('[smoke] hello sem login (esperado 401):', helloAnon.status);
    server.close();
    closeDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
