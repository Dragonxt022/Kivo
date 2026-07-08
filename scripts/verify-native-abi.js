/**
 * Roda depois de `electron-rebuild` (rebuild:electron) e antes de empacotar
 * (dist:win/release:win): carrega better-sqlite3 dentro do Node embutido do próprio
 * Electron (via ELECTRON_RUN_AS_NODE) para confirmar que o binário nativo bate com o
 * NODE_MODULE_VERSION que o Electron espera.
 *
 * Sem isso, um `npm install` (ou qualquer coisa que reconstrua node_modules) depois do
 * rebuild — mas antes de empacotar — recompila better-sqlite3 contra o Node do sistema
 * e passa despercebido até o app empacotado quebrar no cliente com
 * "was compiled against a different Node.js version". Este script falha o build local
 * antes de publicar, em vez de deixar o erro chegar ao instalador.
 */
const { spawnSync } = require('node:child_process');

const electronPath = require('electron');
const betterSqlite3Path = require.resolve('better-sqlite3');

// better-sqlite3 só carrega o binário nativo na primeira instância de Database, não no
// require do módulo (lazy) — sem abrir um banco de verdade aqui, este script passaria
// mesmo com o .node ausente/incompatível, sem detectar nada.
const script = `
  try {
    const Database = require(${JSON.stringify(betterSqlite3Path)});
    new Database(':memory:');
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
`;

const result = spawnSync(electronPath, ['-e', script], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

if (result.status !== 0) {
  console.error(
    '\n[verify-native-abi] better-sqlite3 NÃO carrega sob o Node embutido do Electron.\n' +
      'Rode `npm run rebuild:electron` de novo (sem instalar/atualizar pacotes depois) antes de empacotar.\n',
  );
  process.exit(1);
}

console.log('[verify-native-abi] better-sqlite3 compatível com o Electron. OK.');
