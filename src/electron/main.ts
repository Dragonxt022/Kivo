import { app, BrowserWindow, dialog, Menu } from 'electron';
import { autoUpdater } from 'electron-updater';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite } from '../core/database/connection';
import { refreshLicenseFromCloud, validateLicense } from '../core/license/service';
import { canAutoUpdate } from '../core/license/plans';

const PORT = Number(process.env.KATSU_PORT ?? 3123);

/**
 * Backup local (Fase 1) e nuvem (Fase 6c) precisam de um diretório gravável fora da
 * pasta de instalação (que pode não ter permissão de escrita e é sobrescrita em
 * atualizações). Semeia a setting só se ainda não existir — não sobrescreve escolha
 * do usuário feita depois pela tela de Configurações.
 */
function seedPackagedBackupDir(): void {
  if (!app.isPackaged) return;
  const db = getSqlite();
  const existing = db.prepare("SELECT 1 FROM settings WHERE key = 'backup.dir' AND deleted_at IS NULL").get();
  if (existing) return;
  const dir = path.join(app.getPath('userData'), 'storage', 'backups');
  db.prepare(
    `INSERT INTO settings (key, value, uuid, comment) VALUES ('backup.dir', ?, ?, 'Diretório de destino dos backups locais.')`,
  ).run(dir, randomUUID());
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
  dialog.showErrorBox('Katsu — falha ao iniciar', message);
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
        title: 'Katsu — atualização disponível',
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
  Menu.setApplicationMenu(null);

  migrateUp();
  runSeeds();
  seedPackagedBackupDir();
  // Antes de carregar os módulos (que decidem o que habilitar a partir do cache
  // local de licença): sem isso, mudar o plano/módulos no painel cloud só entrava em
  // vigor depois de um "Sincronizar agora" manual — reiniciar sozinho não bastava.
  await refreshLicenseFromCloud();
  const { app: api } = await createServer();
  api.listen(PORT, '127.0.0.1');

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    // Relativo a __dirname (não process.cwd()): dev resolve para src/public; app
    // empacotado resolve para dist/public (ver scripts/copy-build-assets.js).
    icon: path.resolve(__dirname, '..', 'public', 'katsu_logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.maximize();
  win.show();
  await win.loadURL(`http://localhost:${PORT}/`);

  setupAutoUpdater();
}

app.whenReady().then(boot).catch(reportFatalBootError);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
