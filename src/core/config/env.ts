import fs from 'node:fs';
import path from 'node:path';

/**
 * Carrega um arquivo `.env` para `process.env`.
 *
 * Por que existe (em vez de usar dotenv): o app local não tinha nenhum carregador de
 * `.env` — as variáveis só funcionavam se exportadas no shell/sistema. O cloud/ usa dotenv,
 * mas aqui é uma dependência a mais por ~20 linhas de parser. E, diferente de `--env-file`,
 * este NÃO sobrescreve variáveis já definidas no ambiente: o shell/serviço sempre ganha do
 * arquivo, que é a convenção esperada (o `.env` é o padrão; a env da máquina é o override).
 *
 * Ordem de procura: `process.cwd()/.env` (dev) e a raiz de dados ao lado do banco (mesmo
 * padrão de `productImagesDir()`), onde o instalador pode deixar um `.env` por máquina.
 * O arquivo `.env` está no `.gitignore`; o modelo versionado é o `.env.example`.
 */

/** Parser mínimo: `KEY=VALUE`, `#` comenta, aceita `export` e aspas simples/duplas. */
export function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    out[key] = value;
  }
  return out;
}

/** Raiz de dados (pasta que contém `database/` e `storage/`), conforme `KIVO_DB_PATH`. */
function dataRoot(): string {
  const dbPath = process.env.KIVO_DB_PATH ?? path.resolve(process.cwd(), 'database', 'kivo.db');
  return path.dirname(path.dirname(dbPath));
}

let loaded = false;

/**
 * Lê os `.env` candidatos uma única vez. Deve ser chamado no boot, ANTES dos módulos que
 * leem `process.env` no topo (ex.: `core/database/connection.ts` lê `KIVO_DB_PATH`).
 * Variáveis já presentes no ambiente são preservadas.
 */
export function loadEnvFiles(): void {
  if (loaded) return;
  loaded = true;

  const candidates = [path.resolve(process.cwd(), '.env'), path.join(dataRoot(), '.env')];
  const seen = new Set<string>();
  for (const file of candidates) {
    const abs = path.resolve(file);
    if (seen.has(abs)) continue;
    seen.add(abs);
    let parsed: Record<string, string>;
    try {
      parsed = parseEnv(fs.readFileSync(abs, 'utf8'));
    } catch {
      continue; // arquivo ausente/ilegível — sem problema
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
