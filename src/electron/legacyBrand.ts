import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Migração única de dados da marca antiga (Kivo) para a nova (Kuruk).
 *
 * O `productName` mudou, então o `userData` do Electron deixa de ser
 * `%APPDATA%\Kivo` e passa a ser `%APPDATA%\Kuruk`. Sem esta cópia, uma
 * atualização pareceria uma instalação nova: banco, backups, imagens,
 * certificados e preferências ficariam para trás.
 *
 * A cópia é conservadora: só grava o que ainda não existe no destino, exceto
 * o `Local State` da chave do `safeStorage`, que precisa ser herdado uma única
 * vez para os segredos antigos continuarem decifráveis. Roda antes de
 * `getSqlite()` abrir o banco.
 */
const LEGACY_APP_DIR = 'Kivo';
const LEGACY_DB_FILE = 'kivo.db';
const DB_FILE = 'kuruk.db';
const SAFE_STORAGE_MARKER = '.safe-storage-migrated';

/** Pastas de dados que precisam sobreviver ao rebrand. */
const DATA_DIRS = ['database', 'storage', 'certificados', 'https'];
/** Arquivos de configuração soltos na raiz do userData. */
const DATA_FILES = ['.env'];

/** Copia `from` para `to` apenas quando o destino ainda não existe. */
function mergeMissing(from: string, to: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(from);
  } catch {
    return;
  }

  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      mergeMissing(path.join(from, name), path.join(to, name));
    }
    return;
  }

  if (fs.existsSync(to)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/** Renomeia `kivo.db` (e os arquivos WAL/SHM) para `kuruk.db` no diretório indicado. */
function renameLegacyDatabase(dir: string): void {
  const legacy = path.join(dir, LEGACY_DB_FILE);
  const current = path.join(dir, DB_FILE);
  if (!fs.existsSync(legacy) || fs.existsSync(current)) return;

  fs.renameSync(legacy, current);
  for (const suffix of ['-wal', '-shm']) {
    const from = legacy + suffix;
    const to = current + suffix;
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
  }
}

/**
 * O `safeStorage` do Electron usa a chave de criptografia do perfil Chromium
 * (`Local State`). Como o `userData` mudou de Kivo para Kuruk, copiar apenas o
 * `secrets.json` não basta: sem o `Local State` antigo, todo valor gravado com
 * o esquema `safeStorage` falha ao decifrar.
 *
 * Na primeira migração não existe segredo novo no perfil Kuruk, então a chave
 * antiga é copiada direto. Se o Kuruk já rodou (ex.: uma versão 2.1.18), só
 * copiamos quando o `secrets.json` novo ainda é idêntico ao antigo — assim um
 * segredo que o usuário regravou com a chave nova não é perdido.
 */
function migrateSafeStorageKey(
  legacyRoot: string,
  currentRoot: string,
  firstMigration: boolean,
): void {
  const marker = path.join(currentRoot, SAFE_STORAGE_MARKER);
  if (fs.existsSync(marker)) return;

  const legacyState = path.join(legacyRoot, 'Local State');
  if (!fs.existsSync(legacyState)) {
    try {
      fs.writeFileSync(marker, `${new Date().toISOString()} sem Local State antigo\n`);
    } catch {
      // melhor-esforço
    }
    return;
  }

  const currentState = path.join(currentRoot, 'Local State');
  const legacySecrets = path.join(legacyRoot, 'storage', 'secrets.json');
  const currentSecrets = path.join(currentRoot, 'storage', 'secrets.json');

  let podeCopiar = firstMigration;
  if (!podeCopiar) {
    try {
      podeCopiar =
        !fs.existsSync(currentSecrets) ||
        (fs.existsSync(legacySecrets) && fs.readFileSync(legacySecrets).equals(fs.readFileSync(currentSecrets)));
    } catch {
      podeCopiar = false;
    }
  }

  let concluido = false;
  if (podeCopiar) {
    try {
      if (fs.existsSync(currentState)) fs.copyFileSync(currentState, `${currentState}.before-kuruk`);
      fs.copyFileSync(legacyState, currentState);
      concluido = true;
    } catch {
      // arquivo em uso ou sem permissão: tenta de novo no próximo boot
    }
  } else {
    // Decisão deliberada de preservar os segredos novos; não repete.
    concluido = true;
  }

  if (concluido) {
    try {
      fs.writeFileSync(marker, `${new Date().toISOString()} safeStorage: ${podeCopiar ? 'chave antiga copiada' : 'chave nova preservada'}\n`);
    } catch {
      // melhor-esforço
    }
  }
}

export function migrateLegacyBrandData(): void {
  try {
    if (app.isPackaged) {
      const legacyRoot = path.join(app.getPath('appData'), LEGACY_APP_DIR);
      const currentRoot = app.getPath('userData');
      const firstMigration = !fs.existsSync(path.join(currentRoot, 'database', DB_FILE));

      if (path.resolve(legacyRoot) !== path.resolve(currentRoot) && fs.existsSync(legacyRoot)) {
        migrateSafeStorageKey(legacyRoot, currentRoot, firstMigration);
        for (const dir of DATA_DIRS) {
          mergeMissing(path.join(legacyRoot, dir), path.join(currentRoot, dir));
        }
        for (const file of DATA_FILES) {
          mergeMissing(path.join(legacyRoot, file), path.join(currentRoot, file));
        }
      }

      renameLegacyDatabase(path.join(currentRoot, 'database'));
      return;
    }

    // Em desenvolvimento os dados ficam em `database/`, ao lado do projeto.
    renameLegacyDatabase(path.resolve(process.cwd(), 'database'));
  } catch {
    // Migração é melhor-esforço: nunca pode impedir o boot. Se falhar, o app
    // segue com o banco novo (vazio) em vez de travar na abertura.
  }
}
