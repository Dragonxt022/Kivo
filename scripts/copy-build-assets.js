/**
 * Copia para dist/ os artefatos que o `tsc` não compila (SQL de migrations, views EJS,
 * assets públicos), espelhando a mesma estrutura de pastas de src/ (só sem o prefixo
 * "src"). Isso é o que permite que o Core resolva esses caminhos via `__dirname`
 * relativo tanto em dev (rodando de src/) quanto no app empacotado (rodando de dist/) —
 * ver src/core/modules/loader.ts, src/core/server.ts, src/core/database/migrator.ts.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

function copyIfExists(from, to) {
  if (!fs.existsSync(from)) return;
  // Espelha de verdade: sem limpar `to` antes, pastas renomeadas/removidas em `from`
  // (ex.: migration renumerada) ficam para trás como "fantasmas" em dist/ — o migrator
  // as redescobre a cada boot como se fossem migrations novas e pendentes.
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  console.log(`[copy-assets] ${path.relative(ROOT, from)} -> ${path.relative(ROOT, to)}`);
}

copyIfExists(path.join(SRC, 'views'), path.join(DIST, 'views'));
copyIfExists(path.join(SRC, 'public'), path.join(DIST, 'public'));

const modulesDir = path.join(SRC, 'modules');
if (fs.existsSync(modulesDir)) {
  for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const moduleSrc = path.join(modulesDir, entry.name);
    const moduleDist = path.join(DIST, 'modules', entry.name);
    copyIfExists(path.join(moduleSrc, 'migrations'), path.join(moduleDist, 'migrations'));
    copyIfExists(path.join(moduleSrc, 'views'), path.join(moduleDist, 'views'));
  }
}

console.log('[copy-assets] concluído.');
