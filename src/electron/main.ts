import { app, BrowserWindow, dialog } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { checkAppUpdates, checkModuleUpdates } from '../core/updater';
import { getSqlite } from '../core/database/connection';

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

async function boot() {
  migrateUp();
  runSeeds();
  seedPackagedBackupDir();
  const { app: api } = await createServer();
  api.listen(PORT, '127.0.0.1');

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    // Relativo a __dirname (não process.cwd()): dev resolve para src/public; app
    // empacotado resolve para dist/public (ver scripts/copy-build-assets.js).
    icon: path.resolve(__dirname, '..', 'public', 'katsu_logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadURL(`http://localhost:${PORT}/`);

  // Esqueleto do auto-update (app e módulos separados) — Fase 0.
  void checkAppUpdates();
  void checkModuleUpdates();
}

app.whenReady().then(boot).catch(reportFatalBootError);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
