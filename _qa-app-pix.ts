/**
 * Servidor do app para o teste ponta a ponta do Pix (arquivo temporário, fora de src/).
 * Aponta a licença para a empresa criada pelo _e2e-pix.js e sobe a API local.
 */
import { migrateUp } from './src/core/database/migrator';
import { runSeeds } from './src/core/database/seeds';
import { getSqlite } from './src/core/database/connection';
import { createServer } from './src/core/server';
import { activateTestLicense, exitFirstRunState, resetTestDb } from './src/tests/resetTestDb';

resetTestDb();
migrateUp();
runSeeds();
activateTestLicense();
exitFirstRunState();

const db = getSqlite();
db.prepare(
  `UPDATE license SET company_uuid = ?, license_key = ?, plan = 'diamante', valid_until = '2027-09-30 00:00:00.000' WHERE id = 1`,
).run(process.env.E2E_COMPANY, process.env.E2E_KEY);

createServer().then(({ app }) => {
  const port = Number(process.env.E2E_APP_PORT ?? 3200);
  app.listen(port, () => console.log(`[e2e-app] http://127.0.0.1:${port}`));
});
