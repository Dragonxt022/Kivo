import { migrateUp } from '../src/core/database/migrator';
import { runSeeds } from '../src/core/database/seeds';
import { createServer } from '../src/core/server';
import { closeDb } from '../src/core/database/connection';
import { resetTestDb, activateTestLicense } from '../src/tests/resetTestDb';

const PORT = 3198;
const base = `http://localhost:${PORT}`;

async function main() {
  resetTestDb(); migrateUp(); runSeeds(); activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').match(/kivo_session=([^;]+)/);
  const r = await fetch(`${base}/api/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: `kivo_session=${cookie?.[1]}` },
    body: JSON.stringify({ username: 'vitima', name: 'vitima', password: 'Teste1234', roleSlug: 'caixa' }),
  });
  console.log('STATUS', r.status);
  console.log('BODY', await r.text());
  server.close(); closeDb();
}
main().catch((e) => { console.error('ERRO', e); process.exit(1); });
