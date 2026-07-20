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
const { readFileSync, readdirSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '..');
const commands = JSON.parse(readFileSync(join(__dirname, 'commands.json'), 'utf-8'));

const isWin = process.platform === 'win32';

function shell() {
  return isWin ? 'cmd.exe' : '/bin/sh';
}

function run(cmd, label) {
  if (!cmd) return;
  const prefix = label ? `[${label}] ` : '';
  console.log(`\n${prefix}$ ${cmd}\n`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', shell: shell() });
}

function listCommands() {
  const groups = {
    Desenvolvimento: ['dev', 'dev:electron', 'build', 'rebuild:electron', 'verify:native', 'dist:win', 'release:win'],
    Qualidade: ['lint', 'format'],
    Banco: ['db:migrate', 'db:rollback', 'db:reset', 'db:seed:demo', 'db:status'],
    Testes: ['test', 'test:shared', 'test:fase1', 'test:fase1b', 'test:fase3', 'test:fase3b', 'test:fase3c', 'test:fase4', 'test:fase5', 'test:fase5b', 'test:fase5c', 'test:fase5d', 'test:fase6a', 'test:fase6b', 'test:fase6c', 'test:fase6d', 'test:fase7a', 'test:fase7b', 'test:fase7c', 'test:fase7d', 'test:fase7e', 'test:fase7f', 'test:fase8', 'test:fase8b', 'test:capabilities', 'test:variants', 'test:complementos', 'test:kits', 'test:producao', 'test:foodservice', 'test:comandas'],
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
  const testsDir = join(ROOT, 'src', 'tests');
  const files = readdirSync(testsDir)
    .filter((f) => f.endsWith('.ts') && f !== 'resetTestDb.ts' && !f.startsWith('e2e'))
    .sort();

  let passed = 0;
  let failed = 0;

  for (const file of files) {
    const label = file.replace('.ts', '');
    console.log(`\n━━━ ${'='.repeat(60)}`);
    console.log(`  ${label}`);
    console.log(`━━━ ${'='.repeat(60)}\n`);
    try {
      run(`tsx src/tests/${file}`, label);
      console.log(`\n  ✓ ${label} PASS\n`);
      passed++;
    } catch {
      console.log(`\n  ✗ ${label} FAIL\n`);
      failed++;
    }
  }

  const total = passed + failed;
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`  ${passed}/${total} passed`);
  if (failed > 0) {
    console.log(`  ${failed} test(s) FAILED`);
    process.exit(1);
  }
}

function main() {
  const arg = process.argv[2];

  if (!arg) {
    listCommands();
    return;
  }

  if (arg === 'test') {
    runTestAll();
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
