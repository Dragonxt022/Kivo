/**
 * Registro de boot — arquivo de texto simples, escrito ANTES de qualquer coisa do Core.
 *
 * Por que existe: no app empacotado (e no `dev:electron`) não há terminal. Quando o boot
 * morre antes de `boot()` — variável de ambiente errada, dependência nativa, exceção no
 * `import()` dinâmico —, o sintoma para quem usa é "abri e não aconteceu nada": sem janela,
 * sem log e sem pista. O `error.log` do main.ts não ajuda nesse caso porque ele só passa a
 * existir depois que o `main` carrega.
 *
 * O arquivo é escrito de forma tolerante a falha (nunca lança): o objetivo é justamente
 * documentar o caminho de FALHA. Fica na raiz de dados (ao lado de `database/` e
 * `storage/`), o mesmo lugar dos logs do Core.
 *
 * Uso: `import { bootLog } from './bootLog'` e chame `bootLog('mensagem')` nas etapas do
 * boot. Leia o arquivo quando precisar saber até onde o app chegou.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Raiz de dados: `KIVO_DB_PATH` manda; sem ele, o cwd (modo dev). */
function bootLogPath(): string {
  const dbPath = process.env.KIVO_DB_PATH ?? path.resolve(process.cwd(), 'database', 'kivo.db');
  return path.join(path.dirname(path.dirname(dbPath)), 'boot.log');
}

/** Última mensagem de erro fatal, para o diálogo explicar o que houve. */
export function bootLog(mensagem: string): void {
  try {
    const arquivo = bootLogPath();
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    fs.appendFileSync(arquivo, `${new Date().toISOString()} ${mensagem}\n`);
  } catch {
    // melhor esforço: registrar não pode derrubar o boot
  }
}

/** Caminho do `boot.log` atual — usado pelo aviso de falha fatal. */
export function bootLogFile(): string {
  return bootLogPath();
}
