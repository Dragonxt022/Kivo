import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Selos dos planos (imagens que aparecem na assinatura e na tela de licença do app).
 *
 * O arquivo enviado pelo painel fica em `storage/plan-seals/` e o JSON de preços guarda
 * apenas o nome do arquivo. O nome ganha um sufixo aleatório a cada troca: além de evitar
 * cache antigo no navegador, permite apagar o arquivo anterior com segurança.
 */
export const PLAN_SEAL_DIR = path.resolve(__dirname, '..', '..', 'storage', 'plan-seals');

/** 2 MB: o selo é uma imagem pequena; acima disso o corpo base64 passa do limite do express. */
export const MAX_PLAN_SEAL_BYTES = 2 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** Caminho absoluto seguro a partir do nome guardado na configuração. */
export function planSealPath(file: string | null | undefined): string | null {
  const safe = path.basename(String(file ?? ''));
  if (!/^[a-z0-9-]+\.(?:png|jpe?g|webp)$/i.test(safe)) return null;
  return path.join(PLAN_SEAL_DIR, safe);
}

/**
 * Grava a imagem recebida como data URL e devolve o nome do arquivo.
 * O nome inclui a chave do plano para facilitar o diagnóstico no servidor.
 */
export function savePlanSealFile(key: string, dataUrl: string): string {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl ?? ''));
  if (!match) throw new Error('Envie uma imagem PNG, JPEG ou WEBP.');

  const ext = EXT_BY_MIME[match[1].toLowerCase()];
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!bytes.length) throw new Error('A imagem enviada está vazia.');
  if (bytes.length > MAX_PLAN_SEAL_BYTES) throw new Error('O selo deve ter no máximo 2 MB.');

  fs.mkdirSync(PLAN_SEAL_DIR, { recursive: true });
  const slot = String(key).replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'plano';
  const file = `${slot}-${randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(PLAN_SEAL_DIR, file), bytes);
  return file;
}

export function deletePlanSealFile(file: string | null | undefined): void {
  const target = planSealPath(file);
  if (!target) return;
  try {
    fs.unlinkSync(target);
  } catch {
    // Arquivo já removido / permissão: não impede a troca do selo no banco.
  }
}
