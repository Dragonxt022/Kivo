/**
 * Roda um teste de integração contra um banco SQLite descartável.
 *
 * Existe porque os testes de integração apagam e recriam o banco que usarem, e o
 * caminho padrão (database/kivo.db) é o MESMO que o `npm run dev` usa — rodar um
 * teste direto destruía os dados locais de quem estava desenvolvendo.
 *
 * Não dá para o próprio teste resolver isso setando process.env no topo do arquivo:
 * `import` é hoisted, então core/database/connection.ts lê KIVO_DB_PATH antes de
 * qualquer linha do teste rodar. A variável precisa existir no ambiente ANTES do
 * processo começar — que é o que este runner faz.
 *
 * Uso: node scripts/test-isolated.js src/tests/algum-teste.ts
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const target = process.argv[2];
if (!target) {
  console.error('Uso: node scripts/test-isolated.js <arquivo-de-teste.ts>');
  process.exit(1);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kivo-test-'));
const dbPath = path.join(tmpDir, 'test.db');

console.log(`[test-isolated] banco descartável: ${dbPath}`);

const result = spawnSync('npx', ['tsx', target], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, KIVO_DB_PATH: dbPath },
});

// Limpa o temporário mesmo se o teste quebrou — ninguém quer catar isto depois.
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
  console.warn(`[test-isolated] não consegui apagar ${tmpDir} (arquivo em uso?)`);
}

process.exit(result.status ?? 1);
