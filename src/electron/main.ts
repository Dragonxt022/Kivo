import { app, BrowserWindow, dialog, Menu, nativeTheme } from 'electron';
import { autoUpdater } from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite } from '../core/database/connection';
import { refreshLicenseFromCloud, validateLicense } from '../core/license/service';
import { canAutoUpdate } from '../core/license/plans';
import { getMachinePrefs, setMachinePrefs, hardwareFraco } from '../core/config/machinePrefs';

/**
 * Modo leve desliga a aceleração de vídeo, e `disableHardwareAcceleration()` só vale se for
 * chamado ANTES de `app.whenReady()` — por isso está aqui no topo do módulo, e por isso a
 * preferência mora num JSON (machine-prefs.json) e não no SQLite: neste ponto as migrations
 * ainda não rodaram (`boot()` as executa) e o banco pode nem existir.
 *
 * Sem driver de vídeo o Chromium já cai para renderização por software, mas continua pagando
 * a tentativa de compositar na GPU; desligar explicitamente evita esse caminho.
 */
if (getMachinePrefs().modoLeve) {
  app.disableHardwareAcceleration();
}

function errorLogPath(): string {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'error.log');
  }
  return path.join(process.cwd(), 'error.log');
}

function appendErrorLog(msg: string): void {
  try {
    fs.appendFileSync(errorLogPath(), `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // best-effort
  }
}

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error('[unhandledRejection]', msg);
  appendErrorLog(`[unhandledRejection] ${msg}`);
});
process.on('uncaughtException', (err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error('[uncaughtException]', msg);
  appendErrorLog(`[uncaughtException] ${msg}`);
});

const PORT = Number(process.env.KIVO_PORT ?? 3123);

// Mesmo par light/dark já usado na logo da tela de login (home.ejs) — reaproveitado
// aqui pro ícone da janela/taskbar acompanhar o tema do Windows em tempo real.
const ICON_LIGHT = path.resolve(__dirname, '..', 'public', 'kivo_logo.png');
const ICON_DARK = path.resolve(__dirname, '..', 'public', 'logo_marca_branco.png');

function currentIconPath(): string {
  return nativeTheme.shouldUseDarkColors ? ICON_DARK : ICON_LIGHT;
}

/**
 * Sem isso, uma falha em `boot()` (ex.: erro de SQL) rejeita a promise silenciosamente —
 * o processo continua rodando (aparece no gerenciador de tarefas) mas nenhuma janela
 * chega a abrir, e não há console visível num app empacotado para ver o erro. Grava o
 * erro num arquivo em userData e mostra uma caixa de diálogo antes de encerrar.
 */
function reportFatalBootError(err: unknown): void {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  try {
    const logPath = path.join(app.getPath('userData'), 'boot-error.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, `${new Date().toISOString()}\n${message}\n`);
  } catch {
    // se nem isso funcionar, ao menos tenta mostrar o diálogo abaixo.
  }
  appendErrorLog(`[boot-error] ${message}`);
  dialog.showErrorBox('Kivo — falha ao iniciar', message);
  app.quit();
}

/**
 * Auto-update de verdade (substitui o esqueleto da Fase 0): checa Releases do
 * GitHub (owner/repo/provider vêm do "publish" em package.json — `npm run
 * release:win` publica lá). Só roda no app empacotado; em dev não há
 * app-update.yml e o electron-updater erraria à toa. Sem console visível num app
 * empacotado, os eventos vão para um log em userData.
 */
function setupAutoUpdater(): void {
  if (!app.isPackaged) return;
  if (!canAutoUpdate(validateLicense().plan)) return; // Prata/Trial: sem atualização automática.
  const logPath = path.join(app.getPath('userData'), 'update.log');
  const log = (msg: string) => {
    try {
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
    } catch {
      // log é best-effort — não deve derrubar o app.
    }
  };

  autoUpdater.autoDownload = true;
  autoUpdater.on('checking-for-update', () => log('verificando atualização...'));
  autoUpdater.on('update-available', (info) => log(`atualização disponível: ${info.version}`));
  autoUpdater.on('update-not-available', () => log('nenhuma atualização disponível.'));
  autoUpdater.on('error', (err) => log(`erro: ${err.message}`));
  autoUpdater.on('update-downloaded', (info) => {
    log(`atualização baixada: ${info.version} — perguntando ao usuário.`);
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Kivo — atualização disponível',
        message: `Uma nova versão (${info.version}) foi baixada. Reiniciar agora para instalar?`,
        buttons: ['Reiniciar agora', 'Depois'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });

  autoUpdater.checkForUpdates().catch((err) => log(`falha ao checar: ${err.message}`));
}

async function boot() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  Menu.setApplicationMenu(null);

  migrateUp();
  runSeeds();
  // O destino dos backups NÃO é semeado no banco: `backupDir()` deriva de `KIVO_DB_PATH`
  // (userData no app empacotado) a cada uso. Gravar o caminho absoluto aqui fazia ele
  // viajar junto num banco restaurado em outra máquina/outro perfil do Windows.
  // Antes de carregar os módulos (que decidem o que habilitar a partir do cache
  // local de licença): sem isso, mudar o plano/módulos no painel cloud só entrava em
  // vigor depois de um "Sincronizar agora" manual — reiniciar sozinho não bastava.
  await refreshLicenseFromCloud();
  const { app: api } = await createServer();
  // Desligado por padrão: só passa a escutar em todas as interfaces (alcançável pelo
  // celular do garçom / tablet da cozinha na mesma rede Wi-Fi/cabo) se o admin ligar
  // "Acesso pela rede local" em Configurações — mudança de porta/host exige reiniciar.
  const lanRow = getSqlite()
    .prepare("SELECT value FROM settings WHERE key = 'rede.acesso_local' AND deleted_at IS NULL")
    .get() as { value: string } | undefined;
  api.listen(PORT, lanRow?.value === '1' ? '0.0.0.0' : '127.0.0.1');

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    // Relativo a __dirname (não process.cwd()): dev resolve para src/public; app
    // empacotado resolve para dist/public (ver scripts/copy-build-assets.js).
    icon: currentIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.maximize();
  win.show();
  await win.loadURL(`http://localhost:${PORT}/`);

  // Acompanha o tema claro/escuro do Windows em tempo real (o ícone gravado no .exe
  // no build é fixo; isto troca o ícone da janela/taskbar enquanto o app está aberto).
  nativeTheme.on('updated', () => win.setIcon(currentIconPath()));

  detectarModoLeve(win, api);

  setupAutoUpdater();
}

/**
 * Liga o modo leve sozinho, uma única vez, quando a máquina é fraca.
 *
 * Roda depois de a janela aparecer para não atrasar o boot, e só se `modoLeveDetectado`
 * ainda for falso — depois de qualquer escolha (automática ou manual em Configurações) o
 * app nunca mais mexe nisso, senão desligar o modo leve numa máquina fraca seria impossível.
 *
 * `getGPUFeatureStatus()` exige o app pronto, daí não dar para consultá-lo lá em cima junto
 * de `disableHardwareAcceleration()`. Consequência aceita: na primeira execução a interface
 * fica leve imediatamente (o reload aplica o CSS), mas a GPU só é desligada no próximo
 * início — o aviso na tela diz isso.
 */
function detectarModoLeve(win: BrowserWindow, api: { locals: Record<string, unknown> }): void {
  if (getMachinePrefs().modoLeveDetectado) return;

  let gpuPorSoftware = false;
  try {
    const status = app.getGPUFeatureStatus() as unknown as Record<string, string>;
    // "disabled_software" / "unavailable_software": o Chromium desistiu da GPU e está
    // desenhando na CPU — exatamente o PC sem driver de vídeo que motivou o modo leve.
    gpuPorSoftware = ['gpu_compositing', '2d_canvas'].some((k) => (status?.[k] ?? '').includes('software'));
  } catch {
    // Plataforma que não expõe o status: decide só pelos sinais de CPU/RAM.
  }

  const leve = gpuPorSoftware || hardwareFraco();
  setMachinePrefs({ modoLeve: leve, modoLeveDetectado: true });
  if (!leve) return;

  api.locals.modoLeve = true;
  appendErrorLog(`[modo-leve] ativado automaticamente (gpuPorSoftware=${gpuPorSoftware})`);
  win.reload();
  win.webContents.once('did-finish-load', () => {
    win.webContents.executeJavaScript(
      `window.showToast && window.showToast('Modo leve ativado: detectamos um computador com pouca folga. Ajuste em Configurações › Interface. A aceleração de vídeo desliga no próximo início.', 'info')`,
    ).catch(() => {
      // Página sem showToast (tela de ativação/login): o ajuste continua valendo.
    });
  });
}

app.whenReady().then(boot).catch(reportFatalBootError);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
