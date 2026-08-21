/**
 * kivo CLI — entry point for all project commands.
 *
 * Usage:
 *   node scripts/kivo              list commands
 *   node scripts/kivo <name>       run command
 *   node scripts/kivo test         run all tests
 *   node scripts/kivo test:fase1   run specific test
 */

const { execSync } = require('child_process');
const { readFileSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '..');
const commands = JSON.parse(readFileSync(join(__dirname, 'commands.json'), 'utf-8'));

const isWin = process.platform === 'win32';

function shell() {
  return isWin ? 'cmd.exe' : '/bin/sh';
}

/**
 * PATH com `node_modules/.bin` na frente.
 *
 * Os comandos de commands.json chamam os binários pelo nome (`tsx`, `eslint`, `prettier`,
 * `electron-builder`). Quando o CLI roda por `npm run kivo`, o npm já põe `.bin` no PATH e
 * tudo resolve; rodando `node scripts/kivo <cmd>` — que o README documenta como forma
 * válida — não põe, e o comando morre com "'tsx' não é reconhecido". As duas formas
 * precisam se comportar igual.
 */
function envComBin() {
  const bin = join(ROOT, 'node_modules', '.bin');
  const sep = isWin ? ';' : ':';
  const atual = process.env.PATH ?? process.env.Path ?? '';
  return { ...process.env, PATH: `${bin}${sep}${atual}` };
}

function run(cmd, label) {
  if (!cmd) return;
  const prefix = label ? `[${label}] ` : '';
  console.log(`\n${prefix}$ ${cmd}\n`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', shell: shell(), env: envComBin() });
}

function listCommands() {
  const groups = {
    Desenvolvimento: [
      'dev',
      'dev:electron',
      'build',
      'rebuild:electron',
      'verify:native',
      'dist:win',
      'release:win',
    ],
    Qualidade: ['lint', 'format'],
    Banco: ['db:migrate', 'db:rollback', 'db:reset', 'db:seed:demo', 'db:status'],
    Testes: [
      'test',
      'test:shared',
      'test:fase1',
      'test:fase1b',
      'test:fase3',
      'test:fase3b',
      'test:fase3c',
      'test:fase4',
      'test:fase5',
      'test:fase5b',
      'test:fase5c',
      'test:fase5d',
      'test:fase6a',
      'test:fase6b',
      'test:fase6c',
      'test:fase6d',
      'test:fase7a',
      'test:fase7b',
      'test:fase7c',
      'test:fase7d',
      'test:fase7e',
      'test:fase7f',
      'test:fase8',
      'test:fase8b',
      'test:capabilities',
      'test:variants',
      'test:complementos',
      'test:kits',
      'test:producao',
      'test:foodservice',
      'test:comandas',
      'test:pdv-tipos',
      'test:onboarding',
      'test:products-import',
    ],
    Nuvem: ['cloud:install', 'cloud:migrate', 'cloud:dev', 'cloud:deploy'],
    Utilitário: ['smoke', 'postinstall'],
  };

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  console.log(`kivo CLI v${pkg.version}\n`);

  for (const [group, names] of Object.entries(groups)) {
    console.log(`  ${group}:`);
    for (const name of names) {
      const cmd = commands[name];
      if (cmd) {
        console.log(`    ${name.padEnd(22)} ${cmd.description}`);
      }
    }
    console.log();
  }

  console.log(`  Dica: node scripts/kivo <comando>`);
  console.log(`        npm run kivo <comando>\n`);
}

function runTestAll() {
  return require('./test-runner').runAll();
}

/**
 * Testes rodam sob o Node do sistema (via `tsx`), nunca sob o Electron — mas compartilham
 * o mesmo `node_modules`, e o `better-sqlite3` é nativo. Quem acabou de rodar
 * `dev:electron` ou `dist:win` deixa o binário compilado para o ABI do Electron, e aí
 * TODO teste que abre banco morre com ERR_DLOPEN_FAILED — 41 de 48, num relatório que
 * parece o projeto inteiro quebrado em vez de um binário no ABI errado.
 *
 * `dev` já se protegia com este mesmo pre-hook; `test`/`smoke` não, porque `kivo test` é
 * tratado antes do dispatch por commands.json e os `test:*` não declaravam `pre`. Fica
 * aqui, num ponto só, cobrindo as duas rotas. Sem rebuild se o ABI já estiver certo.
 */
function ensureNodeAbi() {
  run(`node ${JSON.stringify(join(__dirname, 'ensure-native-abi.js'))} node`, 'pre');
  // O test-runner refaz a sondagem quando chamado direto; já conferimos aqui.
  process.env.KIVO_ABI_OK = '1';
}

function needsNodeAbi(arg) {
  return arg === 'test' || arg === 'smoke' || arg.startsWith('test:');
}

async function main() {
  const arg = process.argv[2];

  if (!arg) {
    listCommands();
    return;
  }

  if (needsNodeAbi(arg)) {
    try {
      ensureNodeAbi();
    } catch {
      process.exit(1);
    }
  }

  if (arg === 'test') {
    process.exit(await runTestAll());
    return;
  }

  const cmd = commands[arg];
  if (!cmd) {
    console.error(`Comando desconhecido: "${arg}"`);
    console.error(`Execute "node scripts/kivo" para listar os comandos disponíveis.`);
    process.exit(1);
  }

  try {
    if (cmd.pre) run(cmd.pre, 'pre');
    run(cmd.run, 'run');
    if (cmd.post) run(cmd.post, 'post');
  } catch {
    process.exit(1);
  }
}

main();
