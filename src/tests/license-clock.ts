/**
 * Testes do relógio na licença (core/license/service.ts).
 *
 * Regressão real: o Kivo era instalado num PC com a hora errada/adiantada e, ao corrigir
 * o relógio do Windows, a licença caía em `bloqueada` — o lojista via o modal de comprar
 * nova licença e não conseguia usar o sistema. O watermark de relógio continua sendo
 * gravado, mas não bloqueia mais; quando está no futuro ele é reancorado no horário atual.
 *
 * A integridade continua valendo: editar `valid_until`/plano no SQLite sem recalcular a
 * assinatura ainda bloqueia.
 *
 * Roda offline (sem Docker/cloud): SQLite temporário.
 */
import path from 'node:path';

process.env.KIVO_DB_PATH = path.resolve(process.cwd(), 'storage', 'temp', 'license-clock.db');
process.env.KIVO_MACHINE_ID = 'test-machine-license-clock';

/* eslint-disable @typescript-eslint/no-require-imports */
const { migrateUp } = require('../core/database/migrator');
const { runSeeds } = require('../core/database/seeds');
const { resetTestDb } = require('./resetTestDb');
const { setLicense, validateLicense } = require('../core/license/service');
const { getSqlite } = require('../core/database/connection');
/* eslint-enable @typescript-eslint/no-require-imports */

let failures = 0;
function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

const DAY_MS = 86_400_000;

async function main(): Promise<void> {
  resetTestDb();
  migrateUp();
  runSeeds();

  const realNow = Date.now;
  const futureMs = realNow() + 365 * DAY_MS;

  // Simula uma instalação/licença gravada com o relógio adiantado: o watermark fica um
  // ano no futuro, com assinatura de integridade válida para esse estado.
  Date.now = () => futureMs;
  try {
    setLicense('company-clock', 'key-clock', 'diamante', '2999-12-31 00:00:00');
  } finally {
    Date.now = realNow;
  }

  const afterClockFix = validateLicense();
  check('relógio corrigido para trás não bloqueia', afterClockFix.status === 'valida', `${afterClockFix.status}: ${afterClockFix.message}`);

  const healed = getSqlite().prepare('SELECT time_watermark, integrity_hmac FROM license LIMIT 1').get() as
    { time_watermark: number; integrity_hmac: string | null };
  check(
    'watermark futuro é reancorado no horário atual',
    healed.time_watermark != null && healed.time_watermark <= realNow() + 60_000,
    String(healed.time_watermark),
  );
  check('watermark reancorado mantém assinatura de integridade', !!healed.integrity_hmac);

  // Integridade continua protegida: mudar o plano no SQLite sem recalcular o HMAC bloqueia.
  getSqlite().prepare("UPDATE license SET plan = 'ouro' WHERE id = 1").run();
  const tampered = validateLicense();
  check('assinatura de integridade inválida ainda bloqueia', tampered.status === 'bloqueada', `${tampered.status}: ${tampered.message}`);

  if (failures) {
    console.log(`\nLicença x relógio: ${failures} FALHA(S)`);
    process.exit(1);
  }
  console.log('\nLicença x relógio: TODOS OS TESTES PASSARAM');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
