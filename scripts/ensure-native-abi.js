/**
 * Evita a causa raiz do erro "was compiled against a different Node.js version"
 * (NODE_MODULE_VERSION divergente): better-sqlite3 é um módulo nativo compilado, e este
 * projeto usa o MESMO node_modules tanto para dev via `tsx` (Node do sistema) quanto
 * para o app empacotado (Node embutido do Electron) — dois ABIs diferentes disputando
 * um único binário. Sem isso, alternar entre `npm run dev` e `npm run dev:electron` /
 * `dist:win` deixa o binário compilado para o ABI errado até alguém lembrar de rodar o
 * rebuild manual — que é exatamente como o bug chegou ao instalado do cliente.
 *
 * Uso: node scripts/ensure-native-abi.js <node|electron>
 * Roda como `pre`-hook de `dev`/`dev:electron`: testa se better-sqlite3 já carrega no
 * runtime alvo (rápido, sem rebuild se já estiver certo) e só reconstrói se precisar.
 */
const { spawnSync } = require('node:child_process');

const target = process.argv[2];
if (target !== 'node' && target !== 'electron') {
  console.error('Uso: node scripts/ensure-native-abi.js <node|electron>');
  process.exit(1);
}

const betterSqlite3Path = require.resolve('better-sqlite3');
const probeScript = `
  try {
    const Database = require(${JSON.stringify(betterSqlite3Path)});
    new Database(':memory:');
    process.exit(0);
  } catch (e) {
    process.exit(1);
  }
`;

function probe() {
  if (target === 'node') {
    return spawnSync(process.execPath, ['-e', probeScript], { stdio: 'ignore' }).status === 0;
  }
  const electronPath = require('electron');
  return (
    spawnSync(electronPath, ['-e', probeScript], {
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }).status === 0
  );
}

if (probe()) {
  console.log(`[ensure-native-abi] better-sqlite3 já compatível com ${target}. OK.`);
  process.exit(0);
}

console.log(`[ensure-native-abi] better-sqlite3 incompatível com ${target} — reconstruindo…`);
// shell: true é necessário no Windows para resolver npm.cmd/npx.cmd — seguro aqui
// porque os argumentos são literais fixos, nunca entrada externa.
const rebuild =
  target === 'node'
    ? spawnSync('npm', ['rebuild', 'better-sqlite3'], { stdio: 'inherit', shell: true })
    : spawnSync('npx', ['electron-rebuild', '-f', '-w', 'better-sqlite3'], { stdio: 'inherit', shell: true });

if (rebuild.status !== 0 || !probe()) {
  console.error(`[ensure-native-abi] Falha ao reconstruir better-sqlite3 para ${target}.`);
  process.exit(1);
}

console.log(`[ensure-native-abi] better-sqlite3 reconstruído para ${target}. OK.`);
