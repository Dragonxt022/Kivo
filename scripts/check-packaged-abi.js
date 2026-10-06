/**
 * Guarda de ABI DO PACOTE — roda DEPOIS do electron-builder, sobre o que foi realmente
 * empacotado (`dist-installer/win-unpacked/resources/app.asar.unpacked/...`).
 *
 * Por que existe: `scripts/verify-native-abi.js` confere o `node_modules` do projeto, e o
 * projeto compartilha o MESMO `node_modules` entre `npm run dev` (Node do sistema) e o app
 * empacotado (Node embutido do Electron). Quem roda `npm run dev` depois de um `dist:win`
 * deixa `better_sqlite3.node` compilado para o ABI do Node; o próximo `dist:win` empacota
 * esse binário e o instalador sai quebrado — o app instalado morre no boot com
 * "NODE_MODULE_VERSION divergente" e o lojista vê dois sintomas que parecem não ter relação
 * (o Kivo não abre e o instalador fica preso em "não é possível fechar o Kivo", porque o
 * erro de boot segura o processo).
 *
 * A verificação aqui é a única que olha o artefato final: carrega o `.node` que está DENTRO
 * do pacote, sob o Node embutido do próprio Electron, e abre um banco em memória.
 *
 * Uso: node scripts/check-packaged-abi.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RECURSOS = path.join(ROOT, 'dist-installer', 'win-unpacked', 'resources');
/**
 * O caminho do módulo nativo depende do empacotamento: com `asar: true` ele vive em
 * `resources/app.asar.unpacked/node_modules`; sem asar (`asar: false`, o formato da 2.0.8),
 * fica direto em `resources/app/node_modules`. Testamos os dois para a verificação
 * continuar valendo independente da escolha — o que importa é checar o binário REAL que o
 * instalador empacotou.
 */
const CANDIDATOS = [
  path.join(RECURSOS, 'app.asar.unpacked', 'node_modules', 'better-sqlite3'),
  path.join(RECURSOS, 'app', 'node_modules', 'better-sqlite3'),
];
const MODULO = CANDIDATOS.find((c) => fs.existsSync(c));

if (!MODULO) {
  console.error(
    `[check-packaged-abi] não encontrei o better-sqlite3 empacotado. Procurei em:\n` +
      CANDIDATOS.map((c) => `  - ${c}`).join('\n') +
      '\nRode `npm run dist:win` antes — este script confere o que o instalador já empacotou.',
  );
  process.exit(1);
}

// O runtime de teste tem de ser o Electron INSTALADO no projeto (mesma versão que o
// electron-builder usou para montar o pacote) — é o ABI que o app instalado vai exigir.
const electronPath = require('electron');

const script = `
  try {
    const Database = require(${JSON.stringify(MODULO)});
    const db = new Database(':memory:');
    db.prepare('select 1 as n').get();
    db.close();
    console.log('[check-packaged-abi] ABI do pacote OK (modules=' + process.versions.modules + ', electron=' + process.versions.electron + ')');
    process.exit(0);
  } catch (e) {
    console.error('[check-packaged-abi] ' + e.message);
    process.exit(1);
  }
`;

const result = spawnSync(electronPath, ['-e', script], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

if (result.status !== 0) {
  console.error(
    '\n[check-packaged-abi] O binário nativo DENTRO do pacote NÃO carrega sob o Electron.\n' +
      'Este instalador sairia quebrado (o app não abre e o instalador trava no cliente).\n' +
      'Corrija com `npm run rebuild:electron` e rode `npm run dist:win` de novo — sem rodar\n' +
      '`npm run dev` no meio (ele recompila o módulo nativo para o Node do sistema).\n',
  );
  process.exit(1);
}
