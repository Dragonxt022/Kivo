/**
 * Validação leve de imagem de produto no lado local (Electron): checagem barata de
 * formato (assinatura de bytes, não confia em Content-Type) e tamanho, antes de gastar
 * uma tentativa de upload para o Kivo Cloud. A validação "pesada" (dimensões mínimas,
 * segunda opinião de formato) roda no cloud/ antes de cair na fila de curadoria humana —
 * ver cloud/src/catalogValidation.ts.
 */

export type ImageFormat = 'jpeg' | 'png' | 'webp';

const MIN_BYTES = 2 * 1024; // 2KB — abaixo disso é quase sempre lixo/corrompido
const MAX_BYTES = 6 * 1024 * 1024; // 6MB

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

export type ImageValidationResult =
  | { ok: true; format: ImageFormat }
  | { ok: false; error: string };

export function validateImageBuffer(buf: Buffer): ImageValidationResult {
  if (!buf.length) return { ok: false, error: 'Imagem vazia.' };
  if (buf.length < MIN_BYTES) return { ok: false, error: 'Imagem muito pequena ou corrompida.' };
  if (buf.length > MAX_BYTES) return { ok: false, error: 'Imagem muito grande (máximo 6MB).' };
  const format = sniffImageFormat(buf);
  if (!format) return { ok: false, error: 'Formato não suportado (use JPEG, PNG ou WEBP).' };
  return { ok: true, format };
}
