/**
 * Entry point real do Electron (ver package.json "main"). Existe só para definir
 * `KIVO_DB_PATH` ANTES de qualquer módulo do Core ser carregado — `import` estático
 * do TypeScript é compilado para `require()` no topo do arquivo, então não dá para
 * "setar a env var antes do import" no mesmo arquivo que importa o Core. O `import()`
 * dinâmico abaixo adia a carga de `./main` (e, por consequência, de
 * `../core/database/connection`, que lê `KIVO_DB_PATH` uma única vez no topo do
 * módulo) até depois da env var estar definida.
 */
import { app } from 'electron';
import path from 'node:path';

if (app.isPackaged) {
  process.env.KIVO_DB_PATH = path.join(app.getPath('userData'), 'database', 'kivo.db');
}

void import('./main');
