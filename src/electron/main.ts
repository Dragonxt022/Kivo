import { app, BrowserWindow, dialog, Menu, nativeTheme, screen } from 'electron';
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
import { patchUpdateState, getUpdateState, registrarUpdaterDriver } from '../core/updater';
import { createLogger } from '../core/logger';
import { installTelemetry, registerInventoryProvider, recordError } from '../core/telemetry/service';

const log = createLogger('electron');

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
  log.error('promessa rejeitada sem tratamento', msg);
  appendErrorLog(`[unhandledRejection] ${msg}`);
});
process.on('uncaughtException', (err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  log.error('exceção não capturada', msg);
  appendErrorLog(`[uncaughtException] ${msg}`);
});

// Crash de renderer/processo filho não caía em nenhum handler — agora vira telemetria,
// que é justamente o tipo de falha (tela branca, GPU) que o suporte precisa enxergar.
app.on('render-process-gone', (_event, _wc, details) => {
  recordError('renderer-process', `renderer finalizado: ${details.reason}`, { exitCode: details.exitCode });
});
app.on('child-process-gone', (_event, details) => {
  recordError('child-process', `processo filho finalizado: ${details.type}/${details.reason}`, { exitCode: details.exitCode });
});

/**
 * Segundo clique no atalho durante o boot: o lock de instância única já descartou o processo
 * novo, então ao menos traga a janela (ou a splash) para frente — em vez de parecer que o
 * clique não fez nada.
 */
app.on('second-instance', () => {
  const janela = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!janela) return;
  if (janela.isMinimized()) janela.restore();
  janela.focus();
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
 * Auto-update: checa Releases do GitHub (owner/repo/provider vêm do "publish" em
 * package.json — `npm run release:win` publica lá). Só roda no app empacotado; em dev
 * não há app-update.yml e o electron-updater erraria à toa. Sem console visível num app
 * empacotado, os eventos vão para um log em userData.
 *
 * Quem manda no ritmo é o lojista, não o app: `autoDownload` fica DESLIGADO e cada etapa
 * (verificar → baixar → instalar) sai de um clique em Configurações › Atualização. Numa
 * loja, um download de ~100 MB disparado sozinho no meio do movimento disputa a mesma
 * internet do TEF e da nuvem — e o reinício que vem depois cai no pior momento possível.
 *
 * O estado de cada etapa vive em core/updater (ver o porquê lá) e chega à tela pela API
 * HTTP local, porque a interface do Kivo é uma página servida pelo Express, não uma
 * renderer com IPC.
 */
function setupAutoUpdater(win: BrowserWindow): void {
  patchUpdateState({ versaoAtual: app.getVersion() });

  if (!app.isPackaged) {
    patchUpdateState({
      suportado: false,
      motivo: 'A atualização automática só funciona no Kivo instalado (aqui você está rodando em modo de desenvolvimento).',
    });
    return;
  }
  if (!canAutoUpdate(validateLicense().plan)) {
    patchUpdateState({
      suportado: false,
      motivo: 'Seu plano atual não inclui atualização automática. Fale com o suporte para atualizar o Kivo.',
    });
    return;
  }

  const logPath = path.join(app.getPath('userData'), 'update.log');
  const logUpdate = (msg: string) => {
    try {
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}
`);
    } catch {
      // log é best-effort — não deve derrubar o app.
    }
  };

  /** Aviso na própria tela do Kivo. `showToast` não existe na tela de login/ativação — daí a guarda. */
  const avisarNaTela = (msg: string, tipo: 'info' | 'success') => {
    win.webContents
      .executeJavaScript(`window.showToast && window.showToast(${JSON.stringify(msg)}, ${JSON.stringify(tipo)})`)
      .catch(() => {
        // Página sem o toast: o sino do cabeçalho e a aba Atualização continuam mostrando.
      });
  };

  autoUpdater.autoDownload = false;
  // Depois de baixada, a atualização entra sozinha quando o Kivo fecha (isSilent, sem
  // reabrir) — é o "instalar ao fechar" do comando de atualização forçada do suporte.
  // Continua valendo para o fluxo manual: baixar e fechar atualiza do mesmo jeito.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    logUpdate('verificando atualização...');
    patchUpdateState({ status: 'verificando', erro: null });
  });
  autoUpdater.on('update-available', (info) => {
    logUpdate(`atualização disponível: ${info.version}`);
    const primeiraVez = getUpdateState().versaoDisponivel !== info.version;
    patchUpdateState({
      status: 'disponivel',
      versaoDisponivel: info.version,
      notas: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
      verificadoEm: new Date().toISOString(),
      erro: null,
    });
    // Só na primeira vez que ESTA versão aparece: a checagem se repete a cada 6h e o
    // lojista não precisa do mesmo aviso três vezes por dia.
    if (primeiraVez) {
      avisarNaTela(
        `Nova versão do Kivo disponível (${info.version}). Baixe em Configurações › Atualização.`,
        'info',
      );
    }
  });
  autoUpdater.on('update-not-available', () => {
    logUpdate('nenhuma atualização disponível.');
    patchUpdateState({
      status: 'ocioso',
      versaoDisponivel: null,
      notas: null,
      progresso: null,
      verificadoEm: new Date().toISOString(),
      erro: null,
    });
  });
  autoUpdater.on('download-progress', (p) => {
    patchUpdateState({
      status: 'baixando',
      progresso: {
        percent: Math.max(0, Math.min(100, p.percent ?? 0)),
        transferido: p.transferred ?? 0,
        total: p.total ?? 0,
        bytesPorSegundo: p.bytesPerSecond ?? 0,
      },
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    logUpdate(`atualização baixada: ${info.version} — aguardando o usuário mandar instalar.`);
    patchUpdateState({
      status: 'baixado',
      versaoDisponivel: info.version,
      progresso: { percent: 100, transferido: 0, total: 0, bytesPorSegundo: 0 },
      erro: null,
    });
    avisarNaTela(
      `Kivo ${info.version} baixado. Ele será instalado quando você fechar o Kivo — ou clique em Atualizar para reiniciar agora.`,
      'success',
    );
  });
  autoUpdater.on('error', (err) => {
    logUpdate(`erro: ${err.message}`);
    patchUpdateState({ status: 'erro', erro: err.message, progresso: null });
  });

  patchUpdateState({ suportado: true, motivo: null, status: 'ocioso' });

  registrarUpdaterDriver({
    verificar: async () => {
      await autoUpdater.checkForUpdates();
    },
    baixar: async () => {
      // Não é `await` até o fim de propósito: a rota HTTP responde quando o download
      // COMEÇA, e o andamento vai pelo evento `download-progress`. Um erro aqui já é
      // reportado pelo evento `error` acima.
      void autoUpdater.downloadUpdate().catch((e: Error) => {
        logUpdate(`falha ao baixar: ${e.message}`);
        patchUpdateState({ status: 'erro', erro: e.message, progresso: null });
      });
    },
    instalar: () => {
      logUpdate('instalando e reiniciando...');
      // (silencioso, reabre depois): o instalador NSIS roda sem telas e o Kivo volta
      // sozinho — para o lojista é só o app piscar, que é o pedido original.
      autoUpdater.quitAndInstall(true, true);
    },
  });

  const checar = () =>
    autoUpdater.checkForUpdates().catch((err: Error) => {
      logUpdate(`falha ao checar: ${err.message}`);
      patchUpdateState({ status: 'erro', erro: err.message });
    });

  void checar();
  // PDV fica dias aberto sem reiniciar: sem o ciclo, a única chance de descobrir uma
  // versão nova seria o boot.
  setInterval(() => void checar(), 6 * 3600e3).unref?.();
}

/**
 * Ícone da marca (mesmas cores da logo) embutido na tela de abertura. Inline de propósito:
 * a splash carrega por `data:` antes de o Express subir, então não pode depender de arquivo
 * em /public (que só existe servido). `currentColor` deixa o desenho claro no tema escuro.
 */
const SPLASH_ICONE = `<svg viewBox="0 0 933 932" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M235 208.5V741L435.5 557L608.5 741H774L435.5 410.5L350 496V208.5H235Z" fill="currentColor"/>
<path d="M530.5 459.5L457 383L630 208.5H775.5L530.5 459.5Z" fill="#FF8000"/>
<path d="M710.468 111.703C516.068 -46.6968 290.802 45.7032 202.468 111.703C184.868 114.103 184.802 100.37 186.968 93.2032C426.168 -75.5968 645.968 22.8699 725.968 93.2032C731.968 103.603 718.135 109.87 710.468 111.703Z" fill="currentColor"/>
<path d="M111.703 712.468C-46.6968 518.068 45.7032 292.802 111.703 204.468C114.103 186.868 100.37 186.802 93.2032 188.968C-75.5968 428.168 22.8699 647.968 93.2032 727.968C103.603 733.968 109.87 720.135 111.703 712.468Z" fill="currentColor"/>
<path d="M821.278 724.468C979.678 530.068 887.278 304.802 821.278 216.468C818.878 198.868 832.611 198.802 839.778 200.968C1008.58 440.168 910.111 659.968 839.778 739.968C829.378 745.968 823.111 732.135 821.278 724.468Z" fill="currentColor"/>
<path d="M204.968 820.278C399.368 978.678 624.635 886.278 712.968 820.278C730.568 817.878 730.635 831.611 728.468 838.778C489.268 1007.58 269.468 909.111 189.468 838.778C183.468 828.378 197.302 822.111 204.968 820.278Z" fill="currentColor"/>
</svg>`;

function splashHtml(escuro: boolean): string {
  const bg = escuro ? '#1c1f26' : '#ffffff';
  const fg = escuro ? '#ececf0' : '#1e1e2a';
  const marca = escuro ? '#ececf0' : '#1e1c1a';
  const trilha = escuro ? '#2a2d36' : '#eae8ea';
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8" />
<style>
  * { margin: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 16px; background: ${bg}; color: ${fg};
    font-family: system-ui, -apple-system, sans-serif;
    -webkit-user-select: none; user-select: none; overflow: hidden;
  }
  .logo { width: 66px; height: 66px; color: ${marca};
    animation: kivo-pop .5s cubic-bezier(.2,.8,.3,1) both; }
  .logo svg { width: 100%; height: 100%; display: block; }
  .nome { font-size: 1.05rem; font-weight: 700; letter-spacing: .02em; opacity: .92;
    animation: kivo-fade .6s .08s both; }
  .barra { width: 176px; height: 5px; border-radius: 99px; background: ${trilha}; overflow: hidden; }
  .barra i { display: block; width: 42%; height: 100%; border-radius: 99px; background: #FF8000;
    animation: kivo-correr 1.1s ease-in-out infinite; }
  @keyframes kivo-correr { 0% { transform: translateX(-120%); } 100% { transform: translateX(320%); } }
  @keyframes kivo-pop { from { transform: scale(.82); opacity: 0; } to { transform: scale(1); opacity: 1; } }
  @keyframes kivo-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: .92; transform: none; } }
  @media (prefers-reduced-motion: reduce) {
    .logo, .nome { animation: none; }
    .barra i { animation: none; width: 100%; }
  }
</style></head>
<body>
  <div class="logo">${SPLASH_ICONE}</div>
  <div class="nome">Kivo</div>
  <div class="barra"><i></i></div>
</body></html>`;
}

/**
 * Janela de abertura. Aparece assim que o Electron fica pronto — antes de migrations,
 * licença e servidor local, que é onde o boot passa vários segundos sem nada na tela. É o
 * feedback de que o clique funcionou; sem ela, a sensação é de que o app não abriu.
 */
function criarSplash(): BrowserWindow {
  const escuro = nativeTheme.shouldUseDarkColors;
  const splash = new BrowserWindow({
    width: 340,
    height: 210,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: true,
    center: true,
    skipTaskbar: true,
    backgroundColor: escuro ? '#1c1f26' : '#ffffff',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  void splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml(escuro)));
  return splash;
}

async function boot() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  Menu.setApplicationMenu(null);

  // Splash primeiro: dá feedback imediato enquanto migrations/seeds/licença (trabalho
  // pesado e, em parte, síncrono) seguram o boot. A folga de 50 ms é para o renderer
  // pintar antes de o loop principal ficar ocupado.
  const splash = criarSplash();
  const splashInicio = Date.now();
  await new Promise((r) => setTimeout(r, 50));

  migrateUp();
  runSeeds();
  installTelemetry();
  registerInventoryProvider(() => {
    let screenInfo: { width: number; height: number; scaleFactor: number } | null = null;
    try {
      const d = screen.getPrimaryDisplay();
      screenInfo = { width: d.size.width, height: d.size.height, scaleFactor: d.scaleFactor };
    } catch {
      // Sem display (headless): segue sem tela.
    }
    let gpu: { status: string; software: boolean } | null = null;
    try {
      const status = app.getGPUFeatureStatus() as unknown as Record<string, string>;
      const software = ['gpu_compositing', '2d_canvas'].some((k) => (status?.[k] ?? '').includes('software'));
      gpu = { status: String(status?.gpu_compositing ?? 'desconhecida'), software };
    } catch {
      // Plataforma que não expõe o status de GPU.
    }
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? null,
      chromeVersion: process.versions.chrome ?? null,
      nodeVersion: process.versions.node,
      screen: screenInfo,
      gpu,
    };
  });
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
  const lanLigado = lanRow?.value === '1';
  const host = lanLigado ? '0.0.0.0' : '127.0.0.1';
  // A tela de Configurações compara isto com a chave salva para dizer se o acesso pela
  // rede JÁ está valendo ou se ainda falta reiniciar. Sem esse retorno, quem ligava a
  // chave não tinha como saber por que o celular continuava sem abrir.
  api.locals.lanAtivo = lanLigado;
  const server = api.listen(PORT, host);
  server.once('error', (err: NodeJS.ErrnoException) => {
    appendErrorLog(`[rede] falha ao escutar em ${host}:${PORT} — ${err.message}`);
    if (!lanLigado) {
      reportFatalBootError(err);
      return;
    }
    // Firewall/política de rede recusando o 0.0.0.0 não pode derrubar o PDV desta
    // máquina: volta para o loopback (o modo padrão) e a tela passa a mostrar que o
    // acesso pela rede não está ativo, em vez de o app simplesmente não abrir.
    api.locals.lanAtivo = false;
    api.listen(PORT, '127.0.0.1');
  });

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
  // A janela principal só aparece quando a primeira página já pintou — nada de tela branca
  // no meio do caminho. A splash sai junto, com um tempo mínimo para não piscar em máquinas
  // rápidas (e para o usuário perceber a abertura, que era o pedido).
  win.once('ready-to-show', () => {
    win.show();
    const restante = Math.max(0, 700 - (Date.now() - splashInicio));
    setTimeout(() => {
      if (!splash.isDestroyed()) splash.destroy();
    }, restante);
  });
  await win.loadURL(`http://localhost:${PORT}/`);

  // Acompanha o tema claro/escuro do Windows em tempo real (o ícone gravado no .exe
  // no build é fixo; isto troca o ícone da janela/taskbar enquanto o app está aberto).
  nativeTheme.on('updated', () => win.setIcon(currentIconPath()));

  detectarModoLeve(win, api);

  setupAutoUpdater(win);
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
