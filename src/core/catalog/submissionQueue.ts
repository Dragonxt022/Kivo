import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getSqlite } from '../database/connection';
import { getLicenseCredentials, machineId } from '../license/service';
import { getCloudServerUrl } from '../config/cloud';
import type { ImageFormat } from './imageValidation';

/**
 * Banco de imagens do Katsu Cloud (ecossistema descrito em conversa com o usuário):
 * quando um produto ganha uma foto, ela é salva localmente (funciona 100% offline) e,
 * best-effort, entra numa fila para ser enviada ao cloud/ e passar por curadoria manual
 * do admin. Aprovada, vira sugestão de busca para outras empresas cadastrarem produtos
 * parecidos sem precisar subir foto própria. Ver cloud/src/routes/catalog.ts.
 */

const EXT_BY_FORMAT: Record<ImageFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' };
const MIME_BY_FORMAT: Record<ImageFormat, string> = {
  jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
};

export function productImagesDir(): string {
  const dir = path.resolve(process.cwd(), 'storage', 'product-images');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Salva a imagem no disco local e devolve a URL servida por `/uploads/products/...` (ver server.ts). */
export function saveLocalProductImage(buf: Buffer, format: ImageFormat): string {
  const filename = `${randomUUID()}.${EXT_BY_FORMAT[format]}`;
  fs.writeFileSync(path.join(productImagesDir(), filename), buf);
  return `/uploads/products/${filename}`;
}

/** Enfileira a imagem para envio ao banco de imagens do Cloud (não bloqueia o salvamento do produto). */
export function queueProductImageSubmission(
  productId: number,
  productName: string,
  localPath: string,
  buf: Buffer,
): void {
  const absPath = path.join(productImagesDir(), path.basename(localPath));
  getSqlite()
    .prepare(
      `INSERT INTO product_image_submissions (product_id, local_path, sha256, product_name, status)
       VALUES (?, ?, ?, ?, 'pendente_envio')`,
    )
    .run(productId, absPath, sha256(buf), productName);
}

export function cloudBaseUrl(): string | null {
  const url = getCloudServerUrl();
  return url ? url.replace(/\/$/, '') : null;
}

export function cloudAuthHeaders(): Record<string, string> | null {
  const { companyUuid, licenseKey } = getLicenseCredentials();
  if (!companyUuid || !licenseKey) return null;
  return { 'X-Katsu-Company': companyUuid, 'X-Katsu-License-Key': licenseKey };
}

interface PendingRow {
  id: number;
  local_path: string;
  sha256: string;
  product_name: string;
}

/**
 * Tenta enviar as imagens pendentes ao Cloud — best-effort, chamado depois de um sync
 * manual e no boot do app (ver sync/routes.ts e dev.ts). Sem internet/licença configurada,
 * simplesmente não faz nada (a fila fica intacta para a próxima tentativa).
 */
export async function trySubmitPending(): Promise<void> {
  const base = cloudBaseUrl();
  const auth = cloudAuthHeaders();
  if (!base || !auth) return;

  const db = getSqlite();
  const pending = db
    .prepare(`SELECT id, local_path, sha256, product_name FROM product_image_submissions WHERE status = 'pendente_envio' LIMIT 20`)
    .all() as PendingRow[];

  for (const row of pending) {
    if (!fs.existsSync(row.local_path)) {
      db.prepare(`UPDATE product_image_submissions SET status = 'erro', error_message = 'Arquivo local não existe mais.', updated_at = datetime('now') WHERE id = ?`)
        .run(row.id);
      continue;
    }
    const buf = fs.readFileSync(row.local_path);
    const ext = path.extname(row.local_path).slice(1).toLowerCase();
    const format = (ext === 'jpg' ? 'jpeg' : ext) as ImageFormat;
    const contentType = MIME_BY_FORMAT[format] ?? 'application/octet-stream';

    try {
      const res = await fetch(`${base}/api/catalog/submit`, {
        method: 'POST',
        headers: {
          ...auth,
          'Content-Type': contentType,
          'X-Katsu-Product-Name': row.product_name,
          'X-Katsu-Submission-Uuid': randomUUID(),
          'X-Katsu-Machine-Id': machineId(),
        },
        body: buf,
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const body = (await res.json()) as { catalogImageId?: number };
        db.prepare(
          `UPDATE product_image_submissions SET status = 'enviado', remote_catalog_image_id = ?, updated_at = datetime('now') WHERE id = ?`,
        ).run(body.catalogImageId != null ? String(body.catalogImageId) : null, row.id);
      } else if (res.status === 409) {
        // Já avaliada e rejeitada antes (mesma imagem, hash igual) — não adianta tentar de novo.
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        db.prepare(`UPDATE product_image_submissions SET status = 'erro', error_message = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(body.error ?? 'Imagem rejeitada pela curadoria.', row.id);
      } else if (res.status === 400) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        db.prepare(`UPDATE product_image_submissions SET status = 'erro', error_message = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(body.error ?? 'Imagem recusada pela validação do servidor.', row.id);
      }
      // Outros status (5xx, plano sem acesso etc.): deixa pendente para tentar de novo depois.
    } catch {
      // Sem rede — deixa pendente, tenta na próxima chamada.
    }
  }
}
