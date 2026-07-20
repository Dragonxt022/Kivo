import { createHash } from 'node:crypto';
import { imageSize } from 'image-size';

/**
 * Validação do banco de imagens (Kivo Cloud): roda em toda submissão ANTES de cair na
 * fila de curadoria humana do /admin — barra formato inválido, tamanho fora da faixa e
 * dimensão mínima automaticamente, para o admin só revisar imagens que já passaram no
 * crivo técnico. Duplicada em relação a src/core/catalog/imageValidation.ts do app local
 * (deployables separados, sem pacote compartilhado — mesma regra do resto do cloud/).
 */

export type ImageFormat = 'jpeg' | 'png' | 'webp';

const MIN_BYTES = 2 * 1024;
const MAX_BYTES = 6 * 1024 * 1024;
const MIN_DIMENSION = 200;

export function sniffImageFormat(buf: Buffer): ImageFormat | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export type ImageValidationResult =
  | { ok: true; format: ImageFormat; width: number; height: number }
  | { ok: false; error: string };

export function validateCatalogImage(buf: Buffer): ImageValidationResult {
  if (!buf?.length) return { ok: false, error: 'Corpo da requisição vazio.' };
  if (buf.length < MIN_BYTES) return { ok: false, error: 'Imagem muito pequena ou corrompida.' };
  if (buf.length > MAX_BYTES) return { ok: false, error: 'Imagem muito grande (máximo 6MB).' };

  // Assinatura de bytes, não o Content-Type do header (que o cliente controla) — barra
  // spoofing barato (ex.: subir um .exe renomeado com Content-Type: image/jpeg).
  const format = sniffImageFormat(buf);
  if (!format) return { ok: false, error: 'Formato não suportado (use JPEG, PNG ou WEBP).' };

  try {
    const { width, height } = imageSize(buf);
    if (!width || !height) return { ok: false, error: 'Não foi possível ler as dimensões da imagem.' };
    if (width < MIN_DIMENSION || height < MIN_DIMENSION) {
      return { ok: false, error: `Imagem muito pequena (mínimo ${MIN_DIMENSION}×${MIN_DIMENSION}px).` };
    }
    return { ok: true, format, width, height };
  } catch {
    return { ok: false, error: 'Imagem corrompida ou em formato inválido.' };
  }
}

/** Normaliza o nome do produto em tokens de busca (minúsculo, sem acento/pontuação) para o FULLTEXT. */
export function normalizeKeywords(productName: string): string {
  // Faixa Unicode das marcas diacríticas combinantes (acentos após NFD) — ̀-ͯ.
  const COMBINING_MARKS = /[̀-ͯ]/g;
  return productName
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .join(' ');
}
