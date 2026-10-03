import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Arquivos de exame do Kivo Odonto — radiografia, tomografia, fotografia clínica, documento.
 *
 * Mesmo desenho do anexo do financeiro (`finance/attachments.ts`): o arquivo vive no disco
 * (`storage/odonto-exams`) e no banco fica só a referência (nome no disco, nome original, mime e
 * tamanho). O motivo é o mesmo de lá: as tabelas do módulo sincronizam entre as máquinas da
 * empresa, e uma radiografia em base64 faria cada ciclo carregar o arquivo inteiro.
 *
 * O arquivo chega como base64 no corpo JSON — o servidor é local/Electron, não exposto à internet.
 */

/** Prefixo servido por `express.static` em server.ts. */
export const EXAM_URL_PREFIX = '/uploads/odonto-exams/';

/** Relativo à raiz de dados do banco (o cwd varia num Electron empacotado). */
export function examFilesDir(): string {
  const dbPath = process.env.KIVO_DB_PATH ?? path.resolve(process.cwd(), 'database', 'kivo.db');
  const dir = path.join(path.dirname(path.dirname(dbPath)), 'storage', 'odonto-exams');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Teto de 12MB: radiografia digitalizada e tomografia costumam passar de 5MB, e o corpo JSON
 * aceita 20MB (base64 infla ~33%).
 */
export const MAX_EXAM_BYTES = 12 * 1024 * 1024;

/**
 * Formatos aceitos, com o Content-Type do download. De propósito fora: SVG e HTML (podem carregar
 * script) e DICOM (.dcm) — o navegador não exibe e o consultório exporta em PNG/JPG/PDF.
 */
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

/** Imagens que a tela consegue mostrar embutidas (o resto abre em nova aba/impressão). */
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

export function extensionOf(name: string): string {
  const ext = path.extname(String(name ?? '')).replace('.', '').toLowerCase();
  return ext.slice(0, 8);
}

export function mimeForFile(fileName: string, fallback = 'application/octet-stream'): string {
  return MIME_BY_EXT[extensionOf(fileName)] ?? fallback;
}

export function isImageFile(fileName: string): boolean {
  return IMAGE_EXTS.includes(extensionOf(fileName));
}

export type SaveExamFileResult =
  | { ok: true; file: string; name: string; mime: string; size: number }
  | { ok: false; error: string };

/**
 * Grava o arquivo (base64 sem o prefixo `data:`) e devolve a referência para o banco.
 * O nome no disco é um UUID: o nome original do consultório nunca vira caminho de arquivo.
 */
export function saveExamFile(originalName: string, base64: string, mimeHint?: string): SaveExamFileResult {
  const nome = String(originalName ?? '').trim().slice(0, 180) || 'exame';
  const ext = extensionOf(nome);
  if (!ext || !MIME_BY_EXT[ext]) {
    return {
      ok: false,
      error: `Formato não aceito (.${ext || '?'}). Envie PDF, PNG, JPG, JPEG, WEBP, GIF ou BMP.`,
    };
  }
  const limpo = String(base64 ?? '').replace(/^data:[^;]+;base64,/, '');
  if (!limpo) return { ok: false, error: 'O arquivo chegou vazio.' };

  let buffer: Buffer;
  try {
    buffer = Buffer.from(limpo, 'base64');
  } catch {
    return { ok: false, error: 'Não foi possível ler o arquivo enviado.' };
  }
  if (buffer.length === 0) return { ok: false, error: 'O arquivo chegou vazio.' };
  if (buffer.length > MAX_EXAM_BYTES) {
    return { ok: false, error: `Arquivo maior que ${Math.round(MAX_EXAM_BYTES / 1024 / 1024)}MB.` };
  }

  const arquivo = `${randomUUID()}.${ext}`;
  try {
    fs.writeFileSync(path.join(examFilesDir(), arquivo), buffer);
  } catch {
    return { ok: false, error: 'Falha ao gravar o arquivo no disco.' };
  }
  return {
    ok: true,
    file: arquivo,
    name: nome,
    mime: mimeHint && /^[\w.+-]+\/[\w.+-]+$/.test(mimeHint) ? mimeHint : MIME_BY_EXT[ext],
    size: buffer.length,
  };
}

/** Caminho absoluto do arquivo, ou null se ele sumiu do disco (backup restaurado pela metade). */
export function examFilePath(fileName: string): string | null {
  const base = path.basename(String(fileName ?? ''));
  if (!base) return null;
  const completo = path.join(examFilesDir(), base);
  return fs.existsSync(completo) ? completo : null;
}

/** Apaga o arquivo do disco (usado quando a linha é apagada de vez). */
export function deleteExamFile(fileName: string): void {
  const completo = examFilePath(fileName);
  if (!completo) return;
  try {
    fs.unlinkSync(completo);
  } catch {
    // Arquivo já removido não pode derrubar a exclusão do registro.
  }
}
