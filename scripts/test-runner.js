/**
 * Test Runner — interface de progresso para a suíte de testes do Kivo.
 *
 * Uso:
 *   node scripts/test-runner.js                   roda a suíte inteira (mesma lista do `npm test`)
 *   node scripts/test-runner.js --only fase1,shared
 *                                                 roda apenas os testes cujo nome contém os termos
 *   node scripts/test-runner.js --plain           imprime a saída ao vivo, sem TUI
 *   node scripts/test-runner.js --verbose         após o resumo, imprime a saída completa de cada teste
 *
 * Em terminal interativo a TUI mostra, durante a execução, uma única linha viva
 * (reescrita com \r + \x1b[K — sem depender de mover o cursor para cima, o que
 * não funciona em todos os terminais):
 *   - barra de progresso (verde sem falhas, vermelha com falhas)
 *   - progresso: arquivos concluídos, percentual, falhas acumuladas, tempo
 *   - arquivo em execução + descrição (extraída do cabeçalho do teste) + duração
 *   - último check executado (linha PASS/FAIL do teste)
 * No final, imprime o resultado em lista: status por arquivo, contagem de
 * checks/falhas e detalhes das falhas. Sem TTY (CI) apenas espelha a saída
 * e mostra o mesmo resumo final.
 */
const { spawn, spawnSync } = require('node:child_process');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const isWin = process.platform === 'win32';
const FORCE_PLAIN = process.argv.includes('--plain') || process.argv.includes('-p');
const VERBOSE = process.argv.includes('--verbose');
const TTY = !FORCE_PLAIN && Boolean(process.stdout.isTTY);

/**
 * Testes puros (sem banco): rodam direto, sem o custo de criar um SQLite descartável.
 * Todo o resto passa pelo `test-isolated.js` (banco descartável por teste, para nunca
 * tocar no `database/kivo.db` de desenvolvimento).
 */
const PURE_TESTS = new Set(['shared.ts', 'testUtils.ts', 'products-import.ts']);

const SPIN = ['|', '/', '-', '\\'];

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function dye(text, code) {
  return TTY || process.env.FORCE_COLOR ? `${code}${text}${C.reset}` : text;
}

function flagValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function testFiles() {
  let files = readdirSync(join(ROOT, 'src', 'tests'))
    .filter((f) => f.endsWith('.ts') && f !== 'resetTestDb.ts' && !f.startsWith('e2e'))
    .sort();
  const only = flagValue('--only');
  if (only) {
    const pats = only
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    files = files.filter((f) => pats.some((p) => f.includes(p)));
  }
  return files;
}

function describeFile(file) {
  try {
    const src = readFileSync(join(ROOT, 'src', 'tests', file), 'utf-8');
    const m = src.match(/\/\*\*([\s\S]*?)\*\//);
    if (!m) return '';
    const line = m[1]
      .split('\n')
      .map((l) => l.replace(/^\s*\*\s?/, '').trim())
      .find(Boolean);
    return line ?? '';
  } catch {
    return '';
  }
}

function cmdFor(file) {
  const rel = join('src', 'tests', file);
  if (PURE_TESTS.has(file)) {
    return [process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), rel]];
  }
  return [process.execPath, [join('scripts', 'test-isolated.js'), rel]];
}

function truncate(s, n) {
  const t = s
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + '…';
}

function parseChecks(output) {
  const checks = [];
  for (const m of output.matchAll(/^(PASS|FAIL)\s+(.+)$/gm)) {
    checks.push({ ok: m[1] === 'PASS', label: m[2].trim() });
  }
  return checks;
}

function runOne(file, onLine, onExit) {
  const [cmd, args] = cmdFor(file);
  const child = spawn(cmd, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    ...(isWin ? {} : { detached: true }),
  });
  let buffer = '';
  let output = '';
  const errTail = [];
  const sink = (chunk, isErr) => {
    if (isErr) {
      for (const l of chunk.toString().split(/\r?\n/)) {
        if (l.trim()) {
          errTail.push(l);
          if (errTail.length > 6) errTail.shift();
        }
      }
    }
    output += chunk;
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) onLine(line);
  };
  child.stdout.on('data', (d) => sink(d, false));
  child.stderr.on('data', (d) => sink(d, true));
  child.on('error', (err) => onExit(output + '\n' + err.message, 1, errTail));
  child.on('close', (code) => {
    if (buffer.trim()) onLine(buffer);
    onExit(output, code === null ? 1 : code, errTail);
  });
  return child;
}

function pct(part, total) {
  return total === 0 ? 0 : Math.round((part / total) * 100);
}

function liveLine(state) {
  // Teto defensivo: nunca assumir largura maior que 130 — evita que uma linha
  // quebrada (wrap) impeça o redraw no lugar com \r\x1b[K.
  const cols = Math.min(process.stdout.columns || 110, 130);
  const elapsed = ((Date.now() - state.t0) / 1000).toFixed(1);
  const i = state.done.length + (state.current ? 1 : 0);
  const total = state.total;
  const fails =
    state.done.reduce((a, t) => a + t.checks.filter((ch) => !ch.ok).length, 0) +
    (state.current ? state.current.failCount : 0);
  const frac = i / total;
  const p = pct(i, total);

  const tailPlain = `${i}/${total} · ${fails} falha(s) · ${elapsed}s`;
  const barW = Math.max(8, Math.min(Math.floor(cols * 0.3), 48));
  const rightMax = Math.max(30, cols - barW - p.toString().length - 6);

  let runPlain = '';
  if (state.current) {
    const cur = state.current;
    const secs = ((Date.now() - cur.started) / 1000).toFixed(1);
    const fileT = truncate(cur.file, 20);
    const fixed = `${SPIN[state.spin % SPIN.length]} ${fileT} (${secs}s)`;
    const budget = rightMax - tailPlain.length - fixed.length - 4;
    if (cur.lastLine && budget > 14) {
      runPlain = `${fixed} · ${truncate(cur.lastLine, budget)}`;
    } else if (cur.desc && budget > 20) {
      runPlain = `${fixed} · ${truncate(cur.desc, budget)}`;
    } else if (cur.lastLine) {
      runPlain = `${SPIN[state.spin % SPIN.length]} ${truncate(cur.lastLine, Math.max(4, rightMax - tailPlain.length - 4))}`;
    } else {
      runPlain = fixed;
    }
  } else if (state.done.length < total) {
    runPlain = 'iniciando próximo teste…';
  } else {
    runPlain = 'concluído';
  }

  const filled = Math.round(barW * Math.max(0, Math.min(1, frac)));
  const bar = '█'.repeat(filled) + '░'.repeat(barW - filled);
  const barS = dye(bar, fails === 0 ? C.green : C.red);

  const line = `${barS} ${p}% · ${dye(runPlain, C.bold)} · ${dye(tailPlain, C.gray)}`;
  const plainLen = line.replace(/\x1b\[[0-9;]*m/g, '').length;
  if (plainLen > cols - 1) {
    const over = plainLen - (cols - 1) + 1;
    const rp = runPlain.replace(/\x1b\[[0-9;]*m/g, '');
    return `${barS} ${p}% · ${dye(truncate(rp, Math.max(4, rp.length - over)), C.bold)} · ${dye(tailPlain, C.gray)}`;
  }
  return line;
}

function renderLive(state) {
  process.stdout.write(`\r\x1b[K${liveLine(state)}`);
}

function clearLive() {
  process.stdout.write('\r\x1b[K');
}

function printSummary(state) {
  const cols = process.stdout.columns || 80;
  const sep = '━'.repeat(Math.min(cols, 62));
  const totalSecs = ((Date.now() - state.t0) / 1000).toFixed(1);
  const passed = state.done.filter((t) => t.ok).length;
  const failed = state.done.filter((t) => !t.ok);
  const allChecks = state.done.reduce((a, t) => a + t.checks.length, 0);
  const allFails = state.done.reduce((a, t) => a + t.checks.filter((ch) => !ch.ok).length, 0);

  console.log(`\n${sep}`);
  console.log(
    `  ${dye(`Resultado: ${passed}/${state.done.length} testes passaram`, C.bold)} · ${allChecks} checks · ${allFails} falha(s) · ${totalSecs}s`,
  );
  console.log(sep);
  for (const t of state.done) {
    const badge = t.ok ? dye('✓', C.green) : dye('✗', C.red);
    const status = t.ok ? dye('PASS', C.green) : dye('FAIL', C.red);
    const counts = `${t.checks.length} checks · ${t.checks.filter((ch) => !ch.ok).length} falhas`;
    console.log(
      `  ${badge} ${t.file.padEnd(28)} ${status}  ${dye(counts, C.dim)} ${dye(`(${t.secs.toFixed(1)}s)`, C.gray)}`,
    );
  }

  if (failed.length > 0) {
    console.log(`\n${dye('  Detalhes das falhas', C.red + C.bold)}`);
    for (const t of failed) {
      console.log(
        `\n  ${dye('✗ ' + t.file, C.red + C.bold)}${t.desc ? dye(' — ' + t.desc, C.dim) : ''}`,
      );
      for (const ch of t.checks.filter((ch) => !ch.ok))
        console.log(`      ${dye('FAIL', C.red)}  ${ch.label}`);
      if (t.code !== 0) console.log(`      ${dye(`processo saiu com código ${t.code}`, C.red)}`);
      if (t.errTail.length) {
        console.log(`      ${dye('saída de erro (últimas linhas):', C.dim)}`);
        for (const l of t.errTail) console.log(`        ${dye(truncate(l, cols - 10), C.gray)}`);
      }
    }
  }

  if (VERBOSE) {
    for (const t of state.done) {
      console.log(`\n${dye(`── saída de ${t.file} ──`, C.dim)}`);
      process.stdout.write(t.output.replace(/\n$/, '') + '\n');
    }
  }

  console.log(`\n${'─'.repeat(Math.min(cols, 62))}`);
  console.log(
    dye(
      failed.length === 0 ? '  Todos os testes passaram!' : `  ${failed.length} teste(s) falharam`,
      failed.length === 0 ? C.green : C.red + C.bold,
    ),
  );
}

async function runAll() {
  const files = testFiles();
  if (files.length === 0) {
    console.log('Nenhum teste encontrado em src/tests.');
    return 1;
  }

  const state = {
    t0: Date.now(),
    total: files.length,
    done: [],
    current: null,
    spin: 0,
    aborted: false,
  };
  if (!TTY) console.log(`Testes Kivo — ${files.length} arquivos\n`);

  let child = null;
  const tick = () => TTY && renderLive(state);
  const timer = TTY
    ? setInterval(() => {
        state.spin++;
        tick();
      }, 120)
    : null;

  process.on('SIGINT', () => {
    state.aborted = true;
    if (child && child.exitCode === null) {
      if (isWin) {
        try {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {}
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {}
        }
      }
    }
  });

  for (const file of files) {
    if (state.aborted) break;
    state.current = {
      file,
      desc: describeFile(file),
      started: Date.now(),
      lastLine: '',
      failCount: 0,
    };
    tick();
    await new Promise((resolve) => {
      child = runOne(
        file,
        (line) => {
          const l = line.trim();
          if (!l) return;
          if (TTY) {
            state.current.lastLine = l;
            if (/^FAIL\b/.test(l)) state.current.failCount++;
            tick();
          } else {
            process.stdout.write(l + '\n');
          }
        },
        (output, code, errTail) => {
          const checks = parseChecks(output);
          const secs = (Date.now() - state.current.started) / 1000;
          const ok = code === 0 && checks.every((ch) => ch.ok);
          state.done.push({
            file,
            desc: state.current.desc,
            code,
            ok,
            checks,
            secs,
            errTail,
            output,
          });
          state.current = null;
          if (!TTY) {
            const bad = checks.filter((ch) => !ch.ok).length;
            console.log(
              `\n  ${ok ? '✓' : '✗'} ${file} ${ok ? 'PASS' : 'FAIL'} (${checks.length} checks, ${bad} falhas)`,
            );
          }
          child = null;
          resolve();
        },
      );
    });
  }

  if (timer) clearInterval(timer);
  if (TTY) clearLive();
  printSummary(state);
  if (state.aborted) {
    console.log(dye('  Execução interrompida (Ctrl+C).', C.yellow));
    return 130;
  }
  return state.done.some((t) => !t.ok) ? 1 : 0;
}

async function main() {
  process.exit(await runAll());
}

if (require.main === module) main();

module.exports = { runAll, testFiles };
