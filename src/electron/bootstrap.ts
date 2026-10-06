/**
 * Entry point real do Electron (ver package.json "main"). Existe só para definir
 * `KIVO_DB_PATH` ANTES de qualquer módulo do Core ser carregado — `import` estático
 * do TypeScript é compilado para `require()` no topo do arquivo, então não dá para
 * "setar a env var antes do import" no mesmo arquivo que importa o Core. O `import()`
 * dinâmico abaixo adia a carga de `./main` (e, por consequência, de
 * `../core/database/connection`, que lê `KIVO_DB_PATH` uma única vez no topo do
 * módulo) até depois da env var estar definida.
 */
import { app, dialog } from 'electron';
import path from 'node:path';
import { loadEnvFiles } from '../core/config/env';
import { bootLog, bootLogFile } from './bootLog';

bootLog(`bootstrap: inicio (pid=${process.pid}, argv=${JSON.stringify(process.argv.slice(1))})`);

/**
 * `ELECTRON_RUN_AS_NODE` transforma o `electron .` num Node puro: o `require('electron')`
 * passa a devolver o CAMINHO do executável (string), não `{ app, BrowserWindow }`. Aí
 * `app.isPackaged` estoura com "Cannot read properties of undefined" e o processo morre
 * antes de qualquer log do Core — para quem chama, é "rodei e não abriu nada".
 *
 * A variável é usada legitimamente por scripts de build (`ensure-native-abi.js` roda o
 * binário do Electron como Node para testar o ABI) e escapa para o terminal com facilidade.
 * Detectar aqui transforma um erro ilegível numa instrução direta.
 */
if (!app) {
  const msg =
    'ELECTRON_RUN_AS_NODE está definida neste ambiente, então o Electron rodou como Node puro ' +
    'e o aplicativo não pôde iniciar.\n\n' +
    'Feche o terminal e abra um novo (a variável não é permanente) — ou remova-a e tente de novo:\n' +
    '  PowerShell:  Remove-Item Env:ELECTRON_RUN_AS_NODE\n' +
    '  Prompt:      set ELECTRON_RUN_AS_NODE=';
  bootLog('bootstrap: FALHA — require("electron") não devolveu o app (ELECTRON_RUN_AS_NODE definida?)');
  try {
    // `dialog` vem do mesmo `require('electron')` que devolveu o caminho (string) sob
    // ELECTRON_RUN_AS_NODE, então aqui ele é `undefined` — o `?.` evita estourar. Se por
    // acaso houver interface, a caixa aparece; se não, o boot.log acima é a única pista.
    dialog?.showErrorBox('Kivo — não foi possível iniciar', msg);
  } catch {
    // sem interface: o boot.log acima é a única pista
  }
  process.exit(1);
}

if (app.isPackaged) {
  process.env.KIVO_DB_PATH = path.join(app.getPath('userData'), 'database', 'kivo.db');
}

bootLog(
  `bootstrap: electron ok (isPackaged=${app.isPackaged}, versao=${app.getVersion()}, ` +
    `KIVO_DB_PATH=${process.env.KIVO_DB_PATH ?? '(cwd)'}, log=${bootLogFile()})`,
);

// Lê o `.env` (raiz do projeto em dev; raiz de dados/userData no app empacotado) ANTES de
// carregar o Core — `main` e `core/database/connection` leem `process.env` no topo.
loadEnvFiles();
bootLog('bootstrap: .env carregado — importando ./main');

void import('./main').then(
  () => bootLog('bootstrap: ./main carregado'),
  (err: unknown) => {
    // Sem isto, uma falha em `./main` era só uma promessa rejeitada: processo morto e
    // nenhuma pista em disco. É o caminho pelo qual o defeito de ABI do better-sqlite3
    // chegou ao cliente como "abri e não abriu".
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    bootLog(`ERRO FATAL ao carregar ./main: ${msg}`);
    try {
      dialog.showErrorBox('Kivo — falha ao iniciar', `${msg}\n\nDetalhes em: ${bootLogFile()}`);
    } catch {
      // sem interface: o boot.log acima é a única pista
    }
    process.exit(1);
  },
);

