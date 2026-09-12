/**
 * Atualização forçada pelo suporte (comando `support.force_update`): verifica, baixa em
 * silêncio e deixa o instalador rodar ao fechar o Kivo — sem reiniciar no meio do uso.
 * Usa um driver falso, então não depende do Electron nem de rede.
 */
import { applyCommand } from '../core/sync/commands';
import {
  getUpdateState,
  patchUpdateState,
  registrarUpdaterDriver,
  forcarAtualizacaoSilenciosa,
} from '../core/updater';

let failures = 0;
function check(label: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

let verificou = 0;
let baixou = 0;

function instalarDriverFalso() {
  registrarUpdaterDriver({
    verificar: async () => {
      verificou++;
      patchUpdateState({ status: 'disponivel', versaoDisponivel: '9.9.9' });
    },
    baixar: async () => {
      baixou++;
      patchUpdateState({
        status: 'baixado',
        versaoDisponivel: '9.9.9',
        progresso: { percent: 100, transferido: 0, total: 0, bytesPorSegundo: 0 },
      });
    },
    instalar: () => {},
  });
  patchUpdateState({ suportado: true, motivo: null, status: 'ocioso', versaoDisponivel: null });
}

function esperar(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const comando = (id: number, kind: string) => ({ id, kind, payload: {}, created_by_user_uuid: 'x' });

async function main() {
  // Sem suporte (dev / plano sem auto-update): recusa com o motivo, sem agendar nada.
  instalarDriverFalso();
  patchUpdateState({ suportado: false, motivo: 'sem suporte no teste' });
  const semSuporte = applyCommand(comando(1, 'support.force_update'));
  check('sem suporte → erro com motivo', !semSuporte.ok && semSuporte.error.includes('sem suporte'));

  // Com suporte: o comando confirma na hora e, em segundo plano, verifica e baixa.
  instalarDriverFalso();
  verificou = 0;
  baixou = 0;
  const agendado = applyCommand(comando(2, 'support.force_update'));
  check('com suporte → aplicado com acao=atualizacao', agendado.ok && agendado.result.acao === 'atualizacao');
  await esperar(2500);
  check('verifica e baixa em segundo plano', verificou === 1 && baixou === 1, `verificar=${verificou} baixar=${baixou}`);
  check('estado final baixado (instala ao fechar)', getUpdateState().status === 'baixado');

  // Já baixado: não repete a verificação nem o download.
  verificou = 0;
  baixou = 0;
  const jaBaixado = await forcarAtualizacaoSilenciosa();
  check('já baixado → não repete', jaBaixado.ok && verificou === 0 && baixou === 0);

  // Comando desconhecido continua sendo erro (não trava a fila).
  const desconhecido = applyCommand(comando(3, 'nao.existe'));
  check('comando desconhecido → erro', !desconhecido.ok);

  console.log(failures === 0 ? '\nAtualização forçada: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
