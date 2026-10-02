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
// Documentação técnica interna (Markdown) servida em /admin/documentacao.
copyIfExists(path.join(SRC, 'docs'), path.join(DIST, 'docs'));

const modulesDir = path.join(SRC, 'modules');
if (fs.existsSync(modulesDir)) {
  // Módulo REMOVIDO de src/ não pode sobreviver como pasta em dist/: o loader acharia o
  // manifesto antigo e o carregaria de novo no app empacotado (módulo fantasma, com rotas
  // e menu que ninguém mais mantém). Removemos SÓ as pastas que não existem mais em src —
  // apagar dist/modules inteiro levaria junto o JS que o tsc acabou de compilar ali.
  const viventes = new Set(
    fs.readdirSync(modulesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name),
  );
  const distModules = path.join(DIST, 'modules');
  if (fs.existsSync(distModules)) {
    for (const entry of fs.readdirSync(distModules, { withFileTypes: true })) {
      if (entry.isDirectory() && !viventes.has(entry.name)) {
        fs.rmSync(path.join(distModules, entry.name), { recursive: true, force: true });
        console.log(`[copy-assets] módulo removido de dist: modules/${entry.name}`);
      }
    }
  }
  for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const moduleSrc = path.join(modulesDir, entry.name);
    const moduleDist = path.join(DIST, 'modules', entry.name);
    copyIfExists(path.join(moduleSrc, 'migrations'), path.join(moduleDist, 'migrations'));
    copyIfExists(path.join(moduleSrc, 'views'), path.join(moduleDist, 'views'));
  }
}

console.log('[copy-assets] concluído.');
