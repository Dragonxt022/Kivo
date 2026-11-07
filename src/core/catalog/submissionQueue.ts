import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getSqlite } from '../database/connection';
import { getLicenseCredentials, machineId } from '../license/service';
import { getCloudServerUrl } from '../config/cloud';
import type { ImageFormat } from './imageValidation';

/**
 * Banco de imagens do Kivo Cloud (ecossistema descrito em conversa com o usuário):
 * quando um produto ganha uma foto, ela é salva localmente (funciona 100% offline) e,
 * best-effort, entra numa fila para ser enviada ao cloud/ e passar por curadoria manual
 * do admin. Aprovada, vira sugestão de busca para outras empresas cadastrarem produtos
 * parecidos sem precisar subir foto própria. Ver cloud/src/routes/catalog.ts.
 */

const EXT_BY_FORMAT: Record<ImageFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif' };
const MIME_BY_FORMAT: Record<ImageFormat, string> = {
  jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif',
};

/**
 * Relativo à mesma raiz de dados do banco (`KIVO_DB_PATH`), não a `process.cwd()`:
 * em produção o cwd de um app Electron empacotado não é confiável (varia conforme
 * de onde o processo foi lançado) — sem isso, as fotos ficavam fora de
 * `userData`/, então "remover todos os dados" na desinstalação não as alcançava.
 * Mesmo padrão já usado por `fallbackMachineIdPath()` em `core/license/service.ts`.
 */
export function productImagesDir(): string {
  const dbPath = process.env.KIVO_DB_PATH ?? path.resolve(process.cwd(), 'database', 'kivo.db');
  const dataRoot = path.dirname(path.dirname(dbPath));
  const dir = path.join(dataRoot, 'storage', 'product-images');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function categoryImagesDir(): string {
  const dbPath = process.env.KIVO_DB_PATH ?? path.resolve(process.cwd(), 'database', 'kivo.db');
  const dataRoot = path.dirname(path.dirname(dbPath));
  const dir = path.join(dataRoot, 'storage', 'category-images');
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

export function saveLocalCategoryImage(buf: Buffer, format: ImageFormat): string {
  const filename = `${randomUUID()}.${EXT_BY_FORMAT[format]}`;
  fs.writeFileSync(path.join(categoryImagesDir(), filename), buf);
  return `/uploads/categories/${filename}`;
}

/** Enfileira a imagem para envio ao banco de imagens do Cloud (não bloqueia o salvamento do produto). */
export function queueProductImageSubmission(
  productId: number,
  productName: string,
  localPath: string,
  buf: Buffer,
  barcode?: string | null,
): void {
  const absPath = path.join(productImagesDir(), path.basename(localPath));
  const db = getSqlite();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO product_image_submissions (product_id, local_path, sha256, product_name, barcode, status)
       VALUES (?, ?, ?, ?, ?, 'pendente_envio')`,
    ).run(productId, absPath, sha256(buf), productName, barcode ? String(barcode).slice(0, 64) : null);
    // A foto mudou: o id antigo do catálogo não vale mais até o novo envio concluir. O
    // updated_at novo também faz o sync reenviar o produto, para o cardápio parar de
    // mostrar a foto anterior em vez de exibir uma imagem errada.
    db.prepare(
      "UPDATE products SET catalog_image_id = NULL, updated_at = datetime('now') WHERE id = ?",
    ).run(productId);
  })();
}

/** URL local servida por `/uploads/products/...` a partir do caminho absoluto da fila. */
function localImageUrl(absPath: string): string {
  return `/uploads/products/${path.basename(absPath)}`;
}

export function cloudBaseUrl(): string | null {
  const url = getCloudServerUrl();
  return url ? url.replace(/\/$/, '') : null;
}

export function cloudAuthHeaders(): Record<string, string> | null {
  const { companyUuid, licenseKey } = getLicenseCredentials();
  if (!companyUuid || !licenseKey) return null;
  return { 'X-Kivo-Company': companyUuid, 'X-Kivo-License-Key': licenseKey };
}

interface PendingRow {
  id: number;
  product_id: number;
  local_path: string;
  sha256: string;
  product_name: string;
  barcode: string | null;
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
    .prepare(`SELECT id, product_id, local_path, sha256, product_name, barcode FROM product_image_submissions WHERE status = 'pendente_envio' LIMIT 20`)
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
          'X-Kivo-Product-Name': row.product_name,
          'X-Kivo-Submission-Uuid': randomUUID(),
          'X-Kivo-Machine-Id': machineId(),
          ...(row.barcode ? { 'X-Kivo-Product-Barcode': row.barcode } : {}),
        },
        body: buf,
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const body = (await res.json()) as { catalogImageId?: number };
        const remoteId = body.catalogImageId != null ? String(body.catalogImageId) : null;
        db.prepare(
          `UPDATE product_image_submissions SET status = 'enviado', remote_catalog_image_id = ?, updated_at = datetime('now') WHERE id = ?`,
        ).run(remoteId, row.id);
        // Vincula a foto ao produto. Só quando o produto ainda aponta para ESTE arquivo —
        // se o lojista trocou a foto no meio do envio, o id antigo não pode sobrescrever o
        // da foto nova. O updated_at novo faz o sync mandar o id ao Cloud.
        const numericId = Number(body.catalogImageId);
        if (Number.isInteger(numericId) && numericId > 0) {
          db.prepare(
            `UPDATE products SET catalog_image_id = ?, updated_at = datetime('now')
              WHERE id = ? AND image_url = ?`,
          ).run(numericId, row.product_id, localImageUrl(row.local_path));
        }
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

interface BackfillRow {
  id: number;
  name: string;
  barcode: string | null;
  image_url: string;
}

/** URL antiga do proxy local `.../products/catalog-image/<id>` — o id já está na URL. */
const LEGACY_CATALOG_URL_RE = /\/catalog-image\/(\d+)(?:[?#]|$)/;

/**
 * Garante que TODO produto publicado no cardápio e com foto local tenha um envio ao banco
 * de imagens do Cloud. Sem isto a página pública só conseguia achar a miniatura pelo NOME
 * do produto, e fotos vindas das sugestões automáticas (ou de catálogos antigos) nunca
 * chegavam ao Cloud — o cardápio ficava sem as fotinhas.
 *
 * Idempotente: só pega produto visível/ativo, sem `catalog_image_id` e que ainda não tenha
 * linha na fila para a mesma foto. O envio de fato fica para `trySubmitPending` (best-effort,
 * respeita rede/credenciais). Retorna quantos foram enfileirados/vinculados agora.
 */
export function backfillMenuImageSubmissions(limit = 50): number {
  const db = getSqlite();
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.barcode, p.image_url
         FROM products p
        WHERE p.deleted_at IS NULL AND p.active = 1 AND p.visivel_cardapio = 1
          AND p.catalog_image_id IS NULL
          AND p.image_url IS NOT NULL AND p.image_url != ''
        ORDER BY p.updated_at DESC, p.id DESC
        LIMIT ?`,
    )
    .all(limit) as BackfillRow[];

  let linked = 0;
  for (const row of rows) {
    const legacy = LEGACY_CATALOG_URL_RE.exec(row.image_url);
    if (legacy) {
      db.prepare("UPDATE products SET catalog_image_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(Number(legacy[1]), row.id);
      linked++;
      continue;
    }
    if (!row.image_url.startsWith('/uploads/products/')) continue;

    const absPath = path.join(productImagesDir(), path.basename(row.image_url));
    if (!fs.existsSync(absPath)) continue;
    // Já existe envio (mesmo pendente/erro) desta foto para este produto: não duplica.
    const existing = db
      .prepare('SELECT 1 FROM product_image_submissions WHERE product_id = ? AND local_path = ? LIMIT 1')
      .get(row.id, absPath);
    if (existing) continue;

    try {
      queueProductImageSubmission(row.id, row.name, row.image_url, fs.readFileSync(absPath), row.barcode);
      linked++;
    } catch {
      // arquivo ilegível: fica sem miniatura até o lojista reenviar a foto
    }
  }
  return linked;
}
