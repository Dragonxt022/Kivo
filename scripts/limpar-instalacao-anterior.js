/**
 * Limpa residuos de instalacoes anteriores do Kivo antes de instalar/empacotar.
 *
 * O defeito que isto resolve (custou um dia inteiro de diagnostico):
 *
 * O instalador do electron-builder guarda o caminho da instalacao em
 * `HKCU\Software\{APP_GUID}` -> `InstallLocation`. Quando alguem apaga a pasta
 * `%LOCALAPPDATA%\Programs\Kivo` NA MAO -- em vez de desinstalar pelo Painel de Controle --
 * a chave fica para tras apontando para uma pasta que nao existe mais. Na instalacao
 * seguinte o instalador le essa chave, conclui que "ja existe uma instalacao", tenta
 * desinstalar a versao anterior primeiro, nao encontra o `Uninstall Kivo.exe`, e o laco de
 * tentativas termina nas duas caixas que o lojista ve:
 *
 *   1. "Nao e possivel fechar o Kivo. Feche a janela do Kivo e clique em Repetir."
 *   2. "Erro ao abrir o arquivo para gravacao: ...\Uninstall Kivo.exe"
 *
 * Nao e permissao de pasta (a pasta e gravavel) e nao e o app rodando (nao ha processo):
 * e o estado fantasma no registro. Este script remove esse estado.
 *
 * Uso:
 *   node scripts/limpar-instalacao-anterior.js          -> so relata
 *   node scripts/limpar-instalacao-anterior.js --apply  -> relata e remove
 */
const { execFileSync } = require('node:child_process');

const APLICAR = process.argv.includes('--apply');

/** GUID fixo do electron-builder (mesmo `appId`-derivado em todas as instalacoes do Kivo). */
const GUID = '441dbd0e-faad-5973-853f-e0ee9d98c769';
const CHAVE_APP = `HKCU\\Software\\${GUID}`;
const CHAVE_DESINSTALAR = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${GUID}`;

function reg(args) {
  try {
    return execFileSync('reg', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/** Le `InstallLocation` da chave do app. Vazio = nunca instalado. */
function installLocation() {
  const saida = reg(['query', CHAVE_APP, '/v', 'InstallLocation']);
  const m = /InstallLocation\s+REG_SZ\s+(.+)/i.exec(saida);
  return m ? m[1].trim() : '';
}

function pastaExiste(caminho) {
  if (!caminho) return false;
  try {
    return require('node:fs').existsSync(caminho);
  } catch {
    return false;
  }
}

function desinstaladorExiste(caminho) {
  return caminho ? require('node:fs').existsSync(require('node:path').join(caminho, 'Uninstall Kivo.exe')) : false;
}

const local = installLocation();
const problemas = [];

if (local) {
  if (!pastaExiste(local)) {
    problemas.push(`InstallLocation aponta para uma pasta que NAO existe: ${local}`);
  } else if (!desinstaladorExiste(local)) {
    problemas.push(`a pasta existe mas o desinstalador sumiu: ${local}\\Uninstall Kivo.exe`);
  }
}

if (problemas.length === 0) {
  console.log('[limpeza] nenhum residuo de instalacao anterior. OK.');
  process.exit(0);
}

for (const p of problemas) console.log(`[limpeza] residuo encontrado: ${p}`);

if (!APLICAR) {
  console.log('[limpeza] rode com --apply para remover (o instalador limpa isto sozinho no build).');
  process.exit(0);
}

// Encerra qualquer Kivo pendurado ANTES de mexer no registro: um processo em erro de boot
// segura arquivos da pasta e faz a proxima instalacao falhar na gravacao.
try {
  execFileSync('taskkill', ['/F', '/IM', 'Kivo.exe', '/T'], { stdio: 'ignore' });
} catch {
  // sem processo rodando: nada a fazer
}

for (const chave of [CHAVE_APP, CHAVE_DESINSTALAR]) {
  try {
    execFileSync('reg', ['delete', chave, '/f'], { stdio: 'ignore' });
    console.log(`[limpeza] chave removida: ${chave}`);
  } catch {
    // chave inexistente
  }
}

console.log('[limpeza] pronto: a proxima instalacao sera tratada como instalacao limpa.');
