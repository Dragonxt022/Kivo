/**
 * Boot sem Electron (dev/teste): roda migrations e sobe a API local.
 * Com --smoke: sobe, testa /api/health e /api/hello, e encerra.
 */
import { migrateUp } from './core/database/migrator';
import { runSeeds } from './core/database/seeds';
import { createServer } from './core/server';
import { closeDb } from './core/database/connection';
import { refreshLicenseFromCloud } from './core/license/service';
import { createLogger } from './core/logger';

const log = createLogger('boot');

// Crash handlers pelo logger: são justamente as linhas que precisam sobreviver ao
// terminal fechado e ir para o arquivo. O resto deste arquivo continua em `console.log`
// de propósito — é saída de FERRAMENTA de linha de comando ("API local em…", resultado
// do smoke), não registro de operação do produto.
process.on('unhandledRejection', (reason) => {
  log.error('promessa rejeitada sem tratamento', reason);
});
process.on('uncaughtException', (err) => {
  log.error('exceção não capturada', err);
});

const PORT = Number(process.env.KIVO_PORT ?? 3123);
const smoke = process.argv.includes('--smoke');

async function main() {
  const applied = migrateUp();
  if (applied.length) console.log(`[db] migrations aplicadas: ${applied.join(', ')}`);
  runSeeds();
  await refreshLicenseFromCloud();

  const { app, modules } = await createServer();
  // Sem Electron o servidor escuta em todas as interfaces (padrão do `listen`), então o
  // acesso pela rede local já vale — a tela de Configurações lê isto para não pedir um
  // reinício que aqui não muda nada. No app empacotado quem decide é electron/main.ts.
  app.locals.lanAtivo = true;
  const server = app.listen(PORT, () => {
    console.log(`[kivo] API local em http://localhost:${PORT} — módulos: ${modules.length}`);
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
  log.error('falha no boot', err);
  process.exit(1);
});
