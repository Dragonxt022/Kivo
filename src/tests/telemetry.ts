/**
 * Teste da telemetria do desktop: inventário de hardware, agregação local de erros por
 * fingerprint, o liga/desliga e o flush como no-op sem licença.
 *
 * KIVO_DB_PATH TEM que vir do ambiente:
 *   node scripts/test-isolated.js src/tests/telemetry.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite, closeDb } from '../core/database/connection';
import { settingsRepository } from '../core/repositories/SettingsRepository';
import { collectMachineInventory } from '../core/telemetry/hardware';
import { recordError, isTelemetryEnabled, flushTelemetry } from '../core/telemetry/service';

let failures = 0;
function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

function assertBancoDescartavel(): string {
  const alvo = process.env.KIVO_DB_PATH;
  if (!alvo) {
    throw new Error('KIVO_DB_PATH não definida. Rode via `node scripts/test-isolated.js src/tests/telemetry.ts`.');
  }
  if (path.resolve(alvo) === path.resolve(process.cwd(), 'database', 'kivo.db')) {
    throw new Error('Recusado: KIVO_DB_PATH aponta para o banco de dev.');
  }
  return alvo;
}

async function main(): Promise<void> {
  const dbPath = assertBancoDescartavel();
  fs.rmSync(dbPath, { force: true });
  migrateUp();
  runSeeds();
  const db = getSqlite();

  // ── Inventário de hardware ──
  const inv = collectMachineInventory({
    appVersion: '9.9.9',
    electronVersion: '36.0.0',
    screen: { width: 1920, height: 1080, scaleFactor: 1.25 },
    gpu: { status: 'enabled', software: false },
  });
  check('inventário traz OS, CPU e RAM', !!inv.os.platform && !!inv.cpu.model && inv.memory.totalGb > 0, `${inv.os.platform} / ${inv.cpu.cores} cores`);
  check('inventário usa os overrides do Electron', inv.versions.app === '9.9.9' && inv.screen?.width === 1920 && inv.gpu?.status === 'enabled');
  check('inventário tem locale/fuso', !!inv.locale.locale && !!inv.locale.timezone);

  // ── Liga por padrão ──
  check('telemetria ligada por padrão', isTelemetryEnabled() === true);

  // ── Agregação por fingerprint ──
  // Mesmo ponto de chamada (mesma stack) para o fingerprint bater.
  for (let i = 0; i < 2; i++) recordError('teste', 'falha X', new Error('boom'));
  const agg = db.prepare("SELECT occurrences FROM telemetry_errors WHERE message = 'falha X'").get() as { occurrences: number } | undefined;
  check('mesmo erro agrega occurrences', agg?.occurrences === 2, `occ=${agg?.occurrences}`);

  recordError('teste', 'falha Y');
  const total = (db.prepare('SELECT COUNT(*) c FROM telemetry_errors').get() as { c: number }).c;
  check('erros diferentes viram linhas diferentes', total === 2, `linhas=${total}`);

  const withStack = db.prepare("SELECT stack FROM telemetry_errors WHERE message = 'falha X'").get() as { stack: string | null } | undefined;
  check('stack do Error é preservada', !!withStack?.stack && withStack.stack.includes('boom'));

  // ── Desligar interrompe a gravação ──
  settingsRepository.set('telemetria.habilitada', '0');
  check('getBool reflete o desligamento', isTelemetryEnabled() === false);
  const before = (db.prepare('SELECT COUNT(*) c FROM telemetry_errors').get() as { c: number }).c;
  recordError('teste', 'falha Z');
  const after = (db.prepare('SELECT COUNT(*) c FROM telemetry_errors').get() as { c: number }).c;
  check('desligada não grava novo erro', after === before, `antes=${before} depois=${after}`);

  // ── Flush sem licença é no-op e não lança ──
  let threw = false;
  try {
    await flushTelemetry();
  } catch {
    threw = true;
  }
  check('flush sem licença não lança', !threw);

  closeDb();
  console.log(failures === 0 ? '\nTelemetria: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
