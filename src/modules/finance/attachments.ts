/**
 * Anexos de contas a pagar/receber — boleto, nota fiscal, comprovante, extrato.
 *
 * O arquivo vive no disco (`storage/bill-attachments`) e no banco fica só a referência
 * (nome do arquivo, nome original, mime e tamanho). Mesmo motivo da logo da empresa e das
 * fotos de produto: as tabelas `payables`/`receivables` sincronizam entre as máquinas da
 * empresa, e um documento em base64 faria cada ciclo de sync carregar o arquivo inteiro.
 *
 * O arquivo chega como base64 no corpo JSON (ver bills.ts), no mesmo padrão dos demais
 * uploads do sistema — o servidor é local/Electron, não exposto à internet.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateImageBuffer } from '../../core/catalog/imageValidation';

/** Prefixo servido por `express.static` em server.ts. */
export const BILL_ATTACHMENT_URL_PREFIX = '/uploads/bills/';

/**
 * Relativo à raiz de dados do banco, e não a `process.cwd()`: num Electron empacotado o
 * cwd varia conforme de onde o processo foi lançado. Mesmo padrão de `companyLogoDir()`.
 */
export function billAttachmentsDir(): string {
  const dbPath = process.env.KIVO_DB_PATH ?? path.resolve(process.cwd(), 'database', 'kivo.db');
  const dataRoot = path.dirname(path.dirname(dbPath));
  const dir = path.join(dataRoot, 'storage', 'bill-attachments');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Teto de 5MB: cobre boleto, nota e extrato com folga. O corpo JSON aceita 10MB (base64
 * infla ~33%), então 5MB de arquivo cabe com margem.
 */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Extensões permitidas e o Content-Type com que são devolvidas no download. De propósito
 * fora da lista: SVG e HTML, que podem carregar script — ainda que o download force
 * `Content-Disposition: attachment`, melhor não aceitar o que não faz sentido como anexo.
 */
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  xml: 'application/xml',
  csv: 'text/csv',
  ofx: 'application/x-ofx',
  txt: 'text/plain',
};

export type SaveAttachmentResult =
  | { ok: true; file: string; name: string; mime: string; size: number }
  | { ok: false; error: string };

function extensionOf(name: string): string {
  const base = String(name || '').trim();
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function saveBillAttachment(base64: string, originalName: string): SaveAttachmentResult {
  // Nome original é só rótulo (vai no Content-Disposition e na tela); limita o tamanho
  // para não guardar um romance como nome de arquivo.
  const name = String(originalName || 'documento').slice(0, 180);
  const ext = extensionOf(name);
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    return { ok: false, error: 'Tipo de arquivo não permitido. Envie PDF, imagem, XML, CSV, OFX ou TXT.' };
  }

  let buf: Buffer;
  try {
    // Aceita base64 puro ou data URI — o FileReader do navegador devolve a segunda forma.
    buf = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
  } catch {
    return { ok: false, error: 'Arquivo inválido.' };
  }
  if (!buf.length) return { ok: false, error: 'Arquivo vazio.' };
  if (buf.length > MAX_BYTES) return { ok: false, error: 'Arquivo muito grande (máximo 5MB).' };

  // Confere a assinatura dos bytes em vez de confiar na extensão: PDF e imagens têm
  // cabeçalho reconhecível, e um `.pdf` que não começa com `%PDF-` é quase sempre engano.
  if (ext === 'pdf') {
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return { ok: false, error: 'O arquivo não parece um PDF válido.' };
    }
  } else if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp') {
    const check = validateImageBuffer(buf);
    if (!check.ok) return { ok: false, error: check.error };
  }

  const file = `${randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(billAttachmentsDir(), file), buf);
  return { ok: true, file, name, mime, size: buf.length };
}

/** Apaga o arquivo do disco. Silencioso: trocar/remover anexo não pode falhar por isso. */
export function deleteBillAttachmentFile(file: string | null | undefined): void {
  if (!file) return;
  try {
    fs.unlinkSync(path.join(billAttachmentsDir(), path.basename(file)));
  } catch {
    // já não existe
  }
}

/**
 * Nome de arquivo seguro para o cabeçalho Content-Disposition: uma versão ASCII (fallback
 * para clientes antigos) e a versão completa via `filename*` (RFC 5987), que preserva acentos.
 */
export function contentDisposition(name: string): string {
  const ascii = String(name || 'documento').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name || 'documento')}`;
}
