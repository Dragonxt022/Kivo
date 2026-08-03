/**
 * Cofre de segredos locais.
 *
 * Por que não usar a tabela `settings`: (1) `GET /api/settings` devolve TODAS as chaves
 * para qualquer usuário com `settings.view` — um operador de caixa leria o CSC e a senha
 * do certificado; (2) o backup copia o SQLite inteiro e o envia para a nuvem
 * (`core/backup/service.ts`), então tudo que está no banco sai da máquina.
 *
 * Por isso os segredos ficam num arquivo à parte, ao lado da MESMA raiz de dados do banco
 * (mesmo padrão de `defaultBackupDir()` e `productImagesDir()`), fora do backup e fora do
 * motor de sincronização.
 *
 * Cifragem: `safeStorage` do Electron quando disponível (chave no cofre do SO — a proteção
 * real). Fora do Electron (`src/dev.ts` e os testes rodam em Node puro) cai num AES-256-GCM
 * com chave derivada do machine id. Esse fallback é **ofuscação, não segurança forte**: quem
 * tem acesso ao disco e ao binário consegue derivar a chave. É o mesmo grau de honestidade
 * do `INTEGRITY_PEPPER` em `core/license/service.ts` — serve para o segredo não ficar em
 * texto puro num arquivo que alguém abre por acidente, não para resistir a um atacante local.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { machineId } from '../license/service';

const FILE_VERSION = 1;
const PEPPER = 'kivo-secrets-v1-3d9b7e02';

type Scheme = 'safeStorage' | 'aes-256-gcm';

interface StoredValue {
  /** Esquema usado para cifrar ESTE valor (pode variar se o app rodou fora do Electron). */
  s: Scheme;
  /** Payload cifrado em base64. */
  d: string;
}

interface VaultFile {
  v: number;
  /** Salt do fallback, gerado uma vez por instalação. */
  salt: string;
  values: Record<string, StoredValue>;
}

/** `storage/secrets.json` ao lado da raiz de dados — nunca dentro do banco. */
export function secretsFilePath(): string {
  const dbPath = process.env.KIVO_DB_PATH ?? path.resolve(process.cwd(), 'database', 'kivo.db');
  const dir = path.join(path.dirname(path.dirname(dbPath)), 'storage');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'secrets.json');
}

/**
 * `safeStorage` só existe sob Electron. `require('electron')` em Node puro resolve para o
 * pacote npm, que exporta o caminho do binário (uma string) — por isso o guard por
 * `process.versions.electron` antes de qualquer coisa.
 */
function safeStorage(): { encryptString(s: string): Buffer; decryptString(b: Buffer): string } | null {
  if (!process.versions.electron) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as typeof import('electron');
    if (!electron.safeStorage?.isEncryptionAvailable?.()) return null;
    return electron.safeStorage;
  } catch {
    return null;
  }
}

function readVault(): VaultFile {
  const file = secretsFilePath();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as VaultFile;
    if (parsed?.v === FILE_VERSION && parsed.salt && parsed.values) return parsed;
  } catch {
    /* arquivo ausente ou corrompido — recomeça vazio, sem derrubar o app */
  }
  return { v: FILE_VERSION, salt: crypto.randomBytes(16).toString('base64'), values: {} };
}

function writeVault(vault: VaultFile): void {
  const file = secretsFilePath();
  fs.writeFileSync(file, JSON.stringify(vault, null, 2), { mode: 0o600 });
}

function fallbackKey(salt: string): Buffer {
  return crypto.scryptSync(machineId() + PEPPER, Buffer.from(salt, 'base64'), 32);
}

function fallbackEncrypt(plain: string, salt: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', fallbackKey(salt), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function fallbackDecrypt(payload: string, salt: string): string {
  const buf = Buffer.from(payload, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', fallbackKey(salt), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

/** Grava (ou substitui) um segredo. Valor vazio remove a chave. */
export function setSecret(key: string, value: string): void {
  const vault = readVault();
  if (!value) {
    delete vault.values[key];
    writeVault(vault);
    return;
  }
  const ss = safeStorage();
  vault.values[key] = ss
    ? { s: 'safeStorage', d: ss.encryptString(value).toString('base64') }
    : { s: 'aes-256-gcm', d: fallbackEncrypt(value, vault.salt) };
  writeVault(vault);
}

/**
 * Lê um segredo, ou `null` se não existe / não pôde ser decifrado. Não lança e **nunca**
 * loga o valor — só o motivo. Falha típica: valor gravado sob Electron sendo lido em Node
 * puro (ou vice-versa), ou banco/pasta copiados para outra máquina (o machine id muda).
 */
export function getSecret(key: string): string | null {
  const vault = readVault();
  const stored = vault.values[key];
  if (!stored) return null;
  try {
    if (stored.s === 'safeStorage') {
      const ss = safeStorage();
      if (!ss) return null;
      return ss.decryptString(Buffer.from(stored.d, 'base64'));
    }
    return fallbackDecrypt(stored.d, vault.salt);
  } catch (e) {
    console.error(`[secrets] não foi possível decifrar "${key}" (esquema ${stored.s}):`, e);
    return null;
  }
}

/** Existe um valor gravado para esta chave? Não decifra — serve para telas de status. */
export function hasSecret(key: string): boolean {
  return !!readVault().values[key];
}

export function deleteSecret(key: string): void {
  setSecret(key, '');
}
