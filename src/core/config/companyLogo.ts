/**
 * Logo da empresa do lojista — a marca DELE no lugar da nossa, no cabeçalho do sistema
 * e no cupom.
 *
 * Guardado como ARQUIVO no disco, com só a URL indo para `settings` (`empresa.logo_url`),
 * pelo mesmo motivo das fotos de produto: a tabela `settings` sincroniza para as outras
 * máquinas da empresa e entra no backup enviado à nuvem, então enfiar a imagem em base64
 * ali faria cada ciclo de sync e cada `GET /api/settings` carregarem o arquivo inteiro.
 *
 * A consequência honesta desse desenho: num segundo computador da mesma loja a URL chega
 * pelo sync mas o arquivo não — por isso quem exibe usa `onerror` para cair na marca do
 * Kivo, e a tela de Configurações avisa que a logo é enviada por computador.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateImageBuffer, type ImageFormat } from '../catalog/imageValidation';

const EXT_BY_FORMAT: Record<ImageFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' };

/** Chave em `settings`. Fica junto dos demais dados da empresa (nome, CNPJ, endereço). */
export const LOGO_SETTING_KEY = 'empresa.logo_url';

/** Prefixo servido por `express.static` em server.ts — identifica o que é nosso ao apagar. */
export const LOGO_URL_PREFIX = '/uploads/company/';

/**
 * Relativo à raiz de dados do banco, e não a `process.cwd()`: num Electron empacotado o
 * cwd varia conforme de onde o processo foi lançado. Mesmo padrão de `productImagesDir()`.
 */
export function companyLogoDir(): string {
  const dbPath = process.env.KIVO_DB_PATH ?? path.resolve(process.cwd(), 'database', 'kivo.db');
  const dataRoot = path.dirname(path.dirname(dbPath));
  const dir = path.join(dataRoot, 'storage', 'company-logo');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Teto mais baixo que o das fotos de produto (6MB). Uma logo é exibida com ~40px de altura
 * no cabeçalho: acima disso é só peso para carregar em toda página, e o alvo típico é um
 * PNG exportado do Canva, que cabe folgado.
 */
const MAX_BYTES = 2 * 1024 * 1024;

export type SaveResult = { ok: true; url: string } | { ok: false; error: string };

export function saveCompanyLogo(base64: string): SaveResult {
  let buf: Buffer;
  try {
    // Aceita tanto base64 puro quanto data URI — o `FileReader` do navegador devolve a
    // segunda forma, e exigir que a tela recorte o prefixo é convite a erro.
    buf = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
  } catch {
    return { ok: false, error: 'Imagem inválida.' };
  }
  if (buf.length > MAX_BYTES) return { ok: false, error: 'Logo muito grande (máximo 2MB).' };
  const check = validateImageBuffer(buf);
  if (!check.ok) return { ok: false, error: check.error };

  const filename = `${randomUUID()}.${EXT_BY_FORMAT[check.format]}`;
  fs.writeFileSync(path.join(companyLogoDir(), filename), buf);
  return { ok: true, url: `${LOGO_URL_PREFIX}${filename}` };
}

/**
 * Apaga o arquivo da logo anterior. Só age em URL que ESTE módulo gerou — se algum dia a
 * setting apontar para um endereço externo, não é nosso para remover.
 */
export function deleteCompanyLogoFile(url: string | null | undefined): void {
  if (!url || !url.startsWith(LOGO_URL_PREFIX)) return;
  try {
    fs.unlinkSync(path.join(companyLogoDir(), path.basename(url)));
  } catch {
    // já não existe: trocar a logo não pode falhar por causa da limpeza da antiga
  }
}
