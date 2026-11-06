/**
 * Entrada rápida por balões: padrão local e liberação consciente da rede.
 *
 * O comportamento seguro (só o teclado deste computador) não pode regredir, e a opção
 * `entradaRapidaRede` é o único caminho para um celular/tablet da rede ver os balões.
 */
import path from 'node:path';

// Diretório próprio para o machine-prefs.json deste teste não vazar para os outros.
process.env.KIVO_DB_PATH = path.resolve(process.cwd(), 'storage', 'temp', 'quick-login-network', 'test.db');

/* eslint-disable @typescript-eslint/no-require-imports */
const { getMachinePrefs, setMachinePrefs } = require('../core/config/machinePrefs');
const { canUseQuickLogin } = require('../core/auth/quickLogin');
/* eslint-enable @typescript-eslint/no-require-imports */

let failures = 0;
function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

function reqFrom(ip: string): unknown {
  return { ip, socket: { remoteAddress: ip } };
}

function main(): void {
  setMachinePrefs({ entradaRapidaRede: false });
  check('balões funcionam no próprio computador', canUseQuickLogin(reqFrom('127.0.0.1')) === true);
  check('IPv6 loopback também é local', canUseQuickLogin(reqFrom('::1')) === true);
  check('rede começa bloqueada por padrão', canUseQuickLogin(reqFrom('192.168.0.50')) === false,
    String(getMachinePrefs().entradaRapidaRede));

  setMachinePrefs({ entradaRapidaRede: true });
  check('preferência persiste', getMachinePrefs().entradaRapidaRede === true);
  check('rede liberada quando o dono liga', canUseQuickLogin(reqFrom('192.168.0.50')) === true);
  check('loopback continua funcionando', canUseQuickLogin(reqFrom('127.0.0.1')) === true);

  setMachinePrefs({ entradaRapidaRede: false });
  check('desligar volta a bloquear a rede', canUseQuickLogin(reqFrom('192.168.0.50')) === false);

  console.log(failures === 0 ? '\nEntrada rápida na rede: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
