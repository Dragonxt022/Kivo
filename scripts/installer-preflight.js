/**
 * Preflight do instalador: garante que a máquina está num estado em que a instalação
 * consegue terminar sozinha.
 *
 * Os dois problemas que este script evita acontecem ANTES de o instalador NSIS rodar:
 *
 * 1) Um `Kivo.exe` (ou o instalador anterior) ainda em execução segura arquivos do diretório
 *    de instalação. O NSIS então para em "Não é possível fechar o Kivo / Feche a janela do
 *    Kivo e clique em Repetir" — a caixa que trava o instalador no meio do caminho. Um Kivo
 *    em erro de boot é o pior caso: sem janela visível, sem log para o lojista, e ainda
 *    segurando o processo. Encerrar antes é o que faz o instalador seguir sozinho.
 *
 * 2) O binário nativo com ABI errado. Este script NÃO conserta isso (quem conserta é
 *    `npm run rebuild:electron`), mas avisa agora, em vez de deixar o build terminar e o
 *    defeito só aparecer no computador do cliente.
 *
 * Uso: node scripts/installer-preflight.js
 */
const { spawnSync } = require('node:child_process');

const EXECUTAVEIS = ['Kivo.exe', 'Kivo Setup.exe', 'Kivo-Setup-2.1.1.exe'];

/** Mesmo caminho que o `build/installer.nsh` usa: `tasklist`, sem plugin nativo. */
function processoEmExecucao(imagem) {
  const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${imagem}`, '/NH', '/FO', 'CSV'], {
    encoding: 'utf8',
    shell: false,
  });
  if (r.status !== 0 || !r.stdout) return false;
  return r.stdout.toLowerCase().includes(imagem.toLowerCase());
}

function encerrar(imagem) {
  // /F porque um app travado no boot não responde ao fechamento educado — e é exatamente
  // esse o caso que deixa o instalador preso.
  spawnSync('taskkill', ['/F', '/IM', imagem, '/T'], { stdio: 'ignore', shell: false });
}

let encerrou = 0;
for (const imagem of EXECUTAVEIS) {
  if (!processoEmExecucao(imagem)) continue;
  console.log(`[preflight] ${imagem} em execução — encerrando antes de instalar…`);
  encerrar(imagem);
  encerrou += 1;
}

if (encerrou > 0) {
  // O Windows leva um instante para liberar os arquivos depois do kill. Espera síncrona
  // simples de propósito: este script é CLI e não tem mais nada para fazer enquanto isso.
  const ate = Date.now() + 2500;
  while (Date.now() < ate) {
    // aguarda a liberação dos arquivos pelo SO
  }
  console.log(`[preflight] ${encerrou} processo(s) encerrado(s).`);
} else {
  console.log('[preflight] nenhum Kivo em execução. OK.');
}

// Aviso, não bloqueio: o `verify:native` é quem falha de verdade. Aqui só queremos que o
// motivo apareça cedo no log do build, junto do resto do preflight.
const abi = spawnSync(process.execPath, [require('node:path').join(__dirname, 'verify-native-abi.js')], {
  stdio: 'inherit',
});

if (abi.status !== 0) {
  console.error(
    '\n[preflight] O módulo nativo não carrega sob o Electron. O instalador gerado agora\n' +
      'sairia quebrado (app não abre / instalador trava no cliente).\n' +
      'Rode `npm run rebuild:electron` e repita — e não rode `npm run dev` no meio do build.\n',
  );
  process.exit(1);
}
