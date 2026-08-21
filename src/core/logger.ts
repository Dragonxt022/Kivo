/**
 * Log estruturado do Kivo.
 *
 * O motivo é o suporte, não a elegância: o Kivo roda instalado na máquina do lojista, e
 * quando algo falha às 19h de sexta o que existia era `console.log` num terminal que
 * ninguém vê — o app empacotado não tem console aberto. Diagnosticar virava pedir print
 * de tela por telefone. Agora toda linha vai também para um arquivo em
 * `storage/logs/kivo-AAAA-MM-DD.log`, que o lojista consegue anexar num chamado.
 *
 * O formato mantém o prefixo por área que o código já usava (`[license]`, `[sync]`,
 * `[backup]`), agora como escopo de verdade: `createLogger('license')`. Continua saindo no
 * console em dev — o arquivo é adicional, não substituto.
 *
 * Sem dependência nova: é `fs.appendFileSync` e nada mais. Log de servidor local, com
 * volume de dezenas de linhas por hora, não justifica uma fila assíncrona — e escrita
 * síncrona é o que garante que a última linha antes de um crash chegue ao disco.
 */
import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Quantos dias de log ficam em disco. Além disso é peso morto no computador do cliente. */
const RETENTION_DAYS = 14;

function nivelConfigurado(): LogLevel {
  const bruto = String(process.env.KIVO_LOG_LEVEL ?? '').toLowerCase();
  return bruto in LEVEL_ORDER ? (bruto as LogLevel) : 'info';
}

let minimo = LEVEL_ORDER[nivelConfigurado()];

/** Troca o nível em tempo de execução (o suporte pede "liga o debug e reproduz"). */
export function setLogLevel(level: LogLevel): void {
  minimo = LEVEL_ORDER[level];
}

/**
 * Mesma raiz de `storage/` usada por backups e imagens: o diretório do banco, dois níveis
 * acima. Resolver a partir de KIVO_DB_PATH (e não de process.cwd()) é o que faz o app
 * empacotado escrever ao lado dos dados do cliente, e não dentro de Program Files.
 */
function logsDir(): string {
  const dbPath = process.env.KIVO_DB_PATH ?? path.resolve(process.cwd(), 'database', 'kivo.db');
  const dataRoot = path.dirname(path.dirname(dbPath));
  return path.join(dataRoot, 'storage', 'logs');
}

function arquivoDoDia(agora: Date): string {
  return path.join(logsDir(), `kivo-${agora.toISOString().slice(0, 10)}.log`);
}

let ultimaLimpeza = 0;

/** Apaga log mais velho que RETENTION_DAYS. Roda no máximo uma vez por hora. */
function limparAntigos(): void {
  const agora = Date.now();
  if (agora - ultimaLimpeza < 3600e3) return;
  ultimaLimpeza = agora;
  try {
    const dir = logsDir();
    const limite = agora - RETENTION_DAYS * 24 * 3600e3;
    for (const nome of fs.readdirSync(dir)) {
      if (!nome.startsWith('kivo-') || !nome.endsWith('.log')) continue;
      const completo = path.join(dir, nome);
      if (fs.statSync(completo).mtimeMs < limite) fs.unlinkSync(completo);
    }
  } catch {
    // Sem diretório ainda, ou arquivo em uso: limpeza é higiene, nunca motivo para o
    // processo cair — e o próximo ciclo tenta de novo.
  }
}

/**
 * Contexto extra vira JSON de uma linha. Erro é desmontado à mão porque `JSON.stringify`
 * de um `Error` devolve `{}` — perder a mensagem e a stack é justamente perder a única
 * coisa que interessava no log.
 */
function formatarContexto(contexto: unknown): string {
  if (contexto === undefined) return '';
  if (contexto instanceof Error) {
    return ` ${JSON.stringify({ erro: contexto.message, stack: contexto.stack })}`;
  }
  try {
    return ` ${JSON.stringify(contexto)}`;
  } catch {
    return ` ${String(contexto)}`;
  }
}

function escrever(level: LogLevel, escopo: string, mensagem: string, contexto?: unknown): void {
  if (LEVEL_ORDER[level] < minimo) return;

  const agora = new Date();
  const linha = `${agora.toISOString()} ${level.toUpperCase().padEnd(5)} [${escopo}] ${mensagem}${formatarContexto(contexto)}`;

  // Console: `error`/`warn` na saída de erro, para quem roda em terminal continuar
  // conseguindo separar o barulho do que importa com `2>`.
  if (level === 'error') console.error(linha);
  else if (level === 'warn') console.warn(linha);
  else console.log(linha);

  try {
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.appendFileSync(arquivoDoDia(agora), linha + '\n');
    limparAntigos();
  } catch {
    // Disco cheio, pasta somente-leitura, antivírus segurando o arquivo: o app não pode
    // parar de funcionar porque não conseguiu registrar. O console acima já saiu.
  }
}

export interface Logger {
  debug(mensagem: string, contexto?: unknown): void;
  info(mensagem: string, contexto?: unknown): void;
  warn(mensagem: string, contexto?: unknown): void;
  error(mensagem: string, contexto?: unknown): void;
}

/** `createLogger('sync')` → linhas com `[sync]`, o mesmo prefixo que o código já usava. */
export function createLogger(escopo: string): Logger {
  return {
    debug: (m, c) => escrever('debug', escopo, m, c),
    info: (m, c) => escrever('info', escopo, m, c),
    warn: (m, c) => escrever('warn', escopo, m, c),
    error: (m, c) => escrever('error', escopo, m, c),
  };
}

/** Caminho do log de hoje — a tela de suporte mostra para o lojista saber o que anexar. */
export function currentLogFile(): string {
  return arquivoDoDia(new Date());
}
